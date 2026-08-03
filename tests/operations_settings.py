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
assert 'id="health-monitor-toggle"' not in page
assert 'id="logout-toggle"' in page
assert 'id="logout-dialog"' in page
assert 'id="tab-session-popover"' in page
assert "renderTabSessionPopover" in app
assert 'class="settings-sidebar-label"' in page
assert 'data-settings-tab="dependencies"' in page
assert 'id="dependency-grid"' in page
assert "renderDependencyChecks" in app
assert 'id="setting-root-max-sessions"' in page
assert 'id="setting-root-idle-timeout"' in page
assert 'id="setting-default-root-session"' in page
assert 'id="setting-root-require-verification"' in page
assert "rootMaxSessions" in app
assert "rootIdleSessionSeconds" in app
assert "root 空闲会话将不会自动回收" in app
assert "rootRequireVerification" in app
assert 'data-value="fira"' in page
assert 'data-value="sourcecode"' in page
assert 'id="setting-theme"' in page
assert 'data-value="system">跟随设备' in page
assert '"Fira Code"' in app
assert '#setting-font-family' in styles
assert "isTerminalHandshakeResponse" in app
assert "method !== 'policy' && session.id !== activeId" in app
assert "session.privilegedMethods?.requireVerification === false" in app
assert "websocketReconnectCount" in app
assert "has-health-warning" in app
assert "flex: 0 0 46px" in styles
assert ".terminal-tab::after" not in styles
assert 'background: color-mix(in srgb, var(--surface-active) 78%, transparent)' in styles
assert "setSessionProtected" in app
assert "root 会话不支持保护，并始终受空闲回收策略约束" in app
assert "session.privileged ? '不适用 · 强制空闲回收'" in app
assert "session.protected = !session.privileged && Boolean(item?.protected)" in app
assert "session-root-policy-badge" in app and ".session-root-policy-badge" in styles
assert "terminate-force" in app
assert "!item.protected" in app
assert "session_protected" in (ROOT / "web" / "audit-log.js").read_text(encoding="utf-8")
tab_menu = app[app.index("function tabContextItems"):app.index("function terminalContextItems")]
assert tab_menu.count("{ separator: true }") >= 4

print("operations settings contract passed")
