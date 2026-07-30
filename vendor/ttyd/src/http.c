#include <libwebsockets.h>
#include <openssl/crypto.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#include <zlib.h>

#include "html.h"
#include "server.h"
#include "utils.h"

enum { AUTH_OK, AUTH_FAIL, AUTH_ERROR };

static char *html_cache = NULL;
static size_t html_cache_len = 0;

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

static bool terminate_request_valid(struct lws *wsi) {
  char action[32] = "", origin[512] = "", host[256] = "";
  if (lws_hdr_custom_copy(wsi, action, sizeof(action), "x-lumen-action:", 15) <= 0 ||
      strcmp(action, "terminate"))
    return false;
  lws_hdr_copy(wsi, origin, sizeof(origin), WSI_TOKEN_ORIGIN);
  lws_hdr_copy(wsi, host, sizeof(host), WSI_TOKEN_HOST);
  if (!strcmp(origin, "null")) return true;
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

static int terminate_session(const char *session_id) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    execl(server->command, server->command, "--kill", session_id, (char *)NULL);
    _exit(127);
  }

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return -1;
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static char *render_login(const char *csrf, const char *message, bool locked, size_t *output_len) {
  const char *error_class = message && *message ? " error-visible" : "";
  const char *button = locked ? "请稍后重试" : "登录";
  const char *disabled = locked ? " disabled" : "";
  const char *template =
      "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
      "<meta name=\"color-scheme\" content=\"dark light\"><meta name=\"referrer\" content=\"no-referrer\">"
      "<title>登录 · Lumen</title><style>"
      ":root{color-scheme:dark;--bg:#10111a;--card:#191925;--field:#1d1d2b;--hover:#242435;"
      "--line:rgba(205,214,244,.11);--text:#cdd6f4;--strong:#eef1fb;--muted:#8b90a7;--green:#a6e3a1;"
      "--blue:#89b4fa;--red:#f38ba8;--shadow:rgba(0,0,0,.36)}"
      "@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#eff1f5;--card:#e8ebf1;--field:#dfe3eb;"
      "--hover:#dce0e8;--line:rgba(76,79,105,.14);--text:#4c4f69;--strong:#303247;--muted:#6c6f85;"
      "--green:#40a02b;--blue:#1e66f5;--red:#d20f39;--shadow:rgba(76,79,105,.15)}}"
      "*{box-sizing:border-box}body{position:relative;margin:0;min-height:100dvh;display:grid;place-items:center;"
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
      "background-color .14s}input:hover{background:var(--hover)}input:focus{border-color:var(--blue);background:"
      "var(--field);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 16%%,transparent)}button{width:100%%;"
      "height:44px;border:1px solid color-mix(in srgb,var(--green) 70%%,transparent);border-radius:10px;"
      "background:var(--green);color:#10111a;font-size:13px;font-weight:720;cursor:pointer;box-shadow:0 8px 24px "
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
      "autocomplete=\"current-password\" maxlength=\"128\" required><div class=\"error%s\" role=\"alert\">%s"
      "</div><button type=\"submit\"%s>%s</button></form></section><div class=\"note\">安全会话仅保存在当前浏览器"
      " · Lumen 不会保存明文密码</div></main></body></html>";

  size_t needed = strlen(template) + strlen(endpoints.parent) + strlen(csrf) + strlen(error_class) +
                  (message ? strlen(message) : 0) + strlen(disabled) + strlen(button) + 64;
  char *output = xmalloc(needed);
  int written = snprintf(output, needed, template, endpoints.parent, csrf, error_class, message ? message : "",
                         disabled, button);
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
  char username[65] = "", password[129] = "", csrf[65] = "";
  bool body_valid = pss->buffer && pss->body_len <= 2048;
  bool username_valid = body_valid && form_value(pss->buffer, "username", username, sizeof(username));
  bool password_valid = body_valid && form_value(pss->buffer, "password", password, sizeof(password));
  bool submitted_csrf_valid = body_valid && form_value(pss->buffer, "csrf", csrf, sizeof(csrf));
  bool parsed = username_valid && password_valid && submitted_csrf_valid;
  bool cookie_found = false, token_matches = false, origin_matches = false;
  bool request_valid =
      parsed && csrf_valid(pss, csrf, &cookie_found, &token_matches, &origin_matches);
  size_t cookie_bytes = pss->cookies_len ? pss->cookies_len - 1 : 0;
  pss_cookies_free(pss);

  int64_t retry_after = 0;
  enum lumen_login_result result = request_valid
                                       ? lumen_auth_login(server->auth, pss->client, username, password, &retry_after)
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
    return send_empty(wsi, HTTP_STATUS_SEE_OTHER, endpoints.index, session_cookie, csrf_cookie);
  }
  if (result == LUMEN_LOGIN_LOCKED) {
    lwsl_warn("LOGIN locked - %s\n", pss->client);
    return serve_login(wsi, pss, 429, "尝试次数过多，请稍后再试。", true, retry_after);
  }
  lwsl_warn("LOGIN failed - %s\n", pss->client);
  return serve_login(wsi, pss, HTTP_STATUS_UNAUTHORIZED, "账号或密码不正确。", false, retry_after);
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

      char login_path[128], login_action[128], session_api[128];
      endpoint_path(login_path, sizeof(login_path), "login");
      endpoint_path(login_action, sizeof(login_action), "auth/login");
      endpoint_path(session_api, sizeof(session_api), "api/sessions/");
      char *uri = NULL;
      int uri_len = 0;
      int method = lws_http_get_uri_and_method(wsi, &uri, &uri_len);

      size_t session_api_len = strlen(session_api);
      if (!strncmp(pss->path, session_api, session_api_len)) {
        const char *session_id = pss->path + session_api_len;
        if (method != LWSHUMETH_POST)
          return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
        if (!valid_session_id(session_id)) return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);

        int auth_result = check_auth(wsi);
        if (auth_result != AUTH_OK) {
          if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION)
            return send_empty(wsi, HTTP_STATUS_UNAUTHORIZED, NULL, NULL, NULL);
          return auth_result == AUTH_FAIL ? 0 : 1;
        }
        if (!terminate_request_valid(wsi)) return send_empty(wsi, HTTP_STATUS_FORBIDDEN, NULL, NULL, NULL);

        int result = terminate_session(session_id);
        char client[64] = "";
        lumen_auth_client_key(server->auth, wsi, client, sizeof(client));
        if (result == 0) {
          lwsl_notice("SESSION terminated %s - %s\n", session_id, client);
          return send_empty(wsi, 204, NULL, NULL, NULL);
        }
        if (result == 3) return send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
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
          if (!copy_cookie_header(wsi, pss)) {
            lwsl_warn("LOGIN rejected oversized or unreadable Cookie header\n");
            return send_empty(wsi, HTTP_STATUS_BAD_REQUEST, NULL, NULL, NULL);
          }
          lws_hdr_copy(wsi, pss->origin, sizeof(pss->origin), WSI_TOKEN_ORIGIN);
          lws_hdr_copy(wsi, pss->host, sizeof(pss->host), WSI_TOKEN_HOST);
          lumen_auth_client_key(server->auth, wsi, pss->client, sizeof(pss->client));
          return 0;
        }

        if (!strcmp(pss->path, login_path)) {
          if (method != LWSHUMETH_GET) return send_empty(wsi, HTTP_STATUS_METHOD_NOT_ALLOWED, NULL, NULL, NULL);
          if (check_auth(wsi) == AUTH_OK) {
            char cookie[512];
            if (lumen_auth_new_session_cookie(server->auth, cookie, sizeof(cookie)) < 0) return 1;
            return send_empty(wsi, HTTP_STATUS_SEE_OTHER, endpoints.index, cookie, NULL);
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
        char cookie[512] = "";
        if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION &&
            lumen_auth_new_session_cookie(server->auth, cookie, sizeof(cookie)) < 0)
          return 1;
        return send_text(wsi, pss, HTTP_STATUS_OK, "application/json;charset=utf-8", strdup(buf), n, true, cookie, 0);
      }

      if (strcmp(pss->path, endpoints.parent) == 0) {
        char cookie[512] = "";
        if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION &&
            lumen_auth_new_session_cookie(server->auth, cookie, sizeof(cookie)) < 0)
          return 1;
        return send_empty(wsi, HTTP_STATUS_FOUND, endpoints.index, cookie, NULL);
      }

      if (strcmp(pss->path, endpoints.index) != 0) {
        return send_empty(wsi, HTTP_STATUS_NOT_FOUND, NULL, NULL, NULL);
      }

      const char *content_type = "text/html";
      char cookie[512] = "";
      if (server->auth && server->auth->mode == LUMEN_AUTH_SESSION &&
          lumen_auth_new_session_cookie(server->auth, cookie, sizeof(cookie)) < 0)
        return 1;
      if (server->index != NULL) {
        char headers[sizeof(security_headers) + sizeof(cookie) + 32];
        int header_len = snprintf(headers, sizeof(headers), "%s%s", security_headers, cookie);
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
        return send_text(wsi, pss, HTTP_STATUS_OK, content_type, output, output_len, false, cookie, 0);
      }
      break;
    }

    case LWS_CALLBACK_HTTP_BODY:
      if (!pss->login_post) return 1;
      if (pss->body_len + len > 2048) {
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
      if (!pss->login_post) return 1;
      return complete_login(wsi, pss);

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
        if (pss->ptr + n > pss->buffer + pss->len) {
          n = (int)(pss->len - (pss->ptr - pss->buffer));
          done = true;
        }
        memcpy(buffer + LWS_PRE, pss->ptr, n);
        pss->ptr += n;
        if (lws_write_http(wsi, buffer + LWS_PRE, (size_t)n) < n) {
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
