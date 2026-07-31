#!/usr/bin/env python3
"""Keep placeholders consistent in the terminal UI and login page."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
styles = (ROOT / "web" / "styles.css").read_text(encoding="utf-8")
login = (ROOT / "web" / "login.template.html").read_text(encoding="utf-8")

for source, name in ((styles, "terminal UI"), (login, "login page")):
    if "::placeholder" not in source:
        raise AssertionError(f"{name} must define placeholder styling")
    for fragment in ("var(--muted)", "opacity: 1" if name == "terminal UI" else "opacity:1",
                     "font-weight: 450" if name == "terminal UI" else "font-weight:450"):
        if fragment not in source:
            raise AssertionError(f"{name} placeholder is missing {fragment}")

if "textarea::placeholder" not in styles:
    raise AssertionError("textarea placeholders must share the global input styling")
if "input:focus::placeholder" not in styles or "textarea:focus::placeholder" not in styles:
    raise AssertionError("focused placeholders must use the shared subdued state")

print("placeholder typography contract passed")
