#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
socket_path="$test_root/root.sock"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -f "$socket_path" "$test_root/server.log"
  rmdir "$test_root" 2>/dev/null || true
}
trap cleanup EXIT

LUMEN_SESSION_BACKEND=tmux "$project_dir/bin/lumen-pty" --serve --privileged \
  --socket "$socket_path" --shell /bin/sh --cwd "$test_root" \
  --history-bytes 65536 --max-sessions 2 --idle-timeout 30 \
  >"$test_root/server.log" 2>&1 &
server_pid=$!

for _ in {1..100}; do
  [[ -S "$socket_path" ]] && break
  sleep 0.02
done
[[ -S "$socket_path" ]]

{
  printf 'sleep 30\n'
  sleep 0.2
} | LUMEN_ROOT_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" root-1 >/dev/null || true

LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list-json |
  python3 -c 'import json,sys; assert any(row["id"] == "root-1" for row in json.load(sys.stdin))'
LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --set-idle-timeout 0
sleep 1.4
LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list-json |
  python3 -c 'import json,sys; assert any(row["id"] == "root-1" for row in json.load(sys.stdin))'

LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --set-idle-timeout 1
reclaimed="false"
for _ in {1..40}; do
  if LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list-json |
    python3 -c 'import json,sys; raise SystemExit(any(row["id"] == "root-1" for row in json.load(sys.stdin)))'; then
    reclaimed="true"
    break
  fi
  sleep 0.1
done
if [[ "$reclaimed" != "true" ]]; then
  echo "Root session did not follow the live idle timeout update." >&2
  exit 1
fi

echo "root idle timeout live-update checks passed"
