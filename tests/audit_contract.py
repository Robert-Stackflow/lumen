#!/usr/bin/env python3
"""Contract checks for the authenticated audit-log API."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    http = (ROOT / "vendor/ttyd/src/http.c").read_text()
    auth = (ROOT / "vendor/ttyd/src/auth.c").read_text()
    page = (ROOT / "web/index.template.html").read_text()
    app = (ROOT / "web/app.js").read_text()

    assert 'endpoint_path(audit_api, sizeof(audit_api), "api/audit-log")' in http
    assert "check_auth(wsi) != AUTH_OK" in http
    assert "lumen_auth_audit_list(server->auth, 200)" in http
    assert '\\"retentionFiles\\"' in http
    assert '\\"maxBytes\\"' in http
    assert "size > 262144" in auth
    assert "limit > 500" in auth
    assert 'data-settings-tab="audit"' in page
    assert 'id="audit-retention-policy"' in page
    assert "credentials: 'same-origin'" in app
    print("audit log API and UI contract passed")


if __name__ == "__main__":
    main()
