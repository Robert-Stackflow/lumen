#include "auth.h"

#include <ctype.h>
#include <errno.h>
#include <json-c/json.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <time.h>

#define SESSION_NONCE_LEN 32
#define TOKEN_MAX_LEN 256

static char *trim(char *value) {
  while (isspace((unsigned char)*value)) value++;
  char *end = value + strlen(value);
  while (end > value && isspace((unsigned char)end[-1])) *--end = '\0';
  return value;
}

static bool parse_bool(const char *value, bool *result) {
  if (!strcasecmp(value, "true") || !strcmp(value, "1") || !strcasecmp(value, "yes")) {
    *result = true;
    return true;
  }
  if (!strcasecmp(value, "false") || !strcmp(value, "0") || !strcasecmp(value, "no")) {
    *result = false;
    return true;
  }
  return false;
}

static bool parse_i64(const char *value, int64_t minimum, int64_t maximum, int64_t *result) {
  char *end = NULL;
  errno = 0;
  long long parsed = strtoll(value, &end, 10);
  if (errno || end == value || *end != '\0' || parsed < minimum || parsed > maximum) return false;
  *result = parsed;
  return true;
}

static int hex_value(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static bool hex_decode(const char *source, unsigned char *target, size_t target_len) {
  if (strlen(source) != target_len * 2) return false;
  for (size_t i = 0; i < target_len; i++) {
    int high = hex_value(source[i * 2]);
    int low = hex_value(source[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    target[i] = (unsigned char)((high << 4) | low);
  }
  return true;
}

static bool base32_decode(const char *source, unsigned char *target, size_t target_size, size_t *target_len) {
  unsigned int bits = 0, accumulator = 0;
  size_t written = 0;
  for (const char *cursor = source; *cursor; cursor++) {
    unsigned char c = (unsigned char)toupper((unsigned char)*cursor);
    if (c == ' ' || c == '-') continue;
    if (c == '=') break;
    int value = c >= 'A' && c <= 'Z' ? c - 'A' : c >= '2' && c <= '7' ? c - '2' + 26 : -1;
    if (value < 0) return false;
    accumulator = (accumulator << 5) | (unsigned int)value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (written >= target_size) return false;
      target[written++] = (unsigned char)(accumulator >> bits);
      accumulator &= (1U << bits) - 1U;
    }
  }
  if (written < 10) return false;
  *target_len = written;
  return true;
}

static void hex_encode(const unsigned char *source, size_t source_len, char *target) {
  static const char alphabet[] = "0123456789abcdef";
  for (size_t i = 0; i < source_len; i++) {
    target[i * 2] = alphabet[source[i] >> 4];
    target[i * 2 + 1] = alphabet[source[i] & 15];
  }
  target[source_len * 2] = '\0';
}

static bool valid_username(const char *username) {
  size_t len = strlen(username);
  if (len == 0 || len > 64) return false;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)username[i];
    if (!isalnum(c) && c != '.' && c != '_' && c != '-') return false;
  }
  return true;
}

static bool valid_header_name(const char *header) {
  size_t len = strlen(header);
  if (len == 0 || len > 125) return false;
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)header[i];
    if (!isalnum(c) && c != '-') return false;
  }
  return true;
}

static bool prepare_custom_header(char *header, size_t header_len) {
  if (!valid_header_name(header) || strlen(header) + 2 > header_len) return false;
  for (char *p = header; *p; p++) *p = (char)tolower((unsigned char)*p);
  strcat(header, ":");
  return true;
}

static bool parse_password_hash(struct lumen_auth *auth, char *value) {
  char *save = NULL;
  char *algorithm = strtok_r(value, "$", &save);
  char *iterations = strtok_r(NULL, "$", &save);
  char *salt = strtok_r(NULL, "$", &save);
  char *hash = strtok_r(NULL, "$", &save);
  if (!algorithm || !iterations || !salt || !hash || strtok_r(NULL, "$", &save) ||
      strcmp(algorithm, "pbkdf2-sha256"))
    return false;

  int64_t rounds = 0;
  size_t salt_hex_len = strlen(salt);
  if (!parse_i64(iterations, 100000, 10000000, &rounds) || salt_hex_len < 32 || salt_hex_len > 64 ||
      salt_hex_len % 2 || !hex_decode(salt, auth->password_salt, salt_hex_len / 2) ||
      !hex_decode(hash, auth->password_hash, sizeof(auth->password_hash)))
    return false;

  auth->password_iterations = (int)rounds;
  auth->password_salt_len = salt_hex_len / 2;
  return true;
}

static bool validate_session_config(struct lumen_auth *auth, bool have_password, bool have_secret, char *error,
                                    size_t error_len) {
  if (auth->mode == LUMEN_AUTH_SESSION) {
    if (!valid_username(auth->username)) {
      snprintf(error, error_len, "session mode requires a username containing only letters, digits, . _ or -");
      return false;
    }
    if (!have_password) {
      snprintf(error, error_len, "session mode requires password_hash");
      return false;
    }
    if (!have_secret) {
      snprintf(error, error_len, "session mode requires a 32-byte session_secret");
      return false;
    }
    if (auth->cookie_secure && auth->allowed_host[0] == '\0') {
      snprintf(error, error_len, "secure session mode requires allowed_host");
      return false;
    }
  } else if (auth->mode == LUMEN_AUTH_PROXY && auth->proxy_header[0] == '\0') {
    snprintf(error, error_len, "proxy mode requires proxy_header");
    return false;
  }
  return true;
}

int lumen_auth_load(const char *path, struct lumen_auth **result, char *error, size_t error_len) {
  struct stat st;
  if (stat(path, &st) || !S_ISREG(st.st_mode)) {
    snprintf(error, error_len, "cannot read security config %s: %s", path, strerror(errno));
    return -1;
  }
  if (st.st_mode & (S_IWGRP | S_IWOTH)) {
    snprintf(error, error_len, "security config must not be group/world writable: %s", path);
    return -1;
  }

  FILE *file = fopen(path, "r");
  if (!file) {
    snprintf(error, error_len, "cannot open security config %s: %s", path, strerror(errno));
    return -1;
  }

  struct lumen_auth *auth = calloc(1, sizeof(*auth));
  if (!auth) {
    fclose(file);
    snprintf(error, error_len, "out of memory");
    return -1;
  }
  auth->mode = LUMEN_AUTH_SESSION;
  auth->session_generation = 1;
  auth->session_ttl = 12 * 60 * 60LL;
  auth->session_idle_timeout = 30 * 60;
  auth->cookie_secure = true;
  auth->login_max_failures = 5;
  auth->login_window = 300;
  auth->login_lockout = 300;
  auth->max_connections_per_ip = 4;
  auth->ws_max_attempts = 20;
  auth->ws_rate_window = 60;
  auth->audit_max_bytes = 2 * 1024 * 1024;
  auth->audit_retention_files = 5;

  bool have_password = false;
  bool have_secret = false;
  char line[1024];
  int line_number = 0;
  while (fgets(line, sizeof(line), file)) {
    line_number++;
    if (!strchr(line, '\n') && !feof(file)) {
      snprintf(error, error_len, "security config line %d is too long", line_number);
      goto fail;
    }
    char *entry = trim(line);
    if (*entry == '\0' || *entry == '#') continue;
    char *separator = strchr(entry, '=');
    if (!separator) {
      snprintf(error, error_len, "security config line %d has no '='", line_number);
      goto fail;
    }
    *separator = '\0';
    char *key = trim(entry);
    char *value = trim(separator + 1);

    if (!strcmp(key, "mode")) {
      if (!strcmp(value, "session"))
        auth->mode = LUMEN_AUTH_SESSION;
      else if (!strcmp(value, "proxy"))
        auth->mode = LUMEN_AUTH_PROXY;
      else if (!strcmp(value, "off"))
        auth->mode = LUMEN_AUTH_OFF;
      else {
        snprintf(error, error_len, "invalid mode on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "username")) {
      snprintf(auth->username, sizeof(auth->username), "%s", value);
    } else if (!strcmp(key, "password_hash")) {
      char password_value[512];
      snprintf(password_value, sizeof(password_value), "%s", value);
      if (!parse_password_hash(auth, password_value)) {
        snprintf(error, error_len, "invalid password_hash on line %d", line_number);
        goto fail;
      }
      have_password = true;
    } else if (!strcmp(key, "session_secret")) {
      if (!hex_decode(value, auth->session_secret, sizeof(auth->session_secret))) {
        snprintf(error, error_len, "invalid session_secret on line %d", line_number);
        goto fail;
      }
      have_secret = true;
    } else if (!strcmp(key, "session_generation")) {
      int64_t parsed = 0;
      if (!parse_i64(value, 1, UINT32_MAX, &parsed)) {
        snprintf(error, error_len, "invalid session_generation on line %d", line_number);
        goto fail;
      }
      auth->session_generation = (uint32_t)parsed;
    } else if (!strcmp(key, "session_ttl_days")) {
      int64_t days = 0;
      if (!parse_i64(value, 1, 3650, &days)) {
        snprintf(error, error_len, "invalid session_ttl_days on line %d", line_number);
        goto fail;
      }
      auth->session_ttl = days * 24 * 60 * 60;
    } else if (!strcmp(key, "session_ttl_seconds")) {
      if (!parse_i64(value, 300, 3650LL * 24 * 60 * 60, &auth->session_ttl)) {
        snprintf(error, error_len, "invalid session_ttl_seconds on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "session_idle_seconds")) {
      if (!parse_i64(value, 60, 30LL * 24 * 60 * 60, &auth->session_idle_timeout)) {
        snprintf(error, error_len, "invalid session_idle_seconds on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "session_store")) {
      if (*value != '/' || strlen(value) >= sizeof(auth->session_store)) {
        snprintf(error, error_len, "invalid session_store on line %d", line_number);
        goto fail;
      }
      snprintf(auth->session_store, sizeof(auth->session_store), "%s", value);
    } else if (!strcmp(key, "require_mfa")) {
      if (!parse_bool(value, &auth->require_mfa)) {
        snprintf(error, error_len, "invalid require_mfa on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "cookie_secure")) {
      if (!parse_bool(value, &auth->cookie_secure)) {
        snprintf(error, error_len, "invalid cookie_secure on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "allowed_host")) {
      if (strlen(value) >= sizeof(auth->allowed_host) || strchr(value, '/') || strchr(value, ' ')) {
        snprintf(error, error_len, "invalid allowed_host on line %d", line_number);
        goto fail;
      }
      snprintf(auth->allowed_host, sizeof(auth->allowed_host), "%s", value);
    } else if (!strcmp(key, "proxy_header")) {
      snprintf(auth->proxy_header, sizeof(auth->proxy_header), "%s", value);
      if (!prepare_custom_header(auth->proxy_header, sizeof(auth->proxy_header))) {
        snprintf(error, error_len, "invalid proxy_header on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "client_ip_header")) {
      snprintf(auth->client_ip_header, sizeof(auth->client_ip_header), "%s", value);
      if (auth->client_ip_header[0] &&
          !prepare_custom_header(auth->client_ip_header, sizeof(auth->client_ip_header))) {
        snprintf(error, error_len, "invalid client_ip_header on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "login_max_failures")) {
      int64_t parsed = 0;
      if (!parse_i64(value, 1, 100, &parsed)) {
        snprintf(error, error_len, "invalid login_max_failures on line %d", line_number);
        goto fail;
      }
      auth->login_max_failures = (int)parsed;
    } else if (!strcmp(key, "login_window_seconds")) {
      if (!parse_i64(value, 10, 86400, &auth->login_window)) {
        snprintf(error, error_len, "invalid login_window_seconds on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "login_lockout_seconds")) {
      if (!parse_i64(value, 1, 86400, &auth->login_lockout)) {
        snprintf(error, error_len, "invalid login_lockout_seconds on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "totp_secret")) {
      if (!base32_decode(value, auth->totp_secret, sizeof(auth->totp_secret), &auth->totp_secret_len)) {
        snprintf(error, error_len, "invalid totp_secret on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "totp_secret_file")) {
      if (*value != '/' || strlen(value) >= sizeof(auth->totp_secret_file)) {
        snprintf(error, error_len, "invalid totp_secret_file on line %d", line_number);
        goto fail;
      }
      snprintf(auth->totp_secret_file, sizeof(auth->totp_secret_file), "%s", value);
    } else if (!strcmp(key, "rate_limit_state")) {
      if (*value != '/' || strlen(value) >= sizeof(auth->rate_limit_state)) {
        snprintf(error, error_len, "invalid rate_limit_state on line %d", line_number);
        goto fail;
      }
      snprintf(auth->rate_limit_state, sizeof(auth->rate_limit_state), "%s", value);
    } else if (!strcmp(key, "audit_log")) {
      if (*value != '/' || strlen(value) >= sizeof(auth->audit_log)) {
        snprintf(error, error_len, "invalid audit_log on line %d", line_number);
        goto fail;
      }
      snprintf(auth->audit_log, sizeof(auth->audit_log), "%s", value);
    } else if (!strcmp(key, "audit_max_bytes")) {
      if (!parse_i64(value, 65536, 104857600, &auth->audit_max_bytes)) {
        snprintf(error, error_len, "invalid audit_max_bytes on line %d", line_number);
        goto fail;
      }
    } else if (!strcmp(key, "audit_retention_files")) {
      int64_t parsed = 0;
      if (!parse_i64(value, 1, 20, &parsed)) {
        snprintf(error, error_len, "invalid audit_retention_files on line %d", line_number);
        goto fail;
      }
      auth->audit_retention_files = (int)parsed;
    } else if (!strcmp(key, "passkey_store")) {
      if (*value != '/' || strlen(value) >= sizeof(auth->passkey_store)) {
        snprintf(error, error_len, "invalid passkey_store on line %d", line_number);
        goto fail;
      }
      snprintf(auth->passkey_store, sizeof(auth->passkey_store), "%s", value);
    } else if (!strcmp(key, "preferences_file")) {
      if (*value != '/' || strlen(value) >= sizeof(auth->preferences_file)) {
        snprintf(error, error_len, "invalid preferences_file on line %d", line_number);
        goto fail;
      }
      snprintf(auth->preferences_file, sizeof(auth->preferences_file), "%s", value);
    } else if (!strcmp(key, "max_connections_per_ip")) {
      int64_t parsed = 0;
      if (!parse_i64(value, 1, 64, &parsed)) {
        snprintf(error, error_len, "invalid max_connections_per_ip on line %d", line_number);
        goto fail;
      }
      auth->max_connections_per_ip = (int)parsed;
    } else if (!strcmp(key, "ws_max_attempts")) {
      int64_t parsed = 0;
      if (!parse_i64(value, 1, 1000, &parsed)) {
        snprintf(error, error_len, "invalid ws_max_attempts on line %d", line_number);
        goto fail;
      }
      auth->ws_max_attempts = (int)parsed;
    } else if (!strcmp(key, "ws_rate_window_seconds")) {
      if (!parse_i64(value, 1, 3600, &auth->ws_rate_window)) {
        snprintf(error, error_len, "invalid ws_rate_window_seconds on line %d", line_number);
        goto fail;
      }
    } else {
      snprintf(error, error_len, "unknown security setting '%s' on line %d", key, line_number);
      goto fail;
    }
  }

  if (ferror(file)) {
    snprintf(error, error_len, "failed reading security config: %s", strerror(errno));
    goto fail;
  }
  fclose(file);
  if (!validate_session_config(auth, have_password, have_secret, error, error_len)) {
    lumen_auth_free(auth);
    return -1;
  }
  if (auth->rate_limit_state[0]) {
    FILE *state = fopen(auth->rate_limit_state, "r");
    if (state) {
      size_t index = 0;
      while (index < sizeof(auth->rates) / sizeof(auth->rates[0])) {
        struct lumen_login_rate *rate = &auth->rates[index];
        long long window_started = 0, locked_until = 0;
        if (fscanf(state, "%63s %d %lld %lld", rate->client, &rate->failures,
                   &window_started, &locked_until) != 4)
          break;
        rate->window_started = (int64_t)window_started;
        rate->locked_until = (int64_t)locked_until;
        index++;
      }
      fclose(state);
    }
  }
  if (auth->totp_secret_file[0] && !auth->totp_secret_len) {
    FILE *totp = fopen(auth->totp_secret_file, "r");
    if (totp) {
      char encoded[256] = "";
      if (fscanf(totp, "%255s", encoded) == 1)
        base32_decode(encoded, auth->totp_secret, sizeof(auth->totp_secret), &auth->totp_secret_len);
      fclose(totp);
    }
  }
  if (auth->session_store[0]) {
    FILE *sessions = fopen(auth->session_store, "r");
    if (sessions) {
      int64_t now = (int64_t)time(NULL);
      size_t index = 0;
      while (index < LUMEN_MAX_SESSIONS) {
        struct lumen_session session = {0};
        char extra = '\0';
        long long issued = 0, expires = 0, last_seen = 0;
        int matched =
            fscanf(sessions, "%64[0-9a-f] %lld %lld %lld%c", session.id, &issued, &expires, &last_seen, &extra);
        if (matched == EOF) break;
        if (matched != 5 || (extra != '\n' && extra != '\r') ||
            strlen(session.id) != LUMEN_SESSION_ID_LEN) {
          int ch;
          while ((ch = fgetc(sessions)) != '\n' && ch != EOF) {}
          continue;
        }
        session.issued = (int64_t)issued;
        session.expires = (int64_t)expires;
        session.last_seen = (int64_t)last_seen;
        if (session.expires > now && now - session.last_seen <= auth->session_idle_timeout)
          auth->sessions[index++] = session;
      }
      fclose(sessions);
    }
  }
  if (auth->mode == LUMEN_AUTH_SESSION && auth->require_mfa && !auth->totp_secret_len &&
      !lumen_auth_has_passkeys(auth)) {
    snprintf(error, error_len, "require_mfa needs an enrolled TOTP authenticator or passkey");
    lumen_auth_free(auth);
    return -1;
  }
  *result = auth;
  return 0;

fail:
  fclose(file);
  lumen_auth_free(auth);
  return -1;
}

void lumen_auth_free(struct lumen_auth *auth) {
  if (!auth) return;
  OPENSSL_cleanse(auth, sizeof(*auth));
  free(auth);
}

static bool host_matches(const char *actual, const char *expected) {
  size_t expected_len = strlen(expected);
  if (strncasecmp(actual, expected, expected_len)) return false;
  return actual[expected_len] == '\0' || actual[expected_len] == ':';
}

bool lumen_auth_host_allowed(struct lumen_auth *auth, struct lws *wsi) {
  if (!auth || auth->allowed_host[0] == '\0') return true;
  char host[256] = "";
  int len = lws_hdr_copy(wsi, host, sizeof(host), WSI_TOKEN_HOST);
  return len > 0 && host_matches(host, auth->allowed_host);
}

const char *lumen_auth_session_cookie_name(const struct lumen_auth *auth) {
  return auth->cookie_secure ? "__Host-LumenSession" : "LumenSession";
}

const char *lumen_auth_csrf_cookie_name(const struct lumen_auth *auth) {
  return auth->cookie_secure ? "__Host-LumenCsrf" : "LumenCsrf";
}

bool lumen_auth_cookie_value(const char *cookies, const char *name, char *value, size_t value_len) {
  if (!cookies || !name || !value || value_len == 0) return false;
  size_t name_len = strlen(name);
  const char *cursor = cookies;
  while (*cursor) {
    while (*cursor == ' ' || *cursor == ';') cursor++;
    const char *equals = strchr(cursor, '=');
    if (!equals) break;
    const char *end = strchr(equals + 1, ';');
    if (!end) end = cursor + strlen(cursor);
    size_t key_len = (size_t)(equals - cursor);
    while (key_len && cursor[key_len - 1] == ' ') key_len--;
    if (key_len == name_len && !strncmp(cursor, name, name_len)) {
      size_t len = (size_t)(end - equals - 1);
      if (len == 0 || len >= value_len) return false;
      memcpy(value, equals + 1, len);
      value[len] = '\0';
      return true;
    }
    cursor = end;
  }
  return false;
}

static bool valid_session_id(const char *id) {
  if (!id || strlen(id) != LUMEN_SESSION_ID_LEN) return false;
  for (const char *cursor = id; *cursor; cursor++)
    if (!isxdigit((unsigned char)*cursor) || isupper((unsigned char)*cursor)) return false;
  return true;
}

static bool save_sessions(struct lumen_auth *auth) {
  if (!auth->session_store[0]) return true;
  char temporary[sizeof(auth->session_store) + 32];
  if (snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", auth->session_store, (long)getpid()) <= 0) return false;
  FILE *file = fopen(temporary, "w");
  if (!file) return false;
  chmod(temporary, 0600);
  bool ok = true;
  for (size_t i = 0; i < LUMEN_MAX_SESSIONS; i++) {
    const struct lumen_session *session = &auth->sessions[i];
    if (!session->id[0]) continue;
    if (fprintf(file, "%s %lld %lld %lld\n", session->id, (long long)session->issued,
                (long long)session->expires, (long long)session->last_seen) < 0) {
      ok = false;
      break;
    }
  }
  if (fclose(file) != 0) ok = false;
  if (ok && rename(temporary, auth->session_store) == 0) return true;
  unlink(temporary);
  return false;
}

static struct lumen_session *find_session(struct lumen_auth *auth, const char *id) {
  if (!valid_session_id(id)) return NULL;
  for (size_t i = 0; i < LUMEN_MAX_SESSIONS; i++)
    if (auth->sessions[i].id[0] && !strcmp(auth->sessions[i].id, id)) return &auth->sessions[i];
  return NULL;
}

bool lumen_auth_session_active(struct lumen_auth *auth, const char *session_id, bool touch) {
  if (!auth || auth->mode != LUMEN_AUTH_SESSION) return auth && auth->mode != LUMEN_AUTH_SESSION;
  struct lumen_session *session = find_session(auth, session_id);
  if (!session) return false;
  int64_t now = (int64_t)time(NULL);
  if (session->expires <= now || now - session->last_seen > auth->session_idle_timeout) {
    OPENSSL_cleanse(session, sizeof(*session));
    save_sessions(auth);
    return false;
  }
  if (touch && now - session->last_seen >= 60) {
    session->last_seen = now;
    save_sessions(auth);
  }
  return true;
}

static bool session_token_valid(struct lumen_auth *auth, const char *token, char *session_id, size_t session_id_len) {
  if (strlen(token) >= TOKEN_MAX_LEN) return false;
  char copy[TOKEN_MAX_LEN];
  snprintf(copy, sizeof(copy), "%s", token);
  char *signature = strrchr(copy, '.');
  if (!signature) return false;
  *signature++ = '\0';
  unsigned char supplied_hmac[32];
  if (!hex_decode(signature, supplied_hmac, sizeof(supplied_hmac))) return false;

  unsigned char expected_hmac[EVP_MAX_MD_SIZE];
  unsigned int hmac_len = 0;
  if (!HMAC(EVP_sha256(), auth->session_secret, sizeof(auth->session_secret), (unsigned char *)copy, strlen(copy),
            expected_hmac, &hmac_len) ||
      hmac_len != sizeof(supplied_hmac) || CRYPTO_memcmp(supplied_hmac, expected_hmac, sizeof(supplied_hmac)))
    return false;

  unsigned int generation = 0;
  long long issued = 0;
  long long expires = 0;
  char nonce[SESSION_NONCE_LEN * 2 + 1] = "";
  char extra = '\0';
  if (sscanf(copy, "v1.%u.%lld.%lld.%64[0-9a-f]%c", &generation, &issued, &expires, nonce, &extra) != 4 ||
      strlen(nonce) != SESSION_NONCE_LEN * 2)
    return false;

  int64_t now = (int64_t)time(NULL);
  bool valid = generation == auth->session_generation && issued <= now + 300 && expires > now && expires > issued &&
               expires - issued <= auth->session_ttl && lumen_auth_session_active(auth, nonce, true);
  if (valid && session_id && session_id_len > LUMEN_SESSION_ID_LEN)
    snprintf(session_id, session_id_len, "%s", nonce);
  return valid;
}

bool lumen_auth_request_user_session(struct lumen_auth *auth, struct lws *wsi, char *user, size_t user_len,
                                     char *session_id, size_t session_id_len) {
  if (!auth || auth->mode == LUMEN_AUTH_OFF) return true;
  if (!lumen_auth_host_allowed(auth, wsi)) return false;
  if (auth->mode == LUMEN_AUTH_PROXY) {
    return lws_hdr_custom_copy(wsi, user, (int)user_len, auth->proxy_header, strlen(auth->proxy_header)) > 0;
  }

  int cookies_len = lws_hdr_total_length(wsi, WSI_TOKEN_HTTP_COOKIE);
  if (cookies_len <= 0 || cookies_len > 65535) return false;
  char *cookies = malloc((size_t)cookies_len + 1);
  if (!cookies) return false;

  char token[TOKEN_MAX_LEN] = "";
  int copied = lws_hdr_copy(wsi, cookies, cookies_len + 1, WSI_TOKEN_HTTP_COOKIE);
  bool valid = copied == cookies_len &&
               lumen_auth_cookie_value(cookies, lumen_auth_session_cookie_name(auth), token, sizeof(token)) &&
               session_token_valid(auth, token, session_id, session_id_len);
  OPENSSL_cleanse(cookies, (size_t)cookies_len + 1);
  free(cookies);
  if (!valid) return false;
  snprintf(user, user_len, "%s", auth->username);
  return true;
}

bool lumen_auth_request_user(struct lumen_auth *auth, struct lws *wsi, char *user, size_t user_len) {
  return lumen_auth_request_user_session(auth, wsi, user, user_len, NULL, 0);
}

bool lumen_auth_revoke_request_session(struct lumen_auth *auth, struct lws *wsi) {
  if (!auth || auth->mode != LUMEN_AUTH_SESSION) return false;
  int cookies_len = lws_hdr_total_length(wsi, WSI_TOKEN_HTTP_COOKIE);
  if (cookies_len <= 0 || cookies_len > 65535) return false;
  char *cookies = malloc((size_t)cookies_len + 1);
  if (!cookies) return false;
  char token[TOKEN_MAX_LEN] = "", session_id[LUMEN_SESSION_ID_LEN + 1] = "";
  int copied = lws_hdr_copy(wsi, cookies, cookies_len + 1, WSI_TOKEN_HTTP_COOKIE);
  bool valid = copied == cookies_len &&
               lumen_auth_cookie_value(cookies, lumen_auth_session_cookie_name(auth), token, sizeof(token)) &&
               session_token_valid(auth, token, session_id, sizeof(session_id));
  OPENSSL_cleanse(cookies, (size_t)cookies_len + 1);
  free(cookies);
  struct lumen_session *session = valid ? find_session(auth, session_id) : NULL;
  if (!session) return false;
  memset(session, 0, sizeof(*session));
  return save_sessions(auth);
}

bool lumen_auth_origin_valid(struct lumen_auth *auth, const char *origin, const char *host) {
  if (!origin || !host || !*origin || !*host) return false;
  const char *separator = strstr(origin, "://");
  if (!separator) return false;
  size_t scheme_len = (size_t)(separator - origin);
  if ((auth->cookie_secure && (scheme_len != 5 || strncasecmp(origin, "https", 5))) ||
      (!auth->cookie_secure && !((scheme_len == 4 && !strncasecmp(origin, "http", 4)) ||
                                 (scheme_len == 5 && !strncasecmp(origin, "https", 5)))))
    return false;

  const char *authority = separator + 3;
  const char *end = strchr(authority, '/');
  size_t authority_len = end ? (size_t)(end - authority) : strlen(authority);
  return authority_len == strlen(host) && !strncasecmp(authority, host, authority_len) &&
         (auth->allowed_host[0] == '\0' || host_matches(host, auth->allowed_host));
}

void lumen_auth_client_key(struct lumen_auth *auth, struct lws *wsi, char *client, size_t client_len) {
  int copied = 0;
  if (auth && auth->client_ip_header[0]) {
#if defined(LWS_WITH_HTTP_UNCOMMON_HEADERS)
    if (!strcmp(auth->client_ip_header, "x-real-ip:"))
      copied = lws_hdr_copy(wsi, client, (int)client_len, WSI_TOKEN_HTTP_X_REAL_IP);
    else
#endif
        if (!strcmp(auth->client_ip_header, "x-forwarded-for:"))
      copied = lws_hdr_copy(wsi, client, (int)client_len, WSI_TOKEN_X_FORWARDED_FOR);
    else
      copied =
          lws_hdr_custom_copy(wsi, client, (int)client_len, auth->client_ip_header, strlen(auth->client_ip_header));
  }
  if (copied > 0) {
    char *comma = strchr(client, ',');
    if (comma) *comma = '\0';
    for (char *p = client; *p; p++)
      if (!isxdigit((unsigned char)*p) && *p != '.' && *p != ':') {
        copied = 0;
        break;
      }
    if (copied > 0) return;
  }
  lws_get_peer_simple(lws_get_network_wsi(wsi), client, (int)client_len);
}

static void save_rates(struct lumen_auth *auth) {
  if (!auth->rate_limit_state[0]) return;
  char temporary[sizeof(auth->rate_limit_state) + 32];
  if (snprintf(temporary, sizeof(temporary), "%s.tmp.%ld", auth->rate_limit_state, (long)getpid()) <= 0) return;
  FILE *file = fopen(temporary, "w");
  if (!file) return;
  chmod(temporary, 0600);
  for (size_t i = 0; i < sizeof(auth->rates) / sizeof(auth->rates[0]); i++) {
    struct lumen_login_rate *rate = &auth->rates[i];
    if (rate->client[0])
      fprintf(file, "%s %d %lld %lld\n", rate->client, rate->failures, (long long)rate->window_started,
              (long long)rate->locked_until);
  }
  if (fclose(file) == 0) rename(temporary, auth->rate_limit_state);
  else unlink(temporary);
}

static void rotate_audit_log(struct lumen_auth *auth) {
  struct stat st;
  if (stat(auth->audit_log, &st) != 0 || st.st_size < auth->audit_max_bytes) return;
  char source[640], target[640];
  snprintf(target, sizeof(target), "%s.%d", auth->audit_log, auth->audit_retention_files);
  unlink(target);
  for (int index = auth->audit_retention_files - 1; index >= 1; index--) {
    snprintf(source, sizeof(source), "%s.%d", auth->audit_log, index);
    snprintf(target, sizeof(target), "%s.%d", auth->audit_log, index + 1);
    rename(source, target);
  }
  snprintf(target, sizeof(target), "%s.1", auth->audit_log);
  rename(auth->audit_log, target);
}

void lumen_auth_audit(struct lumen_auth *auth, const char *event, const char *client, const char *detail) {
  if (!auth || !auth->audit_log[0]) return;
  rotate_audit_log(auth);
  FILE *file = fopen(auth->audit_log, "a");
  if (!file) return;
  chmod(auth->audit_log, 0600);
  time_t now = time(NULL);
  struct tm timestamp;
  gmtime_r(&now, &timestamp);
  char formatted[32];
  strftime(formatted, sizeof(formatted), "%Y-%m-%dT%H:%M:%SZ", &timestamp);
  fprintf(file, "%s event=%s client=%s detail=%s\n", formatted, event ? event : "-", client ? client : "-",
          detail ? detail : "-");
  fclose(file);
}

char *lumen_auth_audit_list(struct lumen_auth *auth, size_t limit) {
  if (!auth || !auth->audit_log[0]) return strdup("[]");
  if (limit == 0 || limit > 500) limit = 200;
  FILE *file = fopen(auth->audit_log, "r");
  if (!file) return errno == ENOENT ? strdup("[]") : NULL;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long size = ftell(file);
  long start = size > 262144 ? size - 262144 : 0;
  if (fseek(file, start, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  if (start > 0) {
    char discarded[1024];
    if (!fgets(discarded, sizeof(discarded), file) && ferror(file)) {
      fclose(file);
      return NULL;
    }
  }

  char **lines = calloc(limit, sizeof(*lines));
  if (!lines) {
    fclose(file);
    return NULL;
  }
  size_t count = 0, next = 0;
  char line[1024];
  while (fgets(line, sizeof(line), file)) {
    free(lines[next]);
    lines[next] = strdup(line);
    if (!lines[next]) break;
    next = (next + 1) % limit;
    if (count < limit) count++;
  }
  fclose(file);

  json_object *array = json_object_new_array();
  if (!array) goto fail;
  for (size_t offset = 0; offset < count; offset++) {
    size_t index = (next + limit - 1 - offset) % limit;
    char *entry = lines[index];
    if (!entry) continue;
    char *event = strstr(entry, " event=");
    char *client = event ? strstr(event + 1, " client=") : NULL;
    char *detail = client ? strstr(client + 1, " detail=") : NULL;
    if (!event || !client || !detail) continue;
    *event = '\0';
    *client = '\0';
    *detail = '\0';
    char *newline = strchr(detail + 8, '\n');
    if (newline) *newline = '\0';
    json_object *item = json_object_new_object();
    if (!item) continue;
    json_object_object_add(item, "timestamp", json_object_new_string(entry));
    json_object_object_add(item, "event", json_object_new_string(event + 7));
    json_object_object_add(item, "client", json_object_new_string(client + 8));
    json_object_object_add(item, "detail", json_object_new_string(detail + 8));
    json_object_array_add(array, item);
  }
  const char *serialized = json_object_to_json_string_ext(array, JSON_C_TO_STRING_PLAIN);
  char *result = strdup(serialized);
  json_object_put(array);
  for (size_t i = 0; i < limit; i++) free(lines[i]);
  free(lines);
  return result;

fail:
  for (size_t i = 0; i < limit; i++) free(lines[i]);
  free(lines);
  return NULL;
}

static struct lumen_ws_rate *ws_rate_entry(struct lumen_auth *auth, const char *client, int64_t now) {
  struct lumen_ws_rate *oldest = &auth->ws_rates[0];
  for (size_t i = 0; i < sizeof(auth->ws_rates) / sizeof(auth->ws_rates[0]); i++) {
    struct lumen_ws_rate *entry = &auth->ws_rates[i];
    if (entry->client[0] && !strcmp(entry->client, client)) return entry;
    if (!entry->client[0]) {
      snprintf(entry->client, sizeof(entry->client), "%s", client);
      entry->window_started = now;
      return entry;
    }
    if (!entry->active && entry->window_started < oldest->window_started) oldest = entry;
  }
  if (oldest->active) return NULL;
  memset(oldest, 0, sizeof(*oldest));
  snprintf(oldest->client, sizeof(oldest->client), "%s", client);
  oldest->window_started = now;
  return oldest;
}

bool lumen_auth_ws_admit(struct lumen_auth *auth, const char *client) {
  if (!auth) return true;
  int64_t now = (int64_t)time(NULL);
  struct lumen_ws_rate *rate = ws_rate_entry(auth, client, now);
  if (!rate || rate->active >= auth->max_connections_per_ip) return false;
  if (now - rate->window_started >= auth->ws_rate_window) {
    rate->attempts = 0;
    rate->window_started = now;
  }
  rate->attempts++;
  return rate->attempts <= auth->ws_max_attempts;
}

void lumen_auth_ws_connected(struct lumen_auth *auth, const char *client) {
  if (!auth) return;
  struct lumen_ws_rate *rate = ws_rate_entry(auth, client, (int64_t)time(NULL));
  if (rate) rate->active++;
  lumen_auth_audit(auth, "ws_connected", client, "terminal");
}

void lumen_auth_ws_disconnected(struct lumen_auth *auth, const char *client) {
  if (!auth) return;
  struct lumen_ws_rate *rate = ws_rate_entry(auth, client, (int64_t)time(NULL));
  if (rate && rate->active > 0) rate->active--;
  lumen_auth_audit(auth, "ws_disconnected", client, "terminal");
}

static bool totp_secret_valid(const unsigned char *secret, size_t secret_len, const char *code, int64_t now) {
  if (!secret_len) return true;
  if (!code || strlen(code) != 6) return false;
  for (const char *p = code; *p; p++)
    if (!isdigit((unsigned char)*p)) return false;
  int supplied = atoi(code);
  for (int offset = -1; offset <= 1; offset++) {
    uint64_t counter = (uint64_t)(now / 30 + offset);
    unsigned char message[8];
    for (int i = 7; i >= 0; i--) {
      message[i] = (unsigned char)(counter & 0xff);
      counter >>= 8;
    }
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int length = 0;
    if (!HMAC(EVP_sha1(), secret, (int)secret_len, message, sizeof(message), digest, &length) ||
        length < 20)
      return false;
    int index = digest[length - 1] & 0x0f;
    int expected = ((digest[index] & 0x7f) << 24) | (digest[index + 1] << 16) |
                   (digest[index + 2] << 8) | digest[index + 3];
    if (expected % 1000000 == supplied) return true;
  }
  return false;
}

static bool totp_valid(const struct lumen_auth *auth, const char *code, int64_t now) {
  return totp_secret_valid(auth->totp_secret, auth->totp_secret_len, code, now);
}

char *lumen_auth_totp_begin(struct lumen_auth *auth, const char *client) {
  if (!auth || !auth->totp_secret_file[0] || auth->totp_secret_len) return NULL;
  OPENSSL_cleanse(auth->totp_pending_secret, sizeof(auth->totp_pending_secret));
  auth->totp_pending_secret_len = 20;
  auth->totp_pending_expires = (int64_t)time(NULL) + 600;
  if (RAND_bytes(auth->totp_pending_secret, (int)auth->totp_pending_secret_len) != 1) {
    auth->totp_pending_secret_len = 0;
    return NULL;
  }
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  char encoded[64] = "";
  unsigned int accumulator = 0, bits = 0;
  size_t written = 0;
  for (size_t i = 0; i < auth->totp_pending_secret_len; i++) {
    accumulator = (accumulator << 8) | auth->totp_pending_secret[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded[written++] = alphabet[(accumulator >> bits) & 31];
    }
  }
  if (bits) encoded[written++] = alphabet[(accumulator << (5 - bits)) & 31];
  encoded[written] = '\0';
  char *uri = malloc(1024);
  if (!uri) return NULL;
  snprintf(uri, 1024, "otpauth://totp/Lumen:%s?secret=%s&issuer=Lumen&algorithm=SHA1&digits=6&period=30",
           auth->username, encoded);
  lumen_auth_audit(auth, "totp_setup_started", client, "authenticator");
  return uri;
}

bool lumen_auth_totp_confirm(struct lumen_auth *auth, const char *client, const char *code) {
  int64_t now = (int64_t)time(NULL);
  if (!auth || auth->totp_secret_len || !auth->totp_pending_secret_len || auth->totp_pending_expires < now ||
      !totp_secret_valid(auth->totp_pending_secret, auth->totp_pending_secret_len, code, now))
    return false;
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  char encoded[128] = "";
  unsigned int accumulator = 0, bits = 0;
  size_t written = 0;
  for (size_t i = 0; i < auth->totp_pending_secret_len; i++) {
    accumulator = (accumulator << 8) | auth->totp_pending_secret[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded[written++] = alphabet[(accumulator >> bits) & 31];
    }
  }
  if (bits) encoded[written++] = alphabet[(accumulator << (5 - bits)) & 31];
  encoded[written] = '\0';
  FILE *file = fopen(auth->totp_secret_file, "w");
  if (!file) return false;
  chmod(auth->totp_secret_file, 0600);
  fprintf(file, "%s\n", encoded);
  if (fclose(file) != 0) return false;
  memcpy(auth->totp_secret, auth->totp_pending_secret, auth->totp_pending_secret_len);
  auth->totp_secret_len = auth->totp_pending_secret_len;
  OPENSSL_cleanse(auth->totp_pending_secret, sizeof(auth->totp_pending_secret));
  auth->totp_pending_secret_len = 0;
  auth->totp_pending_expires = 0;
  lumen_auth_audit(auth, "totp_enabled", client, "authenticator");
  return true;
}

bool lumen_auth_totp_remove(struct lumen_auth *auth, const char *client, const char *code) {
  int64_t now = (int64_t)time(NULL);
  if (!auth || !auth->totp_secret_len || !totp_valid(auth, code, now)) return false;
  if (auth->require_mfa && !lumen_auth_has_passkeys(auth)) return false;
  if (unlink(auth->totp_secret_file) != 0 && errno != ENOENT) return false;
  OPENSSL_cleanse(auth->totp_secret, sizeof(auth->totp_secret));
  auth->totp_secret_len = 0;
  lumen_auth_audit(auth, "totp_removed", client, "authenticator");
  return true;
}

bool lumen_auth_totp_enabled(struct lumen_auth *auth) {
  return auth && auth->totp_secret_len > 0;
}

bool lumen_auth_totp_verify(struct lumen_auth *auth, const char *code) {
  return auth && auth->totp_secret_len && totp_valid(auth, code, (int64_t)time(NULL));
}

static bool privileged_terminal_id(const char *id) {
  return id && strlen(id) == 6 && !strncmp(id, "root-", 5) && id[5] >= '1' && id[5] <= '8';
}

bool lumen_auth_issue_privileged_grant(struct lumen_auth *auth, const char *auth_session,
                                       const char *terminal_id, bool create, char token[65]) {
  if (!auth || !auth_session || strlen(auth_session) != LUMEN_SESSION_ID_LEN ||
      !privileged_terminal_id(terminal_id) ||
      !lumen_auth_session_active(auth, auth_session, true))
    return false;
  unsigned char random[32];
  if (RAND_bytes(random, sizeof(random)) != 1) return false;
  int64_t now = (int64_t)time(NULL);
  struct lumen_privileged_grant *slot = NULL;
  for (size_t i = 0; i < LUMEN_PRIVILEGED_GRANTS; i++) {
    if (auth->privileged_grants[i].expires <= now) {
      slot = &auth->privileged_grants[i];
      break;
    }
  }
  if (!slot) return false;
  OPENSSL_cleanse(slot, sizeof(*slot));
  snprintf(slot->auth_session, sizeof(slot->auth_session), "%s", auth_session);
  snprintf(slot->terminal_id, sizeof(slot->terminal_id), "%s", terminal_id);
  hex_encode(random, sizeof(random), slot->token);
  slot->expires = now + 90;
  slot->create = create;
  snprintf(token, 65, "%s", slot->token);
  return true;
}

bool lumen_auth_consume_privileged_grant(struct lumen_auth *auth, const char *auth_session,
                                         const char *terminal_id, const char *token, bool *create) {
  if (!auth || !auth_session || !terminal_id || !token || strlen(token) != 64) return false;
  int64_t now = (int64_t)time(NULL);
  for (size_t i = 0; i < LUMEN_PRIVILEGED_GRANTS; i++) {
    struct lumen_privileged_grant *slot = &auth->privileged_grants[i];
    if (slot->expires <= now || strcmp(slot->auth_session, auth_session) ||
        strcmp(slot->terminal_id, terminal_id) ||
        CRYPTO_memcmp(slot->token, token, 64))
      continue;
    if (create) *create = slot->create;
    OPENSSL_cleanse(slot, sizeof(*slot));
    return lumen_auth_session_active(auth, auth_session, true);
  }
  return false;
}

static struct lumen_login_rate *rate_entry(struct lumen_auth *auth, const char *client, int64_t now) {
  struct lumen_login_rate *oldest = &auth->rates[0];
  for (size_t i = 0; i < sizeof(auth->rates) / sizeof(auth->rates[0]); i++) {
    struct lumen_login_rate *entry = &auth->rates[i];
    if (entry->client[0] && !strcmp(entry->client, client)) return entry;
    if (!entry->client[0]) {
      snprintf(entry->client, sizeof(entry->client), "%s", client);
      entry->window_started = now;
      return entry;
    }
    if (entry->window_started < oldest->window_started) oldest = entry;
  }
  memset(oldest, 0, sizeof(*oldest));
  snprintf(oldest->client, sizeof(oldest->client), "%s", client);
  oldest->window_started = now;
  return oldest;
}

enum lumen_login_result lumen_auth_login(struct lumen_auth *auth, const char *client, const char *username,
                                         const char *password, const char *totp, int64_t *retry_after) {
  if (!auth || auth->mode != LUMEN_AUTH_SESSION) return LUMEN_LOGIN_ERROR;
  if (auth->require_mfa && !auth->totp_secret_len) return LUMEN_LOGIN_MFA_REQUIRED;
  int64_t now = (int64_t)time(NULL);
  struct lumen_login_rate *rate = rate_entry(auth, client, now);
  if (rate->locked_until > now) {
    *retry_after = rate->locked_until - now;
    return LUMEN_LOGIN_LOCKED;
  }
  if (now - rate->window_started > auth->login_window) {
    rate->failures = 0;
    rate->window_started = now;
    rate->locked_until = 0;
  }

  size_t password_len = strlen(password);
  bool password_length_valid = password_len > 0 && password_len <= 128;
  unsigned char candidate[32];
  const char *work_password = password_length_valid ? password : "";
  if (!PKCS5_PBKDF2_HMAC(work_password, (int)strlen(work_password), auth->password_salt, (int)auth->password_salt_len,
                         auth->password_iterations, EVP_sha256(), sizeof(candidate), candidate))
    return LUMEN_LOGIN_ERROR;

  bool username_valid = strlen(username) == strlen(auth->username) &&
                        CRYPTO_memcmp(username, auth->username, strlen(auth->username)) == 0;
  bool password_valid = password_length_valid && CRYPTO_memcmp(candidate, auth->password_hash, sizeof(candidate)) == 0;
  OPENSSL_cleanse(candidate, sizeof(candidate));

  bool totp_code_valid = totp_valid(auth, totp, now);
  if (username_valid && password_valid && totp_code_valid) {
    memset(rate, 0, sizeof(*rate));
    save_rates(auth);
    return LUMEN_LOGIN_OK;
  }

  rate->failures++;
  if (rate->failures >= auth->login_max_failures) {
    int exponent = rate->failures - auth->login_max_failures;
    if (exponent > 4) exponent = 4;
    int64_t delay = auth->login_lockout << exponent;
    if (delay > 86400) delay = 86400;
    rate->locked_until = now + delay;
    *retry_after = delay;
  }
  save_rates(auth);
  return username_valid && password_valid && auth->totp_secret_len
             ? LUMEN_LOGIN_TOTP_INVALID
             : LUMEN_LOGIN_INVALID;
}

static int make_cookie_header(struct lumen_auth *auth, const char *name, const char *value, int64_t max_age,
                              bool http_only, char *header, size_t header_len) {
  return snprintf(header, header_len, "Set-Cookie: %s=%s; Max-Age=%lld; Path=/;%s%s SameSite=Strict\r\n", name,
                  value, (long long)max_age, auth->cookie_secure ? " Secure;" : "", http_only ? " HttpOnly;" : "");
}

int lumen_auth_new_session_cookie(struct lumen_auth *auth, char *header, size_t header_len) {
  unsigned char nonce[SESSION_NONCE_LEN];
  if (RAND_bytes(nonce, sizeof(nonce)) != 1) return -1;
  char nonce_hex[sizeof(nonce) * 2 + 1];
  hex_encode(nonce, sizeof(nonce), nonce_hex);

  int64_t now = (int64_t)time(NULL);
  struct lumen_session *slot = NULL;
  for (size_t i = 0; i < LUMEN_MAX_SESSIONS; i++) {
    struct lumen_session *candidate = &auth->sessions[i];
    if (!candidate->id[0] || candidate->expires <= now ||
        now - candidate->last_seen > auth->session_idle_timeout) {
      slot = candidate;
      break;
    }
    if (!slot || candidate->last_seen < slot->last_seen) slot = candidate;
  }
  if (!slot) return -1;

  char payload[160];
  int payload_len =
      snprintf(payload, sizeof(payload), "v1.%u.%lld.%lld.%s", auth->session_generation, (long long)now,
               (long long)(now + auth->session_ttl), nonce_hex);
  if (payload_len <= 0 || (size_t)payload_len >= sizeof(payload)) return -1;

  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int digest_len = 0;
  if (!HMAC(EVP_sha256(), auth->session_secret, sizeof(auth->session_secret), (unsigned char *)payload,
            (size_t)payload_len, digest, &digest_len) ||
      digest_len != 32)
    return -1;
  char digest_hex[65];
  hex_encode(digest, digest_len, digest_hex);

  char token[TOKEN_MAX_LEN];
  int token_len = snprintf(token, sizeof(token), "%s.%s", payload, digest_hex);
  if (token_len <= 0 || (size_t)token_len >= sizeof(token)) return -1;
  int written = make_cookie_header(auth, lumen_auth_session_cookie_name(auth), token, auth->session_ttl, true, header,
                                   header_len);
  if (written <= 0 || (size_t)written >= header_len) return -1;

  struct lumen_session previous = *slot;
  snprintf(slot->id, sizeof(slot->id), "%s", nonce_hex);
  slot->issued = now;
  slot->expires = now + auth->session_ttl;
  slot->last_seen = now;
  if (!save_sessions(auth)) {
    *slot = previous;
    return -1;
  }
  return written;
}

int lumen_auth_clear_session_cookie(struct lumen_auth *auth, char *header, size_t header_len) {
  return make_cookie_header(auth, lumen_auth_session_cookie_name(auth), "", 0, true, header, header_len);
}

int lumen_auth_new_csrf(struct lumen_auth *auth, char *token, size_t token_len, char *header, size_t header_len) {
  unsigned char random[32];
  if (token_len < sizeof(random) * 2 + 1 || RAND_bytes(random, sizeof(random)) != 1) return -1;
  hex_encode(random, sizeof(random), token);
  return make_cookie_header(auth, lumen_auth_csrf_cookie_name(auth), token, 600, true, header, header_len);
}

int lumen_auth_clear_csrf_cookie(struct lumen_auth *auth, char *header, size_t header_len) {
  return make_cookie_header(auth, lumen_auth_csrf_cookie_name(auth), "", 0, true, header, header_len);
}
