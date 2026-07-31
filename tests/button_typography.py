#!/usr/bin/env python3
"""Keep native and dynamically-created buttons on one typography system."""

from pathlib import Path


STYLES = (Path(__file__).resolve().parents[1] / "web" / "styles.css").read_text(
    encoding="utf-8"
)


def require(fragment: str, message: str) -> None:
    if fragment not in STYLES:
        raise AssertionError(message)


require(
    """button {
  color: inherit;
  font-size: 11px;
  font-weight: 560;
  line-height: 1;
  letter-spacing: 0;""",
    "all buttons must receive the shared typography baseline",
)
require(
    """.audit-actions button {
  min-height: 31px;""",
    "audit export actions must use the shared button component styling",
)
require(
    """.command-snippet-row button,
.command-snippet-editor button {""",
    "command snippet actions must share one typography rule",
)
require(
    ".settings-heading-actions > button",
    "grouped settings header buttons must match standalone header actions",
)

print("button typography contract passed")
