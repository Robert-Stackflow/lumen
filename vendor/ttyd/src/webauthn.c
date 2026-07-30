#include "auth.h"

#include <fido.h>
#include <json-c/json.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define PASSKEY_DATA_MAX 4096
#define PASSKEY_HEX_MAX 2048

static void hex_encode_local(const unsigned char *source, size_t length, char *target) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t i = 0; i < length; i++) {
    target[i * 2] = alphabet[source[i] >> 4];
    target[i * 2 + 1] = alphabet[source[i] & 15];
  }
  target[length * 2] = '\0';
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static bool hex_decode_local(const char *source, unsigned char *target, size_t size, size_t *length) {
  size_t chars = strlen(source);
  if (chars % 2 || chars / 2 > size) return false;
  for (size_t i = 0; i < chars / 2; i++) {
    int high = hex_nibble(source[i * 2]), low = hex_nibble(source[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    target[i] = (unsigned char)((high << 4) | low);
  }
  *length = chars / 2;
  return true;
}

static char *base64url_encode(const unsigned char *source, size_t length) {
  size_t size = 4 * ((length + 2) / 3) + 1;
  char *output = calloc(1, size);
  if (!output || EVP_EncodeBlock((unsigned char *)output, source, (int)length) < 0) {
    free(output);
    return NULL;
  }
  for (char *p = output; *p; p++) {
    if (*p == '+') *p = '-';
    else if (*p == '/') *p = '_';
  }
  char *padding = strchr(output, '=');
  if (padding) *padding = '\0';
  return output;
}

static bool base64url_decode(const char *source, unsigned char *target, size_t size, size_t *length) {
  size_t input_len = strlen(source);
  if (!input_len || input_len > PASSKEY_DATA_MAX * 2) return false;
  size_t padded = (input_len + 3) & ~3U;
  char *copy = calloc(1, padded + 1);
  if (!copy) return false;
  memcpy(copy, source, input_len);
  for (size_t i = 0; i < input_len; i++) {
    if (copy[i] == '-') copy[i] = '+';
    else if (copy[i] == '_') copy[i] = '/';
  }
  for (size_t i = input_len; i < padded; i++) copy[i] = '=';
  if (3 * padded / 4 > size) {
    free(copy);
    return false;
  }
  int decoded = EVP_DecodeBlock(target, (unsigned char *)copy, (int)padded);
  free(copy);
  if (decoded < 0) return false;
  while (padded > input_len) {
    decoded--;
    padded--;
  }
  *length = (size_t)decoded;
  return true;
}

static struct lumen_webauthn_challenge *challenge_entry(struct lumen_auth *auth, const char *client,
                                                        bool registration) {
  int64_t now = (int64_t)time(NULL);
  struct lumen_webauthn_challenge *oldest = &auth->challenges[0];
  for (size_t i = 0; i < sizeof(auth->challenges) / sizeof(auth->challenges[0]); i++) {
    struct lumen_webauthn_challenge *entry = &auth->challenges[i];
    if (entry->client[0] && !strcmp(entry->client, client) && entry->registration == registration) return entry;
    if (!entry->client[0] || entry->expires <= now) return entry;
    if (entry->expires < oldest->expires) oldest = entry;
  }
  return oldest;
}

static bool passkey_record(FILE *file, char *id_hex, size_t id_size, char *key_hex, size_t key_size, int *algorithm,
                           int64_t *created_at) {
  char line[4096];
  while (fgets(line, sizeof(line), file)) {
    long long created = 0;
    int fields = sscanf(line, "%1023s %2047s %d %lld", id_hex, key_hex, algorithm, &created);
    if (fields < 3 || strlen(id_hex) >= id_size || strlen(key_hex) >= key_size) continue;
    *created_at = fields >= 4 ? (int64_t)created : 0;
    return true;
  }
  return false;
}

bool lumen_auth_has_passkeys(struct lumen_auth *auth) {
  if (!auth || !auth->passkey_store[0]) return false;
  FILE *file = fopen(auth->passkey_store, "r");
  if (!file) return false;
  char id[1024], key[2048];
  int algorithm = 0;
  int64_t created_at = 0;
  bool found = passkey_record(file, id, sizeof(id), key, sizeof(key), &algorithm, &created_at);
  fclose(file);
  return found;
}

char *lumen_auth_passkey_options(struct lumen_auth *auth, const char *client, bool registration) {
  if (!auth || !auth->passkey_store[0]) return NULL;
  struct lumen_webauthn_challenge *entry = challenge_entry(auth, client, registration);
  memset(entry, 0, sizeof(*entry));
  snprintf(entry->client, sizeof(entry->client), "%s", client);
  entry->registration = registration;
  entry->expires = (int64_t)time(NULL) + 300;
  if (RAND_bytes(entry->value, sizeof(entry->value)) != 1) return NULL;
  char *challenge = base64url_encode(entry->value, sizeof(entry->value));
  if (!challenge) return NULL;

  json_object *root = json_object_new_object();
  json_object_object_add(root, "challenge", json_object_new_string(challenge));
  json_object_object_add(root, "rpId", json_object_new_string(auth->allowed_host));
  json_object_object_add(root, "timeout", json_object_new_int(60000));
  json_object_object_add(root, "userVerification", json_object_new_string("required"));
  if (registration) {
    unsigned char user_id[32];
    SHA256((unsigned char *)auth->username, strlen(auth->username), user_id);
    char *encoded_user = base64url_encode(user_id, sizeof(user_id));
    json_object *user = json_object_new_object();
    json_object_object_add(user, "id", json_object_new_string(encoded_user));
    json_object_object_add(user, "name", json_object_new_string(auth->username));
    json_object_object_add(user, "displayName", json_object_new_string(auth->username));
    json_object_object_add(root, "user", user);
    json_object *rp = json_object_new_object();
    json_object_object_add(rp, "id", json_object_new_string(auth->allowed_host));
    json_object_object_add(rp, "name", json_object_new_string("Lumen"));
    json_object_object_add(root, "rp", rp);
    json_object *parameters = json_object_new_array();
    json_object *es256 = json_object_new_object();
    json_object_object_add(es256, "type", json_object_new_string("public-key"));
    json_object_object_add(es256, "alg", json_object_new_int(COSE_ES256));
    json_object_array_add(parameters, es256);
    json_object_object_add(root, "pubKeyCredParams", parameters);
    json_object_object_add(root, "attestation", json_object_new_string("none"));
    free(encoded_user);
  } else {
    json_object *allowed = json_object_new_array();
    FILE *file = fopen(auth->passkey_store, "r");
    if (file) {
      char id_hex[1024], key_hex[2048];
      int algorithm;
      int64_t created_at = 0;
      while (passkey_record(file, id_hex, sizeof(id_hex), key_hex, sizeof(key_hex), &algorithm, &created_at)) {
        unsigned char id[512];
        size_t id_len = 0;
        if (!hex_decode_local(id_hex, id, sizeof(id), &id_len)) continue;
        char *encoded = base64url_encode(id, id_len);
        json_object *credential = json_object_new_object();
        json_object_object_add(credential, "type", json_object_new_string("public-key"));
        json_object_object_add(credential, "id", json_object_new_string(encoded));
        json_object_array_add(allowed, credential);
        free(encoded);
      }
      fclose(file);
    }
    json_object_object_add(root, "allowCredentials", allowed);
  }
  const char *serialized = json_object_to_json_string_ext(root, JSON_C_TO_STRING_PLAIN);
  char *result = strdup(serialized);
  json_object_put(root);
  free(challenge);
  return result;
}

static bool json_binary(json_object *root, const char *name, unsigned char *target, size_t size, size_t *length) {
  json_object *value = NULL;
  return json_object_object_get_ex(root, name, &value) && json_object_is_type(value, json_type_string) &&
         base64url_decode(json_object_get_string(value), target, size, length);
}

static bool validate_client_data(struct lumen_auth *auth, struct lumen_webauthn_challenge *entry,
                                 const unsigned char *data, size_t length, const char *expected_type,
                                 unsigned char hash[32]) {
  struct json_tokener *tokener = json_tokener_new();
  if (!tokener) return false;
  json_object *root = json_tokener_parse_ex(tokener, (const char *)data, (int)length);
  bool parsed = json_tokener_get_error(tokener) == json_tokener_success;
  json_tokener_free(tokener);
  if (!root || !parsed) {
    if (root) json_object_put(root);
    return false;
  }
  json_object *type = NULL, *challenge = NULL, *origin = NULL;
  char expected_origin[320];
  snprintf(expected_origin, sizeof(expected_origin), "https://%s", auth->allowed_host);
  char *encoded = base64url_encode(entry->value, sizeof(entry->value));
  bool valid = json_object_object_get_ex(root, "type", &type) &&
               json_object_object_get_ex(root, "challenge", &challenge) &&
               json_object_object_get_ex(root, "origin", &origin) &&
               !strcmp(json_object_get_string(type), expected_type) &&
               !strcmp(json_object_get_string(challenge), encoded) &&
               !strcmp(json_object_get_string(origin), expected_origin);
  free(encoded);
  json_object_put(root);
  if (!valid) return false;
  SHA256(data, length, hash);
  return true;
}

static bool cbor_authdata(const unsigned char *object, size_t length, const unsigned char **data, size_t *data_len) {
  static const unsigned char key[] = {0x68, 'a','u','t','h','D','a','t','a'};
  for (size_t i = 0; i + sizeof(key) + 2 < length; i++) {
    if (memcmp(object + i, key, sizeof(key))) continue;
    size_t cursor = i + sizeof(key);
    unsigned char marker = object[cursor++];
    uint64_t bytes = 0;
    if ((marker & 0xe0) != 0x40) return false;
    unsigned char info = marker & 0x1f;
    if (info < 24) bytes = info;
    else if (info == 24 && cursor < length) bytes = object[cursor++];
    else if (info == 25 && cursor + 2 <= length) {
      bytes = ((uint64_t)object[cursor] << 8) | object[cursor + 1];
      cursor += 2;
    } else return false;
    if (bytes > length - cursor) return false;
    *data = object + cursor;
    *data_len = (size_t)bytes;
    return true;
  }
  return false;
}

static bool authenticator_data_valid(struct lumen_auth *auth, const unsigned char *data, size_t length,
                                     bool registration) {
  if (length < 37) return false;
  unsigned char rp_hash[32];
  SHA256((const unsigned char *)auth->allowed_host, strlen(auth->allowed_host), rp_hash);
  unsigned char required = registration ? 0x45 : 0x05; /* UP, UV, and AT for registration. */
  return CRYPTO_memcmp(data, rp_hash, sizeof(rp_hash)) == 0 && (data[32] & required) == required;
}

bool lumen_auth_passkey_register(struct lumen_auth *auth, const char *client, const char *json) {
  struct lumen_webauthn_challenge *entry = challenge_entry(auth, client, true);
  if (!entry->client[0] || entry->expires < (int64_t)time(NULL)) return false;
  json_object *root = json_tokener_parse(json);
  if (!root) return false;
  unsigned char client_data[PASSKEY_DATA_MAX], attestation[PASSKEY_DATA_MAX];
  size_t client_len = 0, attestation_len = 0;
  bool decoded = json_binary(root, "clientDataJSON", client_data, sizeof(client_data), &client_len) &&
                 json_binary(root, "attestationObject", attestation, sizeof(attestation), &attestation_len);
  json_object_put(root);
  unsigned char client_hash[32];
  if (!decoded || !validate_client_data(auth, entry, client_data, client_len, "webauthn.create", client_hash))
    return false;
  const unsigned char *authdata = NULL;
  size_t authdata_len = 0;
  if (!cbor_authdata(attestation, attestation_len, &authdata, &authdata_len) ||
      !authenticator_data_valid(auth, authdata, authdata_len, true))
    return false;
  fido_cred_t *credential = fido_cred_new();
  if (!credential || fido_cred_set_type(credential, COSE_ES256) != FIDO_OK ||
      fido_cred_set_rp(credential, auth->allowed_host, "Lumen") != FIDO_OK ||
      fido_cred_set_clientdata_hash(credential, client_hash, sizeof(client_hash)) != FIDO_OK ||
      fido_cred_set_authdata_raw(credential, authdata, authdata_len) != FIDO_OK ||
      fido_cred_set_uv(credential, FIDO_OPT_TRUE) != FIDO_OK) {
    fido_cred_free(&credential);
    return false;
  }
  const unsigned char *id = fido_cred_id_ptr(credential), *key = fido_cred_pubkey_ptr(credential);
  size_t id_len = fido_cred_id_len(credential), key_len = fido_cred_pubkey_len(credential);
  if (!id || !key || !id_len || id_len > 512 || !key_len || key_len > 1024) {
    fido_cred_free(&credential);
    return false;
  }
  char id_hex[1025], key_hex[2049];
  hex_encode_local(id, id_len, id_hex);
  hex_encode_local(key, key_len, key_hex);
  FILE *file = fopen(auth->passkey_store, "a");
  if (!file) {
    fido_cred_free(&credential);
    return false;
  }
  chmod(auth->passkey_store, 0600);
  static const char default_name[] = "通行密钥";
  char *encoded_name = base64url_encode((const unsigned char *)default_name, strlen(default_name));
  fprintf(file, "%s %s %d %lld %s\n", id_hex, key_hex, COSE_ES256, (long long)time(NULL),
          encoded_name ? encoded_name : "");
  free(encoded_name);
  bool saved = fclose(file) == 0;
  memset(entry, 0, sizeof(*entry));
  fido_cred_free(&credential);
  if (saved) lumen_auth_audit(auth, "passkey_registered", client, "webauthn");
  return saved;
}

bool lumen_auth_passkey_login(struct lumen_auth *auth, const char *client, const char *json) {
  struct lumen_webauthn_challenge *entry = challenge_entry(auth, client, false);
  if (!entry->client[0] || entry->expires < (int64_t)time(NULL)) return false;
  json_object *root = json_tokener_parse(json);
  if (!root) return false;
  unsigned char id[512], client_data[PASSKEY_DATA_MAX], authdata[PASSKEY_DATA_MAX], signature[PASSKEY_DATA_MAX];
  size_t id_len = 0, client_len = 0, authdata_len = 0, signature_len = 0;
  bool decoded = json_binary(root, "id", id, sizeof(id), &id_len) &&
                 json_binary(root, "clientDataJSON", client_data, sizeof(client_data), &client_len) &&
                 json_binary(root, "authenticatorData", authdata, sizeof(authdata), &authdata_len) &&
                 json_binary(root, "signature", signature, sizeof(signature), &signature_len);
  json_object_put(root);
  unsigned char client_hash[32];
  if (!decoded || !validate_client_data(auth, entry, client_data, client_len, "webauthn.get", client_hash))
    return false;
  if (!authenticator_data_valid(auth, authdata, authdata_len, false)) return false;
  char wanted[1025];
  hex_encode_local(id, id_len, wanted);
  FILE *file = fopen(auth->passkey_store, "r");
  if (!file) return false;
  char id_hex[1024], key_hex[2048];
  int algorithm = 0;
  int64_t created_at = 0;
  bool verified = false;
  while (passkey_record(file, id_hex, sizeof(id_hex), key_hex, sizeof(key_hex), &algorithm, &created_at)) {
    if (strcmp(id_hex, wanted)) continue;
    unsigned char key[1024];
    size_t key_len = 0;
    if (!hex_decode_local(key_hex, key, sizeof(key), &key_len)) break;
    fido_assert_t *assertion = fido_assert_new();
    if (assertion && fido_assert_set_count(assertion, 1) == FIDO_OK &&
        fido_assert_set_rp(assertion, auth->allowed_host) == FIDO_OK &&
        fido_assert_set_clientdata_hash(assertion, client_hash, sizeof(client_hash)) == FIDO_OK &&
        fido_assert_set_authdata_raw(assertion, 0, authdata, authdata_len) == FIDO_OK &&
        fido_assert_set_sig(assertion, 0, signature, signature_len) == FIDO_OK &&
        fido_assert_set_up(assertion, FIDO_OPT_TRUE) == FIDO_OK &&
        fido_assert_set_uv(assertion, FIDO_OPT_TRUE) == FIDO_OK &&
        fido_assert_verify(assertion, 0, algorithm, key) == FIDO_OK)
      verified = true;
    fido_assert_free(&assertion);
    break;
  }
  fclose(file);
  memset(entry, 0, sizeof(*entry));
  lumen_auth_audit(auth, verified ? "passkey_login_success" : "passkey_login_failed", client, "webauthn");
  return verified;
}

char *lumen_auth_passkey_list(struct lumen_auth *auth) {
  json_object *items = json_object_new_array();
  if (!items) return NULL;
  FILE *file = auth && auth->passkey_store[0] ? fopen(auth->passkey_store, "r") : NULL;
  if (file) {
    char line[4096], id_hex[1024], key_hex[2048], encoded_name[256];
    size_t index = 0;
    while (fgets(line, sizeof(line), file)) {
      int algorithm = 0;
      long long created_at = 0;
      encoded_name[0] = '\0';
      int fields = sscanf(line, "%1023s %2047s %d %lld %255s", id_hex, key_hex, &algorithm, &created_at,
                          encoded_name);
      if (fields < 3) continue;
      unsigned char id[512];
      size_t id_len = 0;
      if (!hex_decode_local(id_hex, id, sizeof(id), &id_len)) continue;
      char *encoded = base64url_encode(id, id_len);
      if (!encoded) continue;
      json_object *item = json_object_new_object();
      char name[64];
      snprintf(name, sizeof(name), "通行密钥 %zu", ++index);
      if (fields >= 5) {
        unsigned char decoded_name[64];
        size_t name_len = 0;
        if (base64url_decode(encoded_name, decoded_name, sizeof(decoded_name) - 1, &name_len) && name_len) {
          decoded_name[name_len] = '\0';
          snprintf(name, sizeof(name), "%s", (char *)decoded_name);
        }
      }
      json_object_object_add(item, "id", json_object_new_string(encoded));
      json_object_object_add(item, "name", json_object_new_string(name));
      json_object_object_add(item, "createdAt", json_object_new_int64((int64_t)created_at));
      json_object_array_add(items, item);
      free(encoded);
    }
    fclose(file);
  }
  const char *serialized = json_object_to_json_string_ext(items, JSON_C_TO_STRING_PLAIN);
  char *result = strdup(serialized);
  json_object_put(items);
  return result;
}

bool lumen_auth_passkey_delete(struct lumen_auth *auth, const char *client, const char *encoded_id) {
  if (!auth || !auth->passkey_store[0]) return false;
  unsigned char id[512];
  size_t id_len = 0;
  if (!base64url_decode(encoded_id, id, sizeof(id), &id_len)) return false;
  char wanted[1025];
  hex_encode_local(id, id_len, wanted);

  FILE *source = fopen(auth->passkey_store, "r");
  if (!source) return false;
  char temporary[sizeof(auth->passkey_store) + 32];
  snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", auth->passkey_store, (long)getpid());
  FILE *target = fopen(temporary, "w");
  if (!target) {
    fclose(source);
    return false;
  }
  chmod(temporary, 0600);
  char line[4096];
  bool removed = false, write_ok = true;
  while (fgets(line, sizeof(line), source)) {
    char record_id[1024] = "";
    if (sscanf(line, "%1023s", record_id) == 1 && !strcmp(record_id, wanted)) {
      removed = true;
      continue;
    }
    if (fputs(line, target) == EOF) write_ok = false;
  }
  if (ferror(source)) write_ok = false;
  fclose(source);
  if (fclose(target) != 0) write_ok = false;
  if (!removed || !write_ok || rename(temporary, auth->passkey_store) != 0) {
    unlink(temporary);
    return false;
  }
  lumen_auth_audit(auth, "passkey_deleted", client, "webauthn");
  return true;
}

bool lumen_auth_passkey_rename(struct lumen_auth *auth, const char *client, const char *encoded_id,
                               const char *name) {
  if (!auth || !auth->passkey_store[0] || !name) return false;
  size_t name_len = strlen(name);
  if (!name_len || name_len > 63) return false;
  for (size_t i = 0; i < name_len; i++)
    if ((unsigned char)name[i] < 0x20 || (unsigned char)name[i] == 0x7f) return false;
  unsigned char id[512];
  size_t id_len = 0;
  if (!base64url_decode(encoded_id, id, sizeof(id), &id_len)) return false;
  char wanted[1025];
  hex_encode_local(id, id_len, wanted);
  char *encoded_name = base64url_encode((const unsigned char *)name, name_len);
  if (!encoded_name) return false;

  FILE *source = fopen(auth->passkey_store, "r");
  if (!source) {
    free(encoded_name);
    return false;
  }
  char temporary[sizeof(auth->passkey_store) + 32];
  snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", auth->passkey_store, (long)getpid());
  FILE *target = fopen(temporary, "w");
  if (!target) {
    fclose(source);
    free(encoded_name);
    return false;
  }
  chmod(temporary, 0600);
  char line[4096];
  bool renamed = false, write_ok = true;
  while (fgets(line, sizeof(line), source)) {
    char record_id[1024], key_hex[2048];
    int algorithm = 0;
    long long created_at = 0;
    if (sscanf(line, "%1023s %2047s %d %lld", record_id, key_hex, &algorithm, &created_at) >= 3 &&
        !strcmp(record_id, wanted)) {
      if (fprintf(target, "%s %s %d %lld %s\n", record_id, key_hex, algorithm, created_at, encoded_name) < 0)
        write_ok = false;
      renamed = true;
    } else if (fputs(line, target) == EOF) {
      write_ok = false;
    }
  }
  if (ferror(source)) write_ok = false;
  fclose(source);
  if (fclose(target) != 0) write_ok = false;
  free(encoded_name);
  if (!renamed || !write_ok || rename(temporary, auth->passkey_store) != 0) {
    unlink(temporary);
    return false;
  }
  lumen_auth_audit(auth, "passkey_renamed", client, "webauthn");
  return true;
}
