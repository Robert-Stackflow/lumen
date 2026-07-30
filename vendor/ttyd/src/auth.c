#include "auth.h"

#include <ctype.h>
#include <errno.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
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
  auth->session_ttl = 180 * 24 * 60 * 60LL;
  auth->cookie_secure = true;
  auth->login_max_failures = 5;
  auth->login_window = 300;
  auth->login_lockout = 300;

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

static bool session_token_valid(struct lumen_auth *auth, const char *token) {
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
  return generation == auth->session_generation && issued <= now + 300 && expires > now && expires > issued &&
         expires - issued <= auth->session_ttl;
}

bool lumen_auth_request_user(struct lumen_auth *auth, struct lws *wsi, char *user, size_t user_len) {
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
               session_token_valid(auth, token);
  OPENSSL_cleanse(cookies, (size_t)cookies_len + 1);
  free(cookies);
  if (!valid) return false;
  snprintf(user, user_len, "%s", auth->username);
  return true;
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
    return;
  }
  lws_get_peer_simple(lws_get_network_wsi(wsi), client, (int)client_len);
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
                                         const char *password, int64_t *retry_after) {
  if (!auth || auth->mode != LUMEN_AUTH_SESSION) return LUMEN_LOGIN_ERROR;
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

  if (username_valid && password_valid) {
    memset(rate, 0, sizeof(*rate));
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
  return LUMEN_LOGIN_INVALID;
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
  return make_cookie_header(auth, lumen_auth_session_cookie_name(auth), token, auth->session_ttl, true, header,
                            header_len);
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
