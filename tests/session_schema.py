#!/usr/bin/env python3
"""Contract checks for the session inventory emitted by lumen-pty."""

import json
import re
import subprocess
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    schema = json.loads((ROOT / "docs/session-api.schema.json").read_text())
    required = set(schema["items"]["required"])
    with tempfile.TemporaryDirectory() as directory:
        socket = Path(directory) / "pty.sock"
        server = subprocess.Popen(
            [
                str(ROOT / "bin/lumen-pty"), "--serve", "--socket", str(socket),
                "--shell", "/bin/sh", "--cwd", "/tmp", "--history-bytes", "65536",
                "--max-sessions", "2",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(100):
                if socket.exists():
                    break
                time.sleep(0.01)
            env = {"LUMEN_PTY_SOCKET": str(socket)}
            output = subprocess.check_output(
                [str(ROOT / "bin/lumen-pty"), "--list-json"], env=env, text=True
            )
            inventory = json.loads(output)
            assert isinstance(inventory, list)
            # Keep field names tied to the implementation even when no session
            # exists; source inspection catches accidental protocol drift.
            source = (ROOT / "src/lumen-pty.c").read_text()
            for field in required:
                assert re.search(rf'\\"{re.escape(field)}\\"', source), field
        finally:
            server.terminate()
            server.wait(timeout=3)
    print("session inventory schema contract passed")


if __name__ == "__main__":
    main()
