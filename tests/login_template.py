#!/usr/bin/env python3
"""Static contract for the externally rendered login page."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "web/login.template.html").read_text(encoding="utf-8")
fallback = (ROOT / "vendor/ttyd/src/http.c").read_text(encoding="utf-8")

required_tokens = {
    "{{BASE_PATH}}",
    "{{CSRF}}",
    "{{TOTP_FIELD}}",
    "{{ERROR_CLASS}}",
    "{{ERROR_MESSAGE}}",
    "{{BUTTON_DISABLED}}",
    "{{BUTTON_TEXT}}",
    "{{PASSKEY_HIDDEN}}",
}
for token in required_tokens:
    assert token in page, f"missing login token {token}"

assert page.index('name="password"') < page.index("{{TOTP_FIELD}}")
assert page.index("{{TOTP_FIELD}}") < page.index('role="alert"')
assert page.index('role="alert"') < page.index('type="submit"')
assert '[hidden]{display:none!important}' in page
assert "alert(" not in page
for removed_copy in (
    "persistent web terminal",
    "Secure session",
    "登录后，此设备会安全地保持会话，回来即可继续工作。",
    "安全会话仅保存在当前浏览器 · Lumen 不会保存明文密码",
):
    assert removed_copy not in page
    assert removed_copy not in fallback
print("login template contract passed")
