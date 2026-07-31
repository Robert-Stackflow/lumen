#!/usr/bin/env python3
"""Contract checks for session cleanup policy and diagnostics controls."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
page = (ROOT / "web" / "index.template.html").read_text(encoding="utf-8")
app = (ROOT / "web" / "app.js").read_text(encoding="utf-8")

for seconds in ("1800", "3600", "21600", "86400"):
    assert f'data-value="{seconds}"' in page
assert "idleCleanupSeconds" in app
assert "cleanupResourceSummary" in app
assert "memoryKb" in app and "historyBytes" in app
assert 'id="diagnostics-source-filter"' in page
assert 'id="copy-diagnostics"' in page
assert 'id="export-diagnostics"' in page
assert "LumenDiagnostics.serialize" in app

print("operations settings contract passed")
