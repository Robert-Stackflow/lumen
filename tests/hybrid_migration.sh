#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
socket_path="$test_root/pty.sock"
worker_dir="$test_root/sessions"
tmux_label="lumentest$$"
server_log="$test_root/server.log"
legacy_output="$test_root/legacy.out"
native_output="$test_root/native.out"
server_pid=""

start_server() {
  local backend="$1"
  LUMEN_SESSION_BACKEND="$backend" LUMEN_PTY_SOCKET="$socket_path" \
    "$project_dir/bin/lumen-pty" --serve --socket "$socket_path" \
    --shell /bin/bash --cwd "$test_root" --history-bytes 65536 --max-sessions 4 \
    --tmux /usr/bin/tmux --tmux-label "$tmux_label" >>"$server_log" 2>&1 &
  server_pid=$!
  for _ in {1..100}; do [[ -S "$socket_path" ]] && return; sleep 0.02; done
  echo "Hybrid migration broker did not start." >&2
  exit 1
}

stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=""
  fi
}

cleanup() {
  if [[ ! -S "$socket_path" ]]; then start_server worker || true; fi
  if [[ -S "$socket_path" ]]; then
    LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --kill-force legacy \
      >/dev/null 2>&1 || true
    LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --kill-force native \
      >/dev/null 2>&1 || true
  fi
  stop_server
  tmux -L "$tmux_label" kill-server >/dev/null 2>&1 || true
  for _ in {1..100}; do [[ ! -S "$worker_dir/native.sock" ]] && break; sleep 0.01; done
  unlink "$socket_path" "$worker_dir/native.sock" "$server_log" "$legacy_output" \
    "$native_output" 2>/dev/null || true
  rmdir "$worker_dir" "$test_root" 2>/dev/null || true
}
trap cleanup EXIT

start_server tmux
{
  printf 'printf "LEGACY-TMUX\\n"\n'
  sleep 0.2
} | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" legacy \
  >"$legacy_output" || true
stop_server

start_server worker
LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list-json |
  python3 -c 'import json,sys; rows=json.load(sys.stdin); row=next(x for x in rows if x["id"] == "legacy"); assert row["backend"] == "tmux-legacy"'

{
  printf 'printf "NATIVE-WORKER\\n"\n'
  sleep 0.2
} | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" native \
  >"$native_output" || true

LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list-json |
  python3 -c 'import json,sys; rows={x["id"]:x for x in json.load(sys.stdin)}; assert rows["legacy"]["backend"] == "tmux-legacy"; assert rows["native"]["backend"] == "worker"'

echo "hybrid backend preserves legacy tmux sessions and creates native workers"
