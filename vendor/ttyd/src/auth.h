#ifndef LUMEN_AUTH_H
#define LUMEN_AUTH_H

#include <libwebsockets.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum lumen_auth_mode {
  LUMEN_AUTH_OFF = 0,
  LUMEN_AUTH_SESSION,
  LUMEN_AUTH_PROXY,
};

struct lumen_login_rate {
  char client[64];
  int failures;
  int64_t window_started;
  int64_t locked_until;
};

struct lumen_ws_rate {
  char client[64];
  int active;
  int attempts;
  int64_t window_started;
};

struct lumen_webauthn_challenge {
  char client[64];
  unsigned char value[32];
  int64_t expires;
  bool registration;
};

#define LUMEN_SESSION_ID_LEN 64
#define LUMEN_MAX_SESSIONS 128

struct lumen_session {
  char id[LUMEN_SESSION_ID_LEN + 1];
  int64_t issued;
  int64_t expires;
  int64_t last_seen;
};

#define LUMEN_PRIVILEGED_GRANTS 32
struct lumen_privileged_grant {
  char auth_session[LUMEN_SESSION_ID_LEN + 1];
  char terminal_id[33];
  char token[65];
  int64_t expires;
  bool create;
};

struct lumen_auth {
  enum lumen_auth_mode mode;
  char username[65];
  unsigned char password_salt[32];
  size_t password_salt_len;
  unsigned char password_hash[32];
  int password_iterations;
  unsigned char session_secret[32];
  uint32_t session_generation;
  int64_t session_ttl;
  int64_t session_idle_timeout;
  char session_store[512];
  bool require_mfa;
  bool cookie_secure;
  char allowed_host[256];
  char proxy_header[128];
  char client_ip_header[128];
  int login_max_failures;
  int64_t login_window;
  int64_t login_lockout;
  unsigned char totp_secret[64];
  size_t totp_secret_len;
  unsigned char totp_pending_secret[64];
  size_t totp_pending_secret_len;
  int64_t totp_pending_expires;
  char totp_secret_file[512];
  char rate_limit_state[512];
  char audit_log[512];
  int64_t audit_max_bytes;
  int audit_retention_files;
  char passkey_store[512];
  char preferences_file[512];
  int max_connections_per_ip;
  int ws_max_attempts;
  int64_t ws_rate_window;
  struct lumen_login_rate rates[64];
  struct lumen_ws_rate ws_rates[64];
  struct lumen_webauthn_challenge challenges[32];
  struct lumen_session sessions[LUMEN_MAX_SESSIONS];
  struct lumen_privileged_grant privileged_grants[LUMEN_PRIVILEGED_GRANTS];
};

enum lumen_login_result {
  LUMEN_LOGIN_OK = 0,
  LUMEN_LOGIN_INVALID,
  LUMEN_LOGIN_TOTP_INVALID,
  LUMEN_LOGIN_LOCKED,
  LUMEN_LOGIN_MFA_REQUIRED,
  LUMEN_LOGIN_ERROR,
};

int lumen_auth_load(const char *path, struct lumen_auth **result, char *error, size_t error_len);
void lumen_auth_free(struct lumen_auth *auth);

bool lumen_auth_host_allowed(struct lumen_auth *auth, struct lws *wsi);
bool lumen_auth_request_user(struct lumen_auth *auth, struct lws *wsi, char *user, size_t user_len);
bool lumen_auth_request_user_session(struct lumen_auth *auth, struct lws *wsi, char *user, size_t user_len,
                                     char *session_id, size_t session_id_len);
bool lumen_auth_session_active(struct lumen_auth *auth, const char *session_id, bool touch);
bool lumen_auth_revoke_request_session(struct lumen_auth *auth, struct lws *wsi);
bool lumen_auth_origin_valid(struct lumen_auth *auth, const char *origin, const char *host);
void lumen_auth_client_key(struct lumen_auth *auth, struct lws *wsi, char *client, size_t client_len);

enum lumen_login_result lumen_auth_login(struct lumen_auth *auth, const char *client, const char *username,
                                         const char *password, const char *totp, int64_t *retry_after);
void lumen_auth_audit(struct lumen_auth *auth, const char *event, const char *client, const char *detail);
char *lumen_auth_audit_list(struct lumen_auth *auth, size_t limit);
bool lumen_auth_ws_admit(struct lumen_auth *auth, const char *client);
void lumen_auth_ws_connected(struct lumen_auth *auth, const char *client);
void lumen_auth_ws_disconnected(struct lumen_auth *auth, const char *client);
char *lumen_auth_passkey_options(struct lumen_auth *auth, const char *client, bool registration);
bool lumen_auth_passkey_register(struct lumen_auth *auth, const char *client, const char *json);
bool lumen_auth_passkey_login(struct lumen_auth *auth, const char *client, const char *json);
bool lumen_auth_passkey_step_up(struct lumen_auth *auth, const char *client, const char *json);
bool lumen_auth_has_passkeys(struct lumen_auth *auth);
char *lumen_auth_passkey_list(struct lumen_auth *auth);
bool lumen_auth_passkey_delete(struct lumen_auth *auth, const char *client, const char *encoded_id);
bool lumen_auth_passkey_rename(struct lumen_auth *auth, const char *client, const char *encoded_id,
                               const char *name);
char *lumen_auth_totp_begin(struct lumen_auth *auth, const char *client);
bool lumen_auth_totp_confirm(struct lumen_auth *auth, const char *client, const char *code);
bool lumen_auth_totp_remove(struct lumen_auth *auth, const char *client, const char *code);
bool lumen_auth_totp_enabled(struct lumen_auth *auth);
bool lumen_auth_totp_verify(struct lumen_auth *auth, const char *code);
bool lumen_auth_issue_privileged_grant(struct lumen_auth *auth, const char *auth_session,
                                       const char *terminal_id, bool create, char token[65]);
bool lumen_auth_consume_privileged_grant(struct lumen_auth *auth, const char *auth_session,
                                         const char *terminal_id, const char *token, bool *create);
char *lumen_auth_preferences_get(struct lumen_auth *auth, uint64_t *version);
bool lumen_auth_preferences_set(struct lumen_auth *auth, const char *json, bool *conflict);
void lumen_auth_privileged_preferences(struct lumen_auth *auth, unsigned int default_max_sessions,
                                        unsigned int default_idle_seconds,
                                        unsigned int *max_sessions, unsigned int *idle_seconds,
                                        bool *require_verification);

int lumen_auth_new_session_cookie(struct lumen_auth *auth, char *header, size_t header_len);
int lumen_auth_clear_session_cookie(struct lumen_auth *auth, char *header, size_t header_len);
int lumen_auth_new_csrf(struct lumen_auth *auth, char *token, size_t token_len, char *header, size_t header_len);
int lumen_auth_clear_csrf_cookie(struct lumen_auth *auth, char *header, size_t header_len);
bool lumen_auth_cookie_value(const char *cookies, const char *name, char *value, size_t value_len);
const char *lumen_auth_session_cookie_name(const struct lumen_auth *auth);
const char *lumen_auth_csrf_cookie_name(const struct lumen_auth *auth);

#endif
