#!/usr/bin/env python3
"""Build the single-file UI consumed by ttyd's --index option."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
OUTPUT = ROOT / "dist" / "index.html"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def inline_script(path: Path) -> str:
    # An HTML parser ends an inline script at a literal closing tag, even when
    # that sequence appears inside JavaScript source.
    return read(path).replace("</script", r"<\/script")


def main() -> None:
    document = read(WEB / "index.template.html")
    replacements = {
        "/*__XTERM_CSS__*/": read(WEB / "vendor" / "xterm.css"),
        "/*__APP_CSS__*/": read(WEB / "styles.css"),
        "/*__XTERM_JS__*/": inline_script(WEB / "vendor" / "xterm.js"),
        "/*__FIT_JS__*/": inline_script(WEB / "vendor" / "addon-fit.js"),
        "/*__WEBGL_JS__*/": inline_script(WEB / "vendor" / "addon-webgl.js"),
        "/*__WEB_LINKS_JS__*/": inline_script(WEB / "vendor" / "addon-web-links.js"),
        "/*__APP_JS__*/": inline_script(WEB / "app.js"),
    }
    for marker, content in replacements.items():
        if marker not in document:
            raise RuntimeError(f"missing template marker: {marker}")
        document = document.replace(marker, content)
    if "/*__" in document:
        raise RuntimeError("unresolved build marker in generated document")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(document, encoding="utf-8")
    print(f"built {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
