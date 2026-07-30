#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
port="${LUMEN_PORT:-7681}"

if [[ ! -x "$project_dir/bin/lumen-ttyd" || ! -x "$project_dir/bin/lumen-pty" ||
  ! -f "$project_dir/dist/index.html" ]]; then
  make -C "$project_dir" build
fi

state_root="${XDG_STATE_HOME:-$HOME/.local/state}/lumen-terminal-dev"
mkdir -p -m 0700 "$state_root"
export LUMEN_PTY_SOCKET="$state_root/pty.sock"
if ! "$project_dir/bin/lumen-pty" --list >/dev/null 2>&1; then
  "$project_dir/bin/lumen-pty" --serve \
    --socket "$LUMEN_PTY_SOCKET" \
    --cwd "$HOME" \
    --history-bytes 2097152 \
    --max-sessions 16 \
    >>"$state_root/supervisor.log" 2>&1 &
  for _ in {1..50}; do
    [[ -S "$LUMEN_PTY_SOCKET" ]] && break
    sleep 0.02
  done
fi

exec "$project_dir/bin/lumen-ttyd" \
  --port "$port" \
  --interface lo \
  --writable \
  --url-arg \
  --check-origin \
  --max-clients 16 \
  --ping-interval 15 \
  --index "$project_dir/dist/index.html" \
  "$project_dir/bin/lumen-pty"
