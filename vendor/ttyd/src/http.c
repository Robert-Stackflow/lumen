#include <libwebsockets.h>
#include <json-c/json.h>
#include <openssl/crypto.h>
#include <qrencode.h>
#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/statvfs.h>
#include <sys/sysinfo.h>
#include <time.h>
#include <unistd.h>
#include <zlib.h>

#include "html.h"
#include "server.h"
#include "utils.h"

enum { AUTH_OK, AUTH_FAIL, AUTH_ERROR };

static char *html_cache = NULL;
static size_t html_cache_len = 0;
static time_t http_started_at;

static const char security_headers[] =
    "Cache-Control: no-store\r\n"
    "Pragma: no-cache\r\n"
    "X-Content-Type-Options: nosniff\r\n"
    "X-Frame-Options: DENY\r\n"
    "Referrer-Policy: no-referrer\r\n"
    "Cross-Origin-Opener-Policy: same-origin\r\n"
    "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\r\n"
    "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    "connect-src 'self' ws: wss:; img-src data:; font-src 'self'; base-uri 'none'; form-action 'self'; "
    "frame-ancestors 'none'\r\n";

static int add_named_header(struct lws *wsi, const char *name, const char *value, unsigned char **p,
                            unsigned char *end) {
  return lws_add_http_header_by_name(wsi, (const unsigned char *)name, (const unsigned char *)value,
                                     (int)strlen(value), p, end);
}

static int add_security_headers(struct lws *wsi, unsigned char **p, unsigned char *end) {
  return add_named_header(wsi, "cache-control:", "no-store", p, end) ||
         add_named_header(wsi, "pragma:", "no-cache", p, end) ||
         add_named_header(wsi, "x-content-type-options:", "nosniff", p, end) ||
         add_named_header(wsi, "x-frame-options:", "DENY", p, end) ||
         add_named_header(wsi, "referrer-policy:", "no-referrer", p, end) ||
         add_named_header(wsi, "cross-origin-opener-policy:", "same-origin", p, end) ||
         add_named_header(wsi, "permissions-policy:", "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
                          p, end) ||
         add_named_header(wsi, "content-security-policy:",
                          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                          "connect-src 'self' ws: wss:; img-src data:; font-src 'self'; base-uri 'none'; "
                          "form-action 'self'; frame-ancestors 'none'",
                          p, end);
}

static int add_cookie_line(struct lws *wsi, const char *line, unsigned char **p, unsigned char *end) {
  static const char prefix[] = "Set-Cookie: ";
  if (!line || strncmp(line, prefix, sizeof(prefix) - 1)) return 0;
  const char *value = line + sizeof(prefix) - 1;
  const char *line_end = strstr(value, "\r\n");
  size_t len = line_end ? (size_t)(line_end - value) : strlen(value);
  return lws_add_http_header_by_name(wsi, (const unsigned char *)"set-cookie:", (const unsigned char *)value,
                                     (int)len, p, end);
}

static int send_empty(struct lws *wsi, unsigned int status, const char *location, const char *cookie_one,
                      const char *cookie_two) {
  unsigned char buffer[4096 + LWS_PRE], *p = buffer + LWS_PRE, *end = buffer + sizeof(buffer);
  if (lws_add_http_header_status(wsi, status, &p, end) || add_security_headers(wsi, &p, end) ||
      (location && lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_LOCATION, (const unsigned char *)location,
                                                (int)strlen(location), &p, end)) ||
      add_cookie_line(wsi, cookie_one, &p, end) || add_cookie_line(wsi, cookie_two, &p, end) ||
      lws_add_http_header_content_length(wsi, 0, &p, end) || lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
    return 1;
  return lws_http_transaction_completed(wsi) ? -1 : 0;
}

static int send_text(struct lws *wsi, struct pss_http *pss, unsigned int status, const char *content_type,
                     char *body, size_t body_len, bool owns_body, const char *cookie, int64_t retry_after) {
  unsigned char buffer[4096 + LWS_PRE], *p = buffer + LWS_PRE, *end = buffer + sizeof(buffer);
  char retry[32];
  snprintf(retry, sizeof(retry), "%lld", (long long)retry_after);
  if (lws_add_http_header_status(wsi, status, &p, end) ||
      lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_TYPE, (const unsigned char *)content_type,
                                   (int)strlen(content_type), &p, end) ||
      add_security_headers(wsi, &p, end) || add_cookie_line(wsi, cookie, &p, end) ||
      (retry_after > 0 && add_named_header(wsi, "retry-after:", retry, &p, end)) ||
      lws_add_http_header_content_length(wsi, (unsigned long)body_len, &p, end) ||
      lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0) {
    if (owns_body) free(body);
    return 1;
  }
  pss->buffer = pss->ptr = body;
  pss->len = body_len;
  pss->owns_buffer = owns_body;
  pss->response_pending = true;
  lws_callback_on_writable(wsi);
  return 0;
}

static int send_unauthorized(struct lws *wsi, unsigned int code, enum lws_token_indexes header) {
  unsigned char buffer[2048 + LWS_PRE], *p = buffer + LWS_PRE, *end = buffer + sizeof(buffer);
  if (lws_add_http_header_status(wsi, code, &p, end) ||
      lws_add_http_header_by_token(wsi, header, (unsigned char *)"Basic realm=\"Lumen\"", 19, &p, end) ||
      add_security_headers(wsi, &p, end) || lws_add_http_header_content_length(wsi, 0, &p, end) ||
      lws_finalize_http_header(wsi, &p, end) ||
      lws_write(wsi, buffer + LWS_PRE, p - (buffer + LWS_PRE), LWS_WRITE_HTTP_HEADERS) < 0)
    return AUTH_FAIL;
  return lws_http_transaction_completed(wsi) ? AUTH_FAIL : AUTH_ERROR;
}

static int check_auth(struct lws *wsi) {
  if (server->auth != NULL) {
    char user[65] = "";
    if (lumen_auth_request_user(server->auth, wsi, user, sizeof(user))) return AUTH_OK;
    if (server->auth->mode == LUMEN_AUTH_PROXY)
      return send_unauthorized(wsi, HTTP_STATUS_PROXY_AUTH_REQUIRED, WSI_TOKEN_HTTP_PROXY_AUTHENTICATE);
    return AUTH_FAIL;
  }
  if (server->auth_header != NULL) {
    if (lws_hdr_custom_length(wsi, server->auth_header, strlen(server->auth_header)) > 0) return AUTH_OK;
    return send_unauthorized(wsi, HTTP_STATUS_PROXY_AUTH_REQUIRED, WSI_TOKEN_HTTP_PROXY_AUTHENTICATE);
  }
  if (server->credential != NULL) {
    char buf[256];
    int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_AUTHORIZATION);
    if (len >= 7 && strstr(buf, "Basic ") && !strcmp(buf + 6, server->credential)) return AUTH_OK;
    return send_unauthorized(wsi, HTTP_STATUS_UNAUTHORIZED, WSI_TOKEN_HTTP_WWW_AUTHENTICATE);
  }
  return AUTH_OK;
}

static bool accept_gzip(struct lws *wsi) {
  char buf[256];
  int len = lws_hdr_copy(wsi, buf, sizeof(buf), WSI_TOKEN_HTTP_ACCEPT_ENCODING);
  return len > 0 && strstr(buf, "gzip") != NULL;
}

static bool uncompress_html(char **output, size_t *output_len) {
  if (html_cache == NULL || html_cache_len == 0) {
    z_stream stream;
    memset(&stream, 0, sizeof(stream));
    if (inflateInit2(&stream, 16 + 15) != Z_OK) return false;
    html_cache_len = index_html_size;
    html_cache = xmalloc(html_cache_len);
    stream.avail_in = index_html_len;
    stream.avail_out = html_cache_len;
    stream.next_in = (void *)index_html;
    stream.next_out = (void *)html_cache;
    int ret = inflate(&stream, Z_SYNC_FLUSH);
    inflateEnd(&stream);
    if (ret != Z_STREAM_END) {
      free(html_cache);
      html_cache = NULL;
      html_cache_len = 0;
      return false;
    }
  }
  *output = html_cache;
  *output_len = html_cache_len;
  return true;
}

static void pss_buffer_free(struct pss_http *pss) {
  if (pss->buffer && pss->owns_buffer) free(pss->buffer);
  pss->buffer = NULL;
  pss->ptr = NULL;
  pss->len = 0;
  pss->owns_buffer = false;
  pss->response_pending = false;
}

static void pss_cookies_free(struct pss_http *pss) {
  if (pss->cookies) {
    OPENSSL_cleanse(pss->cookies, pss->cookies_len);
    free(pss->cookies);
  }
  pss->cookies = NULL;
  pss->cookies_len = 0;
}

static bool copy_cookie_header(struct lws *wsi, struct pss_http *pss) {
  int length = lws_hdr_total_length(wsi, WSI_TOKEN_HTTP_COOKIE);
  if (length <= 0) return true;
  if (length > 65535) return false;

  pss->cookies = xmalloc((size_t)length + 1);
  pss->cookies_len = (size_t)length + 1;
  int copied = lws_hdr_copy(wsi, pss->cookies, length + 1, WSI_TOKEN_HTTP_COOKIE);
  if (copied != length) {
    pss_cookies_free(pss);
    return false;
  }
  return true;
}

static void access_log(struct lws *wsi, const char *path) {
  char rip[64];
  lws_get_peer_simple(lws_get_network_wsi(wsi), rip, sizeof(rip));
  lwsl_notice("HTTP %s - %s\n", path, rip);
}

static void endpoint_path(char *target, size_t target_len, const char *name) {
  snprintf(target, target_len, "%s/%s", endpoints.parent, name);
}

static bool valid_session_id(const char *session_id) {
  size_t len = strlen(session_id);
  if (len == 0 || len > 32 || !((session_id[0] >= 'a' && session_id[0] <= 'z') ||
                                 (session_id[0] >= '0' && session_id[0] <= '9')))
    return false;
  for (size_t i = 1; i < len; i++) {
    char value = session_id[i];
    if (!((value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') || value == '-')) return false;
  }
  return true;
}

static bool privileged_session_id(const char *session_id) {
  return session_id && strlen(session_id) == 6 && !strncmp(session_id, "root-", 5) &&
         session_id[5] >= '1' && session_id[5] <= '8';
}

static bool action_request_valid(struct lws *wsi, const char *expected_action) {
  char action[32] = "", origin[512] = "", host[256] = "";
  if (lws_hdr_custom_copy(wsi, action, sizeof(action), "x-lumen-action:", 15) <= 0 ||
      strcmp(action, expected_action))
    return false;
  lws_hdr_copy(wsi, origin, sizeof(origin), WSI_TOKEN_ORIGIN);
  lws_hdr_copy(wsi, host, sizeof(host), WSI_TOKEN_HOST);
  if (!origin[0] || !strcmp(origin, "null")) return false;
  if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION)
    return lumen_auth_origin_valid(server->auth, origin, host);

  const char *separator = strstr(origin, "://");
  if (!separator) return false;
  size_t scheme_len = (size_t)(separator - origin);
  if (!((scheme_len == 4 && !strncasecmp(origin, "http", 4)) ||
        (scheme_len == 5 && !strncasecmp(origin, "https", 5))))
    return false;
  const char *authority = separator + 3;
  const char *end = strchr(authority, '/');
  size_t authority_len = end ? (size_t)(end - authority) : strlen(authority);
  return authority_len == strlen(host) && !strncasecmp(authority, host, authority_len);
}

static int session_control(const char *operation, const char *session_id) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    execl(server->command, server->command, operation, session_id, (char *)NULL);
    _exit(127);
  }

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return -1;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static int disconnect_client(const char *session_id, const char *connection_id) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    if (privileged_session_id(session_id)) {
      const char *socket = getenv("LUMEN_ROOT_PTY_SOCKET");
      setenv("LUMEN_PTY_SOCKET", socket && socket[0] ? socket : "/run/lumen-root-terminal/pty.sock", 1);
    }
    execl(server->command, server->command, "--disconnect", connection_id, (char *)NULL);
    _exit(127);
  }
  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return -1;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static char *list_sessions_from_socket(const char *socket_path, size_t *output_len) {
  int fds[2];
  if (pipe(fds) != 0) return NULL;
  pid_t pid = fork();
  if (pid < 0) {
    close(fds[0]);
    close(fds[1]);
    return NULL;
  }
  if (pid == 0) {
    close(fds[0]);
    if (dup2(fds[1], STDOUT_FILENO) < 0) _exit(127);
    close(fds[1]);
    if (socket_path && socket_path[0]) setenv("LUMEN_PTY_SOCKET", socket_path, 1);
    execl(server->command, server->command, "--list-json", (char *)NULL);
    _exit(127);
  }
  close(fds[1]);
  size_t used = 0, capacity = 4096;
  char *body = malloc(capacity);
  if (!body) {
    close(fds[0]);
    waitpid(pid, NULL, 0);
    return NULL;
  }
  for (;;) {
    if (used == capacity) {
      if (capacity >= 65536) break;
      capacity *= 2;
      char *next = realloc(body, capacity);
      if (!next) break;
      body = next;
    }
    ssize_t count = read(fds[0], body + used, capacity - used);
    if (count > 0) {
      used += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    break;
  }
  close(fds[0]);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0 || used == 0 || used > 65536) {
    free(body);
    return NULL;
  }
  *output_len = used;
  return body;
}

static char *list_sessions(size_t *output_len) {
  const char *normal_socket = getenv("LUMEN_PTY_SOCKET");
  const char *root_socket = getenv("LUMEN_ROOT_PTY_SOCKET");
  size_t normal_len = 0, root_len = 0;
  char *normal = list_sessions_from_socket(
      normal_socket && normal_socket[0] ? normal_socket : "/run/lumen-terminal/pty.sock", &normal_len);
  char *root = list_sessions_from_socket(
      root_socket && root_socket[0] ? root_socket : "/run/lumen-root-terminal/pty.sock", &root_len);
  if (!normal && !root) return NULL;
  if (!normal) {
    *output_len = root_len;
    return root;
  }
  if (!root) {
    *output_len = normal_len;
    return normal;
  }
  bool normal_items = normal_len > 2;
  bool root_items = root_len > 2;
  size_t combined_len = normal_len + root_len - 2 + (normal_items && root_items ? 1 : 0);
  char *combined = malloc(combined_len + 1);
  if (!combined) {
    free(normal);
    free(root);
    return NULL;
  }
  size_t used = 0;
  combined[used++] = '[';
  if (normal_items) {
    memcpy(combined + used, normal + 1, normal_len - 2);
    used += normal_len - 2;
  }
  if (normal_items && root_items) combined[used++] = ',';
  if (root_items) {
    memcpy(combined + used, root + 1, root_len - 2);
    used += root_len - 2;
  }
  combined[used++] = ']';
  combined[used] = '\0';
  free(normal);
  free(root);
  *output_len = used;
  return combined;
}

static unsigned int configured_root_max_sessions(bool *require_verification) {
  const char *configured = getenv("LUMEN_ROOT_MAX_SESSIONS");
  unsigned int fallback = configured ? (unsigned int)strtoul(configured, NULL, 10) : 2;
  if (fallback < 1 || fallback > 8) fallback = 2;
  unsigned int maximum = fallback;
  lumen_auth_privileged_preferences(server->auth, fallback, &maximum, require_verification);
  return maximum;
}

static bool privileged_capacity_available(const char *terminal_id, unsigned int maximum,
                                           bool *already_exists_out) {
  size_t length = 0;
  char *inventory = list_sessions(&length);
  if (!inventory) return false;
  json_object *sessions = json_tokener_parse(inventory);
  free(inventory);
  if (!sessions || !json_object_is_type(sessions, json_type_array)) {
    if (sessions) json_object_put(sessions);
    return false;
  }
  unsigned int count = 0;
  bool already_exists = false;
  for (size_t index = 0; index < json_object_array_length(sessions); index++) {
    json_object *item = json_object_array_get_idx(sessions, index);
    json_object *id = NULL, *privileged = NULL;
    if (!json_object_is_type(item, json_type_object) ||
        !json_object_object_get_ex(item, "id", &id) ||
        !json_object_is_type(id, json_type_string))
      continue;
    const char *session_id = json_object_get_string(id);
    bool is_privileged = privileged_session_id(session_id);
    if (json_object_object_get_ex(item, "privileged", &privileged) &&
        json_object_is_type(privileged, json_type_boolean))
      is_privileged = json_object_get_boolean(privileged);
    if (!is_privileged) continue;
    count++;
    if (!strcmp(session_id, terminal_id)) already_exists = true;
  }
  json_object_put(sessions);
  if (already_exists_out) *already_exists_out = already_exists;
  return already_exists || count < maximum;
}

static char *replace_template_token(char *source, const char *token, const char *value) {
  size_t source_len = strlen(source), token_len = strlen(token), value_len = strlen(value), count = 0;
  for (char *p = source; (p = strstr(p, token)); p += token_len) count++;
  if (!count) return source;
  size_t output_len = source_len - count * token_len + count * value_len;
  char *output = xmalloc(output_len + 1), *target = output;
  const char *cursor = source, *match;
  while ((match = strstr(cursor, token))) {
    size_t prefix = (size_t)(match - cursor);
    memcpy(target, cursor, prefix);
    target += prefix;
    memcpy(target, value, value_len);
    target += value_len;
    cursor = match + token_len;
  }
  strcpy(target, cursor);
  free(source);
  return output;
}

static char *render_login_file(const char *csrf, const char *message, bool locked,
                               size_t *output_len) {
  const char *path = getenv("LUMEN_LOGIN_TEMPLATE");
  if (!path || !path[0]) return NULL;
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  if (fseek(file, 0, SEEK_END) != 0) {
    fclose(file);
    return NULL;
  }
  long length = ftell(file);
  if (length <= 0 || length > 131072 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return NULL;
  }
  char *page = xmalloc((size_t)length + 1);
  if (fread(page, 1, (size_t)length, file) != (size_t)length) {
    fclose(file);
    free(page);
    return NULL;
  }
  fclose(file);
  page[length] = '\0';
  const char *totp_field = lumen_auth_totp_enabled(server->auth)
                               ? "<label for=\"totp\">动态验证码</label><input id=\"totp\" name=\"totp\" "
                                 "type=\"text\" autocomplete=\"one-time-code\" inputmode=\"numeric\" "
                                 "pattern=\"[0-9]{6}\" maxlength=\"6\" placeholder=\"输入 6 位动态码\">"
                               : "<input name=\"totp\" type=\"hidden\" value=\"\">";
  page = replace_template_token(page, "{{BASE_PATH}}", endpoints.parent);
  page = replace_template_token(page, "{{CSRF}}", csrf);
  page = replace_template_token(page, "{{TOTP_FIELD}}", totp_field);
  page = replace_template_token(page, "{{ERROR_CLASS}}", message && *message ? " error-visible" : "");
  page = replace_template_token(page, "{{ERROR_MESSAGE}}", message ? message : "");
  page = replace_template_token(page, "{{BUTTON_DISABLED}}", locked ? " disabled" : "");
  page = replace_template_token(page, "{{BUTTON_TEXT}}", locked ? "请稍后重试" : "登录");
  page = replace_template_token(page, "{{PASSKEY_HIDDEN}}",
                                lumen_auth_has_passkeys(server->auth) ? "" : " hidden");
  *output_len = strlen(page);
  return page;
}

static char *render_login(const char *csrf, const char *message, bool locked, size_t *output_len) {
  char *external = render_login_file(csrf, message, locked, output_len);
  if (external) return external;
  const char *error_class = message && *message ? " error-visible" : "";
  const char *button = locked ? "请稍后重试" : "登录";
  const char *disabled = locked ? " disabled" : "";
  const char *totp_field = lumen_auth_totp_enabled(server->auth)
                               ? "<label for=\"totp\">动态验证码</label><input id=\"totp\" name=\"totp\" "
                                 "type=\"text\" autocomplete=\"one-time-code\" inputmode=\"numeric\" "
                                 "pattern=\"[0-9]{6}\" maxlength=\"6\" placeholder=\"输入 6 位动态码\">"
                               : "<input name=\"totp\" type=\"hidden\" value=\"\">";
  const char *template =
      "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
      "<meta name=\"color-scheme\" content=\"dark light\"><meta name=\"referrer\" content=\"no-referrer\">"
      "<title>登录 · Lumen</title><style>"
      ":root{color-scheme:dark;--bg:#10111a;--card:#191925;--field:#1d1d2b;--hover:#242435;"
      "--line:rgba(205,214,244,.11);--text:#cdd6f4;--strong:#eef1fb;--muted:#8b90a7;--green:#a6e3a1;"
      "--blue:#89b4fa;--red:#f38ba8;--button-text:#151722;--shadow:rgba(0,0,0,.36)}"
      "@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#eff1f5;--card:#e8ebf1;--field:#dfe3eb;"
      "--hover:#dce0e8;--line:rgba(76,79,105,.14);--text:#4c4f69;--strong:#303247;--muted:#6c6f85;"
      "--green:#40a02b;--blue:#1e66f5;--red:#d20f39;--button-text:#fff;--shadow:rgba(76,79,105,.15)}}"
      "*{box-sizing:border-box}[hidden]{display:none!important}body{position:relative;margin:0;min-height:100dvh;display:grid;place-items:center;"
      "overflow:hidden;padding:24px;background:var(--bg);color:var(--text);font-family:ui-sans-serif,-apple-system,"
      "BlinkMacSystemFont,\"Segoe UI\",sans-serif;-webkit-font-smoothing:antialiased}body:before{content:\"\";"
      "position:fixed;z-index:0;top:-220px;left:50%%;width:min(760px,90vw);height:420px;border-radius:50%%;"
      "background:color-mix(in srgb,var(--blue) 10%%,transparent);filter:blur(90px);transform:translateX(-50%%);"
      "pointer-events:none}.wrap{position:relative;z-index:1;width:min(100%%,400px)}.brand{display:flex;"
      "align-items:center;gap:11px;margin:0 0 18px 4px}.brand-copy{display:grid;gap:4px}.brand strong{color:"
      "var(--strong);font:650 12px/1 ui-monospace,\"SFMono-Regular\",Menlo,monospace;letter-spacing:.08em;"
      "text-transform:uppercase}.brand small{color:var(--muted);font-size:10px;letter-spacing:.04em}.mark{position:"
      "relative;width:24px;height:24px;border-radius:8px;background:linear-gradient(145deg,var(--hover),var(--field));"
      "box-shadow:inset 0 0 0 1px var(--line),0 5px 16px var(--shadow)}.mark:before{content:\"\";position:absolute;"
      "left:7px;top:7px;width:6px;height:6px;border-right:2px solid var(--green);border-bottom:2px solid var(--green);"
      "transform:rotate(-45deg)}.mark:after{content:\"\";position:absolute;right:5px;bottom:5px;width:6px;height:2px;"
      "border-radius:2px;background:var(--green);box-shadow:0 0 8px color-mix(in srgb,var(--green) 35%%,transparent)}"
      ".card{padding:30px;border:1px solid var(--line);border-radius:18px;background:color-mix(in srgb,var(--card) "
      "96%%,transparent);box-shadow:0 26px 80px var(--shadow),inset 0 1px 0 rgba(255,255,255,.025);"
      "backdrop-filter:blur(22px) saturate(120%%)}.eyebrow{display:flex;align-items:center;gap:7px;margin:0 0 13px;"
      "color:var(--muted);font:600 10px/1 ui-monospace,\"SFMono-Regular\",Menlo,monospace;letter-spacing:.08em;"
      "text-transform:uppercase}.eyebrow:before{content:\"\";width:6px;height:6px;border-radius:50%%;background:"
      "var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 10%%,transparent)}h1{margin:0;color:"
      "var(--strong);font-size:22px;line-height:1.3;font-weight:680;letter-spacing:-.035em}p{margin:7px 0 25px;"
      "color:var(--muted);font-size:13px;line-height:1.65}label{display:block;margin:0 0 7px;color:var(--muted);"
      "font-size:12px;font-weight:520}input{width:100%%;height:44px;margin:0 0 17px;padding:0 13px;border:1px solid "
      "var(--line);border-radius:10px;outline:none;background:var(--field);color:var(--strong);font:500 14px/1 "
      "ui-monospace,\"SFMono-Regular\",\"Cascadia Code\",Menlo,monospace;transition:border-color .14s,box-shadow .14s,"
      "background-color .14s}input::placeholder{color:color-mix(in srgb,var(--muted) 72%%,transparent);opacity:1;"
      "font-weight:450;letter-spacing:0}input:focus::placeholder{color:color-mix(in srgb,var(--muted) 54%%,"
      "transparent)}input:hover{background:var(--hover)}input:focus{border-color:var(--blue);background:"
      "var(--field);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 16%%,transparent)}button{width:100%%;"
      "height:44px;border:1px solid color-mix(in srgb,var(--green) 70%%,transparent);border-radius:10px;"
      "background:var(--green);color:var(--button-text);font-size:13px;font-weight:700;letter-spacing:.01em;"
      "cursor:pointer;box-shadow:0 8px 24px "
      "color-mix(in srgb,var(--green) 12%%,transparent);transition:filter .14s,transform .1s}button:hover{filter:"
      "brightness(1.045)}button:active{transform:scale(.992)}button:disabled{opacity:.55;cursor:not-allowed}.error{"
      "display:none;margin:-2px 0 17px;padding:10px 11px;border:1px solid color-mix(in srgb,var(--red) 28%%,"
      "transparent);border-radius:9px;background:color-mix(in srgb,var(--red) 8%%,transparent);color:var(--red);"
      "font-size:12px;line-height:1.5}.error-visible{display:block}.note{margin:17px 2px 0;text-align:center;color:"
      "var(--muted);font-size:11px;line-height:1.6}@media(max-width:480px){body{padding:18px}.card{padding:25px 21px}}"
      "@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}</style></head><body>"
      "<main class=\"wrap\"><div class=\"brand\"><span class=\"mark\" aria-hidden=\"true\"></span>"
      "<span class=\"brand-copy\"><strong>lumen</strong><small>persistent web terminal</small></span></div>"
      "<section class=\"card\"><div class=\"eyebrow\">Secure session</div><h1>继续你的终端</h1>"
      "<p>登录后，此设备会安全地保持会话，回来即可继续工作。</p>"
      "<form method=\"post\" action=\"%s/auth/login\" autocomplete=\"on\"><input type=\"hidden\" name=\"csrf\" "
      "value=\"%s\"><label for=\"username\">账号</label><input id=\"username\" name=\"username\" type=\"text\" "
      "autocomplete=\"username\" autocapitalize=\"none\" spellcheck=\"false\" maxlength=\"64\" required "
      "autofocus><label for=\"password\">密码</label><input id=\"password\" name=\"password\" type=\"password\" "
      "autocomplete=\"current-password\" maxlength=\"128\" required>%s<div class=\"error%s\" role=\"alert\">%s"
      "</div>"
      "<button type=\"submit\"%s>%s</button></form><button id=\"passkey\"%s type=\"button\" style=\"margin-top:10px;"
      "background:transparent;color:var(--strong);border-color:var(--line);box-shadow:none\">使用通行密钥</button>"
      "</section><div class=\"note\">安全会话仅保存在当前浏览器 · Lumen 不会保存明文密码</div></main>"
      "<script>const cv=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/').padEnd("
      "s.length+(4-s.length%%4)%%4,'=')),c=>c.charCodeAt(0));const vc=b=>btoa(String.fromCharCode(...new "
      "Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');document.getElementById("
      "'passkey').onclick=async()=>{try{const o=await fetch('%s/auth/passkey/options',{credentials:'same-origin'}"
      ").then(r=>r.json());o.challenge=cv(o.challenge);o.allowCredentials=o.allowCredentials.map(x=>({...x,id:"
      "cv(x.id)}));const c=await navigator.credentials.get({publicKey:o});const body={id:vc(c.rawId),clientDataJSON:"
      "vc(c.response.clientDataJSON),authenticatorData:vc(c.response.authenticatorData),signature:vc(c.response."
      "signature)};const r=await fetch('%s/auth/passkey/login',{method:'POST',credentials:'same-origin',headers:{"
      "'Content-Type':'application/json'},body:JSON.stringify(body)});if(r.ok||r.status===303)location.href='%s/';"
      "else throw Error();}catch(e){alert('通行密钥验证失败，请重试。')}};</script></body></html>";

  size_t needed = strlen(template) + strlen(endpoints.parent) + strlen(csrf) + strlen(totp_field) + strlen(error_class) +
                  (message ? strlen(message) : 0) + strlen(disabled) + strlen(button) +
                  strlen(endpoints.parent) * 3 + 256;
  char *output = xmalloc(needed);
  const char *passkey_visibility = lumen_auth_has_passkeys(server->auth) ? "" : " hidden";
  int written = snprintf(output, needed, template, endpoints.parent, csrf, totp_field, error_class, message ? message : "",
                         disabled, button, passkey_visibility, endpoints.parent, endpoints.parent, endpoints.parent);
  if (written < 0 || (size_t)written >= needed) {
    free(output);
    return NULL;
  }
  *output_len = (size_t)written;
  return output;
}

static int serve_login(struct lws *wsi, struct pss_http *pss, unsigned int status, const char *message, bool locked,
                       int64_t retry_after) {
  char csrf[65], cookie[512];
  if (lumen_auth_new_csrf(server->auth, csrf, sizeof(csrf), cookie, sizeof(cookie)) < 0) return 1;
  size_t body_len = 0;
  char *body = render_login(csrf, message, locked, &body_len);
  if (!body) return 1;
  return send_text(wsi, pss, status, "text/html;charset=utf-8", body, body_len, true, cookie, retry_after);
}

static bool url_decode(const char *source, size_t source_len, char *target, size_t target_len) {
  size_t written = 0;
  for (size_t i = 0; i < source_len; i++) {
    unsigned char value = (unsigned char)source[i];
    if (value == '+') {
      value = ' ';
    } else if (value == '%') {
      if (i + 2 >= source_len) return false;
      char hex[3] = {source[i + 1], source[i + 2], '\0'};
      char *end = NULL;
      long decoded = strtol(hex, &end, 16);
      if (!end || *end || decoded <= 0 || decoded > 255) return false;
      value = (unsigned char)decoded;
      i += 2;
    }
    if (written + 1 >= target_len) return false;
    target[written++] = (char)value;
  }
  target[written] = '\0';
  return true;
}

static bool form_value(const char *body, const char *name, char *target, size_t target_len) {
  size_t name_len = strlen(name);
  const char *cursor = body;
  bool found = false;
  while (*cursor) {
    const char *end = strchr(cursor, '&');
    if (!end) end = cursor + strlen(cursor);
    const char *equals = memchr(cursor, '=', (size_t)(end - cursor));
    if (equals && (size_t)(equals - cursor) == name_len && !strncmp(cursor, name, name_len)) {
      if (found || !url_decode(equals + 1, (size_t)(end - equals - 1), target, target_len)) return false;
      found = true;
    }
    cursor = *end ? end + 1 : end;
  }
  return found;
}

static bool csrf_valid(struct pss_http *pss, const char *submitted, bool *cookie_found, bool *token_matches,
                       bool *origin_matches) {
  char expected[65] = "";
  *cookie_found = lumen_auth_cookie_value(pss->cookies, lumen_auth_csrf_cookie_name(server->auth), expected,
                                          sizeof(expected));
  *token_matches = *cookie_found && strlen(expected) == strlen(submitted) &&
                   CRYPTO_memcmp(expected, submitted, strlen(expected)) == 0;
  // Some privacy-preserving browser contexts serialize a trustworthy form POST
  // origin as "null". The matching 256-bit double-submit token remains the
  // authorization signal in that case; non-null origins must still be same-origin.
  *origin_matches = !strcmp(pss->origin, "null") || lumen_auth_origin_valid(server->auth, pss->origin, pss->host);
  return *token_matches && *origin_matches;
}

static int complete_login(struct lws *wsi, struct pss_http *pss) {
  char username[65] = "", password[129] = "", totp[7] = "", csrf[65] = "";
  bool body_valid = pss->buffer && pss->body_len <= 2048;
  bool username_valid = body_valid && form_value(pss->buffer, "username", username, sizeof(username));
  bool password_valid = body_valid && form_value(pss->buffer, "password", password, sizeof(password));
  bool totp_valid = body_valid && form_value(pss->buffer, "totp", totp, sizeof(totp));
  bool submitted_csrf_valid = body_valid && form_value(pss->buffer, "csrf", csrf, sizeof(csrf));
  bool parsed = username_valid && password_valid && totp_valid && submitted_csrf_valid;
  bool cookie_found = false, token_matches = false, origin_matches = false;
  bool request_valid =
      parsed && csrf_valid(pss, csrf, &cookie_found, &token_matches, &origin_matches);
  size_t cookie_bytes = pss->cookies_len ? pss->cookies_len - 1 : 0;
  pss_cookies_free(pss);

  int64_t retry_after = 0;
  enum lumen_login_result result = request_valid
                                       ? lumen_auth_login(server->auth, pss->client, username, password, totp,
                                                          &retry_after)
                                       : LUMEN_LOGIN_ERROR;
  if (pss->buffer) {
    OPENSSL_cleanse(pss->buffer, pss->body_len);
    pss_buffer_free(pss);
  }
  OPENSSL_cleanse(password, sizeof(password));

  if (!request_valid) {
    lwsl_warn("LOGIN rejected validation - %s (body=%d user=%d pass=%d csrf=%d cookie=%d match=%d origin=%d "
              "cookie-bytes=%zu origin-bytes=%zu host-bytes=%zu)\n",
              pss->client, body_valid, username_valid, password_valid, submitted_csrf_valid, cookie_found,
              token_matches, origin_matches, cookie_bytes, strlen(pss->origin), strlen(pss->host));
    return serve_login(wsi, pss, HTTP_STATUS_BAD_REQUEST,
                       "登录页面已过期，或浏览器阻止了 Cookie。请刷新页面后重试。", false, 0);
  }
  if (result == LUMEN_LOGIN_OK) {
    char session_cookie[512], csrf_cookie[512];
    if (lumen_auth_new_session_cookie(server->auth, session_cookie, sizeof(session_cookie)) < 0 ||
        lumen_auth_clear_csrf_cookie(server->auth, csrf_cookie, sizeof(csrf_cookie)) < 0)
      return 1;
    lwsl_notice("LOGIN success - %s\n", pss->client);
    lumen_auth_audit(server->auth, "login_success", pss->client, "session");
    return send_empty(wsi, HTTP_STATUS_SEE_OTHER, endpoints.index, session_cookie, csrf_cookie);
  }
  if (result == LUMEN_LOGIN_LOCKED) {
    lwsl_warn("LOGIN locked - %s\n", pss->client);
    lumen_auth_audit(server->auth, "login_locked", pss->client, "rate-limit");
    return serve_login(wsi, pss, 429, "尝试次数过多，请稍后再试。", true, retry_after);
  }
  lwsl_warn("LOGIN failed - %s\n", pss->client);
  const bool totp_failed = result == LUMEN_LOGIN_TOTP_INVALID;
  const bool mfa_required = result == LUMEN_LOGIN_MFA_REQUIRED;
  lumen_auth_audit(server->auth, "login_failed", pss->client,
                   mfa_required ? "mfa-required" : (totp_failed ? "totp" : "credentials"));
  return serve_login(wsi, pss, HTTP_STATUS_UNAUTHORIZED,
                     mfa_required ? "密码登录已禁用，请使用通行密钥登录。"
                                  : (totp_failed ? "动态验证码不正确，请重新输入。"
                                                 : "账号或密码不正确，请重试。"),
                     false, retry_after);
}

static int complete_passkey(struct lws *wsi, struct pss_http *pss, bool registration) {
  bool ok = pss->buffer && pss->body_len <= 16384 &&
            (registration ? lumen_auth_passkey_register(server->auth, pss->client, pss->buffer)
                          : lumen_auth_passkey_login(server->auth, pss->client, pss->buffer));
  if (pss->buffer) {
    OPENSSL_cleanse(pss->buffer, pss->body_len);
    pss_buffer_free(pss);
  }
  if (!ok) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
  if (registration) return send_empty(wsi, 204, NULL, NULL, NULL);
  char session_cookie[512];
  if (lumen_auth_new_session_cookie(server->auth, session_cookie, sizeof(session_cookie)) < 0) return 1;
  return send_empty(wsi, HTTP_STATUS_SEE_OTHER, endpoints.index, session_cookie, NULL);
}

static int complete_totp_confirm(struct lws *wsi, struct pss_http *pss) {
  char code[7] = "";
  bool valid = pss->buffer && pss->body_len <= 256 && form_value(pss->buffer, "code", code, sizeof(code)) &&
               lumen_auth_totp_confirm(server->auth, pss->client, code);
  if (pss->buffer) {
    OPENSSL_cleanse(pss->buffer, pss->body_len);
    pss_buffer_free(pss);
  }
  OPENSSL_cleanse(code, sizeof(code));
  return send_empty(wsi, valid ? 204 : HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
}

static int complete_privileged_grant(struct lws *wsi, struct pss_http *pss, const char *method) {
  unsigned int maximum = configured_root_max_sessions(NULL);
  bool already_exists = false;
  if (!privileged_capacity_available(pss->terminal_id, maximum, &already_exists)) {
    lumen_auth_audit(server->auth, "privileged_session_rejected", pss->client,
                     "root-session-limit");
    return send_empty(wsi, HTTP_STATUS_CONFLICT, NULL, NULL, NULL);
  }
  pss->privileged_create = !already_exists;
  char grant[65] = "";
  if (!lumen_auth_issue_privileged_grant(server->auth, pss->auth_session,
                                          pss->terminal_id, pss->privileged_create, grant))
    return send_empty(wsi, HTTP_STATUS_SERVICE_UNAVAILABLE, NULL, NULL, NULL);
  lumen_auth_audit(server->auth, "privileged_authorized", pss->client, method);
  char *body = malloc(128);
  if (!body) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
  int written = snprintf(body, 128, "{\"grant\":\"%s\",\"expiresIn\":90}", grant);
  OPENSSL_cleanse(grant, sizeof(grant));
  return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                   body, (size_t)written, true, NULL, 0);
}

static int complete_privileged_authorization(struct lws *wsi, struct pss_http *pss, bool passkey) {
  char code[7] = "";
  bool verified = pss->buffer && pss->body_len <= 16384 &&
                  (passkey ? lumen_auth_passkey_step_up(server->auth, pss->client, pss->buffer)
                           : (form_value(pss->buffer, "code", code, sizeof(code)) &&
                              lumen_auth_totp_verify(server->auth, code)));
  if (pss->buffer) {
    OPENSSL_cleanse(pss->buffer, pss->body_len);
    pss_buffer_free(pss);
  }
  OPENSSL_cleanse(code, sizeof(code));
  if (!verified) {
    lumen_auth_audit(server->auth, "privileged_authorization_failed", pss->client,
                     passkey ? "passkey" : "totp");
    return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
  }
  return complete_privileged_grant(wsi, pss, passkey ? "passkey" : "totp");
}

static int complete_passkey_rename(struct lws *wsi, struct pss_http *pss) {
  char prefix[128], name[64] = "";
  endpoint_path(prefix, sizeof(prefix), "api/passkeys/");
  const char *credential_id = !strncmp(pss->path, prefix, strlen(prefix)) ? pss->path + strlen(prefix) : "";
  bool valid = pss->buffer && pss->body_len <= 512 && form_value(pss->buffer, "name", name, sizeof(name)) &&
               lumen_auth_passkey_rename(server->auth, pss->client, credential_id, name);
  if (pss->buffer) {
    OPENSSL_cleanse(pss->buffer, pss->body_len);
    pss_buffer_free(pss);
  }
  return send_empty(wsi, valid ? 204 : HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
}

static int complete_preferences(struct lws *wsi, struct pss_http *pss) {
  bool conflict = false;
  bool saved = pss->buffer && pss->body_len <= 131072 &&
               lumen_auth_preferences_set(server->auth, pss->buffer, &conflict);
  if (saved) lumen_auth_audit(server->auth, "preferences_updated", pss->client, "patch");
  pss_buffer_free(pss);
  if (saved) {
    uint64_t version = 0;
    char *preferences = lumen_auth_preferences_get(server->auth, &version);
    free(preferences);
    char *body = malloc(64);
    if (!body) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
    int length = snprintf(body, 64, "{\"version\":\"%llu\"}", (unsigned long long)version);
    return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                     body, (size_t)length, true, NULL, 0);
  }
  return send_empty(wsi, conflict ? 409 : HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
}

static char *totp_setup_json(const char *uri) {
  QRcode *code = QRcode_encodeString(uri, 0, QR_ECLEVEL_M, QR_MODE_8, 1);
  if (!code || code->width <= 0 || code->width > 128) {
    QRcode_free(code);
    return NULL;
  }
  size_t needed = strlen(uri) + (size_t)code->width * ((size_t)code->width + 4) + 64;
  char *json = malloc(needed);
  if (!json) {
    QRcode_free(code);
    return NULL;
  }
  char *cursor = json;
  cursor += sprintf(cursor, "{\"uri\":\"%s\",\"matrix\":[", uri);
  for (int row = 0; row < code->width; row++) {
    if (row) *cursor++ = ',';
    *cursor++ = '"';
    for (int column = 0; column < code->width; column++)
      *cursor++ = code->data[row * code->width + column] & 1 ? '1' : '0';
    *cursor++ = '"';
  }
  memcpy(cursor, "]}", 3);
  QRcode_free(code);
  return json;
}

int callback_http(struct lws *wsi, enum lws_callback_reasons reason, void *user, void *in, size_t len) {
  struct pss_http *pss = (struct pss_http *)user;
  unsigned char buffer[4096 + LWS_PRE], *p, *end;
  char buf[512];
  bool done = false;

  switch (reason) {
    case LWS_CALLBACK_HTTP: {
      pss_buffer_free(pss);
      pss_cookies_free(pss);
      memset(pss, 0, sizeof(*pss));
      access_log(wsi, (const char *)in);
      snprintf(pss->path, sizeof(pss->path), "%s", (const char *)in);
      if (!http_started_at) http_started_at = time(NULL);

      char login_path[128], login_action[128], logout_action[128], passkey_options[128], passkey_login[128],
          passkeys_api[128], passkey_api[128], passkey_register_options[128], passkey_register[128],
          preferences_api[128], audit_api[128], totp_api[128], totp_setup[128], totp_confirm[128], session_api[128],
          sessions_api[128], health_api[128], healthz[128], privileged_methods[128],
          privileged_authorize[128], privileged_totp[128], privileged_passkey_options[128],
          privileged_passkey_verify[128];
      endpoint_path(login_path, sizeof(login_path), "login");
      endpoint_path(login_action, sizeof(login_action), "auth/login");
      endpoint_path(logout_action, sizeof(logout_action), "auth/logout");
      endpoint_path(passkey_options, sizeof(passkey_options), "auth/passkey/options");
      endpoint_path(passkey_login, sizeof(passkey_login), "auth/passkey/login");
      endpoint_path(passkeys_api, sizeof(passkeys_api), "api/passkeys");
      endpoint_path(passkey_api, sizeof(passkey_api), "api/passkeys/");
      endpoint_path(passkey_register_options, sizeof(passkey_register_options), "api/passkeys/register/options");
      endpoint_path(passkey_register, sizeof(passkey_register), "api/passkeys/register");
      endpoint_path(preferences_api, sizeof(preferences_api), "api/preferences");
      endpoint_path(audit_api, sizeof(audit_api), "api/audit-log");
      endpoint_path(totp_setup, sizeof(totp_setup), "api/totp/setup");
      endpoint_path(totp_api, sizeof(totp_api), "api/totp");
      endpoint_path(totp_confirm, sizeof(totp_confirm), "api/totp/confirm");
      endpoint_path(session_api, sizeof(session_api), "api/sessions/");
      endpoint_path(sessions_api, sizeof(sessions_api), "api/sessions");
      endpoint_path(health_api, sizeof(health_api), "api/health");
      endpoint_path(healthz, sizeof(healthz), "healthz");
      endpoint_path(privileged_methods, sizeof(privileged_methods), "api/privileged/methods");
      endpoint_path(privileged_authorize, sizeof(privileged_authorize), "api/privileged/authorize");
      endpoint_path(privileged_totp, sizeof(privileged_totp), "api/privileged/authorize/totp");
      endpoint_path(privileged_passkey_options, sizeof(privileged_passkey_options),
                    "api/privileged/passkey/options");
      endpoint_path(privileged_passkey_verify, sizeof(privileged_passkey_verify),
                    "api/privileged/passkey/verify");
      char *uri = NULL;
      int uri_len = 0;
      int method = lws_http_get_uri_and_method(wsi, &uri, &uri_len);

      if (!strcmp(pss->path, healthz)) {
        if (method != LWSHUMETH_GET)
          return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        char *body = strdup("{\"status\":\"ok\"}");
        return body ? send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                                body, strlen(body), true, NULL, 0)
                    : send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
      }

      if (!strcmp(pss->path, privileged_methods)) {
        if (method != LWSHUMETH_GET) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
        char *body = malloc(160);
        if (!body) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        const char *idle_seconds = getenv("LUMEN_ROOT_IDLE_SESSION_SECONDS");
        bool require_verification = true;
        unsigned int root_max = configured_root_max_sessions(&require_verification);
        unsigned int root_idle = idle_seconds ? (unsigned int)strtoul(idle_seconds, NULL, 10) : 1800;
        if (root_idle < 300 || root_idle > 86400) root_idle = 1800;
        int written = snprintf(body, 160,
                               "{\"totp\":%s,\"passkey\":%s,\"maxSessions\":%u,\"idleSeconds\":%u,"
                               "\"requireVerification\":%s}",
                               lumen_auth_totp_enabled(server->auth) ? "true" : "false",
                               lumen_auth_has_passkeys(server->auth) ? "true" : "false",
                               root_max, root_idle, require_verification ? "true" : "false");
        return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                         body, (size_t)written, true, NULL, 0);
      }

      if (!strcmp(pss->path, privileged_authorize)) {
        if (method != LWSHUMETH_POST)
          return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        char user[65] = "";
        if (!lumen_auth_request_user_session(server->auth, wsi, user, sizeof(user),
                                             pss->auth_session, sizeof(pss->auth_session)))
          return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
        if (!action_request_valid(wsi, "privileged-authorize"))
          return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
        if (lws_hdr_custom_copy(wsi, pss->terminal_id, sizeof(pss->terminal_id),
                                "x-lumen-session:", 16) <= 0 ||
            !privileged_session_id(pss->terminal_id))
          return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
        bool require_verification = true;
        configured_root_max_sessions(&require_verification);
        if (require_verification)
          return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
        char mode[16] = "";
        lws_hdr_custom_copy(wsi, mode, sizeof(mode), "x-lumen-mode:", 13);
        pss->privileged_create = !strcmp(mode, "create");
        lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
        return complete_privileged_grant(wsi, pss, "policy-bypass");
      }

      if (!strcmp(pss->path, privileged_passkey_options)) {
        if (method != LWSHUMETH_GET) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
        if (!lumen_auth_has_passkeys(server->auth))
          return send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
        char client[64] = "";
        lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
        char *body = lumen_auth_passkey_options(server->auth, client, false);
        return body ? send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                                body, strlen(body), true, NULL, 0)
                    : send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
      }

      if (!strcmp(pss->path, privileged_totp) || !strcmp(pss->path, privileged_passkey_verify)) {
        bool passkey = !strcmp(pss->path, privileged_passkey_verify);
        if (method != LWSHUMETH_POST) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        char user[65] = "";
        if (!lumen_auth_request_user_session(server->auth, wsi, user, sizeof(user),
                                             pss->auth_session, sizeof(pss->auth_session)))
          return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
        if (!action_request_valid(wsi, "privileged-authorize"))
          return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
        if (lws_hdr_custom_copy(wsi, pss->terminal_id, sizeof(pss->terminal_id),
                                "x-lumen-session:", 16) <= 0 ||
            !privileged_session_id(pss->terminal_id))
          return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
        char mode[16] = "";
        lws_hdr_custom_copy(wsi, mode, sizeof(mode), "x-lumen-mode:", 13);
        pss->privileged_create = !strcmp(mode, "create");
        lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
        pss->login_post = true;
        pss->auth_action = passkey ? 8 : 7;
        return 0;
      }
      if (!strcmp(pss->path, health_api)) {
        if (method != LWSHUMETH_GET)
          return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        int auth_result = check_auth(wsi);
        if (auth_result != AUTH_OK)
          return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
        struct timespec pty_started, pty_finished;
        clock_gettime(CLOCK_MONOTONIC, &pty_started);
        size_t inventory_len = 0;
        char *inventory = list_sessions(&inventory_len);
        clock_gettime(CLOCK_MONOTONIC, &pty_finished);
        if (!inventory) return send_empty(wsi, HTTP_STATUS_SERVICE_UNAVAILABLE, NULL, NULL, NULL);
        unsigned int sessions = 0, connections = 0;
        for (char *cursor = inventory; (cursor = strstr(cursor, "\"pid\":")); cursor += 6) sessions++;
        for (char *cursor = inventory; (cursor = strstr(cursor, "\"clients\":")); cursor += 10)
          connections += (unsigned int)strtoul(cursor + 10, NULL, 10);
        free(inventory);
        long long pty_latency_ms =
            (pty_finished.tv_sec - pty_started.tv_sec) * 1000LL
            + (pty_finished.tv_nsec - pty_started.tv_nsec) / 1000000LL;
        struct sysinfo system_info = {0};
        struct statvfs disk_info = {0};
        sysinfo(&system_info);
        statvfs("/", &disk_info);
        unsigned long web_pages = 0, web_resident = 0;
        FILE *statm = fopen("/proc/self/statm", "r");
        if (statm) {
          if (fscanf(statm, "%lu %lu", &web_pages, &web_resident) != 2)
            web_resident = 0;
          fclose(statm);
        }
        unsigned long long memory_total =
            (unsigned long long)system_info.totalram * system_info.mem_unit;
        unsigned long long memory_available =
            (unsigned long long)system_info.freeram * system_info.mem_unit;
        FILE *meminfo = fopen("/proc/meminfo", "r");
        if (meminfo) {
          char key[64], unit[16];
          unsigned long long value = 0;
          while (fscanf(meminfo, "%63s %llu %15s", key, &value, unit) == 3) {
            if (!strcmp(key, "MemAvailable:")) {
              memory_available = value * 1024;
              break;
            }
          }
          fclose(meminfo);
        }
        unsigned long long disk_total =
            (unsigned long long)disk_info.f_blocks * disk_info.f_frsize;
        unsigned long long disk_available =
            (unsigned long long)disk_info.f_bavail * disk_info.f_frsize;
        unsigned long web_memory_kb =
            web_resident * (unsigned long)sysconf(_SC_PAGESIZE) / 1024;
        char *body = malloc(768);
        if (!body) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        int written = snprintf(body, 768,
                               "{\"status\":\"ok\",\"version\":\"%s\","
                               "\"web\":{\"status\":\"ok\",\"uptimeSeconds\":%lld,\"memoryKb\":%lu},"
                               "\"pty\":{\"status\":\"ok\",\"sessions\":%u,\"latencyMs\":%lld},"
                               "\"websocket\":{\"status\":\"ok\",\"connections\":%u},"
                               "\"tmux\":{\"status\":\"%s\",\"sessions\":%u},"
                               "\"memory\":{\"usedBytes\":%llu,\"totalBytes\":%llu},"
                               "\"disk\":{\"usedBytes\":%llu,\"totalBytes\":%llu}}",
                               TTYD_VERSION, (long long)(time(NULL) - http_started_at),
                               web_memory_kb, sessions, pty_latency_ms, connections,
                               sessions ? "ok" : "idle", sessions,
                               memory_total - memory_available, memory_total,
                               disk_total - disk_available, disk_total);
        if (written < 0 || written >= 768) {
          free(body);
          return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        }
        return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                         body, (size_t)written, true, NULL, 0);
      }

      size_t session_api_len = strlen(session_api);
      if (!strcmp(pss->path, sessions_api)) {
        if (method != LWSHUMETH_GET)
          return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        int auth_result = check_auth(wsi);
        if (auth_result != AUTH_OK) {
          if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION)
            return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          return auth_result == AUTH_FAIL ? 0 : 1;
        }
        size_t body_len = 0;
        char *body = list_sessions(&body_len);
        if (!body) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                         body, body_len, true, NULL, 0);
      }
      if (!strcmp(pss->path, audit_api)) {
        if (method != LWSHUMETH_GET)
          return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        if (check_auth(wsi) != AUTH_OK)
          return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
        char *entries = lumen_auth_audit_list(server->auth, 200);
        if (!entries) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        size_t body_size = strlen(entries) + 160;
        char *body = malloc(body_size);
        if (!body) {
          free(entries);
          return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        }
        int written = snprintf(body, body_size,
                               "{\"entries\":%s,\"policy\":{\"maxBytes\":%lld,\"retentionFiles\":%d}}",
                               entries, (long long)server->auth->audit_max_bytes,
                               server->auth->audit_retention_files);
        free(entries);
        if (written < 0 || (size_t)written >= body_size) {
          free(body);
          return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        }
        return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8",
                         body, (size_t)written, true, NULL, 0);
      }
      if (!strncmp(pss->path, session_api, session_api_len)) {
        const char *session_id = pss->path + session_api_len;
        const char *connections = strstr(session_id, "/connections/");
        if (connections) {
          size_t id_len = (size_t)(connections - session_id);
          const char *connection_id = connections + strlen("/connections/");
          char id[33] = "";
          if (id_len == 0 || id_len >= sizeof(id) || !connection_id[0])
            return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
          memcpy(id, session_id, id_len);
          for (const char *p = connection_id; *p; p++)
            if (*p < '0' || *p > '9') return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
          if (!valid_session_id(id) || method != LWSHUMETH_POST)
            return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          int auth_result = check_auth(wsi);
          if (auth_result != AUTH_OK)
            return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (!action_request_valid(wsi, "disconnect"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          int result = disconnect_client(id, connection_id);
          char client[64] = "";
          lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
          if (result == 0) {
            lumen_auth_audit(server->auth, "connection_disconnected", client, id);
            return send_empty(wsi, 204, NULL, NULL, NULL);
          }
          if (result == 3) return send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
          return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        }
        if (method != LWSHUMETH_POST)
          return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        if (!valid_session_id(session_id)) return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);

        int auth_result = check_auth(wsi);
        if (auth_result != AUTH_OK) {
          if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION)
            return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          return auth_result == AUTH_FAIL ? 0 : 1;
        }
        char action[32] = "";
        if (lws_hdr_custom_copy(wsi, action, sizeof(action), "x-lumen-action:", 15) <= 0)
          return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
        const char *operation = NULL;
        const char *audit_event = NULL;
        if (!strcmp(action, "terminate") && action_request_valid(wsi, "terminate")) {
          operation = "--kill";
          audit_event = "session_terminated";
        } else if (!strcmp(action, "terminate-force") && action_request_valid(wsi, "terminate-force")) {
          operation = "--kill-force";
          audit_event = "session_terminated";
        } else if (!strcmp(action, "protect") && action_request_valid(wsi, "protect")) {
          if (privileged_session_id(session_id))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          operation = "--protect";
          audit_event = "session_protected";
        } else if (!strcmp(action, "unprotect") && action_request_valid(wsi, "unprotect")) {
          operation = "--unprotect";
          audit_event = "session_unprotected";
        } else {
          return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
        }

        int result = session_control(operation, session_id);
        char client[64] = "";
        lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
        if (result == 0) {
          lwsl_notice("SESSION action %s %s - %s\n", action, session_id, client);
          if (privileged_session_id(session_id) && !strncmp(action, "terminate", 9))
            audit_event = "privileged_session_terminated";
          lumen_auth_audit(server->auth, audit_event, client, session_id);
          return send_empty(wsi, 204, NULL, NULL, NULL);
        }
        if (result == 3) return send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
        if (result == 5) return send_empty(wsi, HTTP_STATUS_CONFLICT, NULL, NULL, NULL);
        lwsl_err("SESSION termination failed %s - %s (status=%d)\n", session_id, client, result);
        return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
      }

      if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION) {
        if (!lumen_auth_host_allowed(server->auth, wsi)) {
          return send_empty(wsi, 421, NULL, NULL, NULL);
        }

        if (!strcmp(pss->path, login_action)) {
          if (method != LWSHUMETH_POST) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          pss->login_post = true;
          pss->auth_action = 1;
          if (!copy_cookie_header(wsi, pss)) {
            lwsl_warn("LOGIN rejected oversized or unreadable Cookie header\n");
            return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
          }
          lws_hdr_copy(wsi, pss->origin, sizeof(pss->origin), WSI_TOKEN_ORIGIN);
          lws_hdr_copy(wsi, pss->host, sizeof(pss->host), WSI_TOKEN_HOST);
          lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
          return 0;
        }

        if (!strcmp(pss->path, passkey_options)) {
          if (method != LWSHUMETH_GET) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (!lumen_auth_has_passkeys(server->auth))
            return send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
          char client[64] = "";
          lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
          char *body = lumen_auth_passkey_options(server->auth, client, false);
          return body ? send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", body, strlen(body),
                                  true, NULL, 0)
                      : send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        }

        if (!strcmp(pss->path, passkey_login)) {
          if (method != LWSHUMETH_POST) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          pss->login_post = true;
          pss->auth_action = 2;
          lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
          return 0;
        }

        if (!strcmp(pss->path, passkey_register_options)) {
          if (method != LWSHUMETH_GET) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          char client[64] = "";
          lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
          char *body = lumen_auth_passkey_options(server->auth, client, true);
          return body ? send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", body, strlen(body),
                                  true, NULL, 0)
                      : send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        }

        if (!strcmp(pss->path, passkeys_api)) {
          if (method != LWSHUMETH_GET) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          char *body = lumen_auth_passkey_list(server->auth);
          return body ? send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", body, strlen(body),
                                  true, NULL, 0)
                      : send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
        }

        size_t passkey_api_len = strlen(passkey_api);
        if (strcmp(pss->path, passkey_register) && !strncmp(pss->path, passkey_api, passkey_api_len)) {
          const char *credential_id = pss->path + passkey_api_len;
          if (method != LWSHUMETH_DELETE && method != LWSHUMETH_PATCH)
            return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (!*credential_id || strlen(credential_id) > 700)
            return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (method == LWSHUMETH_PATCH) {
            if (!action_request_valid(wsi, "passkey-rename"))
              return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
            pss->login_post = true;
            pss->auth_action = 5;
            lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
            return 0;
          }
          if (!action_request_valid(wsi, "passkey-delete"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          char client[64] = "";
          lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
          return lumen_auth_passkey_delete(server->auth, client, credential_id)
                     ? send_empty(wsi, 204, NULL, NULL, NULL)
                     : send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
        }

        if (!strcmp(pss->path, passkey_register)) {
          if (method != LWSHUMETH_POST) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (!action_request_valid(wsi, "passkey-register"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          pss->login_post = true;
          pss->auth_action = 3;
          lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
          return 0;
        }

        if (!strcmp(pss->path, totp_setup)) {
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (method == LWSHUMETH_GET) {
            const char *body = lumen_auth_totp_enabled(server->auth) ? "{\"enabled\":true}" : "{\"enabled\":false}";
            return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", strdup(body), strlen(body),
                             true, NULL, 0);
          }
          if (method != LWSHUMETH_POST) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (!action_request_valid(wsi, "totp-setup"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          if (lumen_auth_totp_enabled(server->auth)) {
            const char *body = "{\"enabled\":true,\"alreadyEnabled\":true}";
            return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", strdup(body), strlen(body),
                             true, NULL, 0);
          }
          char client[64] = "";
          lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
          char *uri = lumen_auth_totp_begin(server->auth, client);
          if (!uri) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
          char *body = totp_setup_json(uri);
          free(uri);
          if (!body) return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
          return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", body, strlen(body), true,
                           NULL, 0);
        }

        if (!strcmp(pss->path, preferences_api)) {
          if (method != LWSHUMETH_GET && method != LWSHUMETH_PUT)
            return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (method == LWSHUMETH_GET) {
            uint64_t version = 0;
            char *raw = lumen_auth_preferences_get(server->auth, &version);
            json_object *preferences = raw ? json_tokener_parse(raw) : NULL;
            free(raw);
            if (!preferences || !json_object_is_type(preferences, json_type_object)) {
              if (preferences) json_object_put(preferences);
              return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
            }
            char version_text[32];
            snprintf(version_text, sizeof(version_text), "%llu", (unsigned long long)version);
            json_object_object_add(preferences, "_version", json_object_new_string(version_text));
            const char *serialized =
                json_object_to_json_string_ext(preferences, JSON_C_TO_STRING_PLAIN);
            char *body = strdup(serialized);
            json_object_put(preferences);
            return body ? send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", body, strlen(body),
                                    true, NULL, 0)
                        : send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
          }
          if (!action_request_valid(wsi, "preferences-update"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          pss->login_post = true;
          pss->auth_action = 6;
          return 0;
        }

        if (!strcmp(pss->path, totp_confirm)) {
          if (method != LWSHUMETH_POST) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (!action_request_valid(wsi, "totp-confirm"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          pss->login_post = true;
          pss->auth_action = 4;
          lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
          return 0;
        }

        if (!strcmp(pss->path, totp_api)) {
          if (method != LWSHUMETH_DELETE)
            return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (!action_request_valid(wsi, "totp-remove"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          char client[64] = "", code[7] = "";
          lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
          int copied = lws_hdr_custom_copy(wsi, code, sizeof(code), "x-lumen-totp-code:",
                                           strlen("x-lumen-totp-code:"));
          bool removed = copied == 6 && lumen_auth_totp_remove(server->auth, client, code);
          OPENSSL_cleanse(code, sizeof(code));
          return send_empty(wsi, removed ? 204 : HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
        }

        if (!strcmp(pss->path, logout_action)) {
          if (method != LWSHUMETH_POST)
            return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) != AUTH_OK)
            return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          if (!action_request_valid(wsi, "logout"))
            return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);
          if (!lumen_auth_revoke_request_session(server->auth, wsi))
            return send_empty(wsi, HTTP_STATUS_INTERNAL_SERVER_ERROR, NULL, NULL, NULL);
          char session_cookie[512];
          if (lumen_auth_clear_session_cookie(server->auth, session_cookie, sizeof(session_cookie)) < 0) return 1;
          char client[64] = "";
          lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
          lumen_auth_audit(server->auth, "logout", client, "session");
          return send_empty(wsi, HTTP_STATUS_SEE_OTHER, login_path, session_cookie, NULL);
        }

        if (!strcmp(pss->path, login_path)) {
          if (method != LWSHUMETH_GET) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) == AUTH_OK) {
            return send_empty(wsi, HTTP_STATUS_SEE_OTHER, endpoints.index, NULL, NULL);
          }
          return serve_login(wsi, pss, HTTP_STATUS_OK, "", false, 0);
        }

        if (check_auth(wsi) != AUTH_OK) return send_empty(wsi, HTTP_STATUS_SEE_OTHER, login_path, NULL, NULL);
      } else {
        switch (check_auth(wsi)) {
          case AUTH_OK:
            break;
          case AUTH_FAIL:
            return 0;
          case AUTH_ERROR:
          default:
            return 1;
        }
      }

      p = buffer + LWS_PRE;
      end = p + sizeof(buffer) - LWS_PRE;

      if (strcmp(pss->path, endpoints.token) == 0) {
        const char *credential = server->credential != NULL ? server->credential : "";
        size_t n = (size_t)snprintf(buf, sizeof(buf), "{\"token\":\"%s\"}", credential);
        return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", strdup(buf), n, true, NULL, 0);
      }

      if (strcmp(pss->path, endpoints.parent) == 0) {
        return send_empty(wsi, HTTP_STATUS_FOUND, endpoints.index, NULL, NULL);
      }

      if (strcmp(pss->path, endpoints.index) != 0) {
        return send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
      }

      const char *content_type = "text/html";
      if (server->index != NULL) {
        char headers[sizeof(security_headers) + 32];
        int header_len = snprintf(headers, sizeof(headers), "%s", security_headers);
        int n = lws_serve_http_file(wsi, server->index, content_type, headers, header_len);
        if (n < 0 || (n > 0 && lws_http_transaction_completed(wsi))) return 1;
      } else {
        char *output = (char *)index_html;
        size_t output_len = index_html_len;
#ifdef LWS_WITH_HTTP_STREAM_COMPRESSION
        if (!uncompress_html(&output, &output_len)) return 1;
#else
        if (accept_gzip(wsi)) {
          if (lws_add_http_header_by_token(wsi, WSI_TOKEN_HTTP_CONTENT_ENCODING, (unsigned char *)"gzip", 4, &p,
                                           end))
            return 1;
        } else if (!uncompress_html(&output, &output_len)) {
          return 1;
        }
#endif
        return send_text(wsi, pss, HTTP_STATUS_OK, content_type, output, output_len, false, NULL, 0);
      }
      break;
    }

    case LWS_CALLBACK_HTTP_BODY:
      if (pss->response_pending) return 0;
      if (!pss->login_post) return 1;
      if (pss->body_len + len > (pss->auth_action == 1 ? 2048U : 16384U)) {
        pss->body_len += len;
        return 0;
      }
      pss->buffer = xrealloc(pss->buffer, pss->body_len + len + 1);
      memcpy(pss->buffer + pss->body_len, in, len);
      pss->body_len += len;
      pss->buffer[pss->body_len] = '\0';
      pss->owns_buffer = true;
      return 0;

    case LWS_CALLBACK_HTTP_BODY_COMPLETION:
      if (pss->response_pending) return 0;
      if (!pss->login_post) return 1;
      if (pss->auth_action == 1) return complete_login(wsi, pss);
      if (pss->auth_action == 2) return complete_passkey(wsi, pss, false);
      if (pss->auth_action == 3) return complete_passkey(wsi, pss, true);
      if (pss->auth_action == 4) return complete_totp_confirm(wsi, pss);
      if (pss->auth_action == 5) return complete_passkey_rename(wsi, pss);
      if (pss->auth_action == 6) return complete_preferences(wsi, pss);
      if (pss->auth_action == 7) return complete_privileged_authorization(wsi, pss, false);
      if (pss->auth_action == 8) return complete_privileged_authorization(wsi, pss, true);
      return 1;

    case LWS_CALLBACK_HTTP_WRITEABLE:
      if (!pss->buffer || pss->len == 0) goto try_to_reuse;
      do {
        int n = sizeof(buffer) - LWS_PRE;
        int m = lws_get_peer_write_allowance(wsi);
        if (m == 0) {
          lws_callback_on_writable(wsi);
          return 0;
        } else if (m != -1 && m < n) {
          n = m;
        }
        size_t remaining = pss->len - (size_t)(pss->ptr - pss->buffer);
        if ((size_t)n >= remaining) {
          n = (int)remaining;
          done = true;
        }
        memcpy(buffer + LWS_PRE, pss->ptr, n);
        pss->ptr += n;
        enum lws_write_protocol protocol = done ? LWS_WRITE_HTTP_FINAL : LWS_WRITE_HTTP;
        if (lws_write(wsi, buffer + LWS_PRE, (size_t)n, protocol) < n) {
          pss_buffer_free(pss);
          return -1;
        }
      } while (!lws_send_pipe_choked(wsi) && !done);
      if (!done && pss->ptr < pss->buffer + pss->len) {
        lws_callback_on_writable(wsi);
        break;
      }
      pss_buffer_free(pss);
      goto try_to_reuse;

    case LWS_CALLBACK_HTTP_FILE_COMPLETION:
      goto try_to_reuse;

    case LWS_CALLBACK_CLOSED_HTTP:
      if (pss->buffer && pss->login_post) OPENSSL_cleanse(pss->buffer, pss->body_len);
      pss_buffer_free(pss);
      pss_cookies_free(pss);
      break;

#if (defined(LWS_OPENSSL_SUPPORT) || defined(LWS_WITH_TLS)) && !defined(LWS_WITH_MBEDTLS)
    case LWS_CALLBACK_OPENSSL_PERFORM_CLIENT_CERT_VERIFICATION:
      if (!len || (SSL_get_verify_result((SSL *)in) != X509_V_OK)) {
        int err = X509_STORE_CTX_get_error((X509_STORE_CTX *)user);
        int depth = X509_STORE_CTX_get_error_depth((X509_STORE_CTX *)user);
        const char *msg = X509_verify_cert_error_string(err);
        lwsl_err("client certificate verification error: %s (%d), depth: %d\n", msg, err, depth);
        return 1;
      }
      break;
#endif
    default:
      break;
  }
  return 0;

try_to_reuse:
  if (lws_http_transaction_completed(wsi)) return -1;
  return 0;
}
