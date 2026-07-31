#!/usr/bin/env python3
"""Contract checks for session cleanup policy and diagnostics controls."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "web" / "index.template.html").read_text(encoding="utf-8")
app = (ROOT / "web" / "app.js").read_text(encoding="utf-8")
styles = (ROOT / "web" / "styles.css").read_text(encoding="utf-8")

for seconds in ("1800", "3600", "21600", "86400"):
    assert f'data-value="{seconds}"' in page
assert "idleCleanupSeconds" in app
assert "cleanupResourceSummary" in app
assert "memoryKb" in app and "historyBytes" in app
assert 'id="diagnostics-source-filter"' in page
assert 'id="copy-diagnostics"' in page
assert 'id="export-diagnostics"' in page
assert "LumenDiagnostics.serialize" in app
assert 'data-settings-tab="health"' in page
assert 'id="session-status-filter"' in page
assert 'id="protect-selected-sessions"' in page
assert 'id="terminate-selected-sessions"' in page
assert "refreshServiceHealth" in app
assert "copyServiceDiagnostics" in app
assert 'id="health-monitor-toggle"' in page
assert 'id="tab-session-popover"' in page
assert "renderTabSessionPopover" in app
assert "renderHealthMonitorPopover" in app
assert 'id="setting-root-max-sessions"' in page
assert 'id="setting-default-root-session"' in page
assert 'id="setting-root-require-verification"' in page
assert "rootMaxSessions" in app
assert "rootRequireVerification" in app
assert "isTerminalHandshakeResponse" in app
assert "method !== 'policy' && session.id !== activeId" in app
assert "session.privilegedMethods?.requireVerification === false" in app
assert "websocketReconnectCount" in app
assert "has-health-warning" in app
assert "flex: 0 0 46px" in styles
assert "setSessionProtected" in app
assert "terminate-force" in app
assert "!item.protected" in app
assert "session_protected" in (ROOT / "web" / "audit-log.js").read_text(encoding="utf-8")
tab_menu = app[app.index("function tabContextItems"):app.index("function terminalContextItems")]
assert tab_menu.count("{ separator: true }") >= 4

print("operations settings contract passed")
