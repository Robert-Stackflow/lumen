#!/usr/bin/env python3
"""Guard the terminal color behavior relied on by semantic TUIs."""

from pathlib import Path


APP = (Path(__file__).resolve().parents[1] / "web" / "app.js").read_text(
    encoding="utf-8"
)


def require(fragment: str, message: str) -> None:
    if fragment not in APP:
        raise AssertionError(message)


require(
    "light: 4.5,",
    "light mode must retain WCAG AA terminal text contrast protection",
)
require(
    "drawBoldTextInBrightColors: false",
    "bold text must not be remapped to bright ANSI colors",
)
require(
    "session.term.options.minimumContrastRatio = TERM_MINIMUM_CONTRAST[theme]",
    "live theme changes must update the terminal contrast policy",
)
require(
    "const next = { system: 'light', light: 'dark', dark: 'system' }[preference]",
    "the header theme button must cycle through device, light, and dark themes",
)
require(
    "followsSystemTheme = preference === 'system'",
    "appearance settings must support following the device theme",
)
require(
    "themeButton.dataset.themePreference = preference",
    "the header theme icon must reflect the selected preference",
)
require(
    "session.term.options.cursorBlink = false",
    "cursor blink changes must restart the xterm cursor timer",
)
