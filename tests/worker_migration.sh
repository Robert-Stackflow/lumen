#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
socket_path="$test_root/pty.sock"
worker_dir="$test_root/sessions"
worker_socket="$worker_dir/worker-test.sock"
server_log="$test_root/server.log"
first_output="$test_root/first.out"
replay_output="$test_root/replay.out"
server_pid=""
attach_pid=""

start_server() {
  LUMEN_SESSION_BACKEND=worker LUMEN_PTY_SOCKET="$socket_path" \
    "$project_dir/bin/lumen-pty" --serve --socket "$socket_path" \
    --shell /bin/bash --cwd "$test_root" --history-bytes 65536 --max-sessions 4 \
    >>"$server_log" 2>&1 &
  server_pid=$!
  for _ in {1..100}; do
    [[ -S "$socket_path" ]] && return
    sleep 0.02
  done
  echo "Worker migration broker did not start." >&2
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
  if [[ -n "$attach_pid" ]]; then wait "$attach_pid" 2>/dev/null || true; fi
  if [[ ! -S "$socket_path" && -S "$worker_socket" ]]; then start_server || true; fi
  if [[ -S "$socket_path" ]]; then
    LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" \
      --kill-force worker-test >/dev/null 2>&1 || true
  fi
  stop_server
  for _ in {1..100}; do [[ ! -S "$worker_socket" ]] && break; sleep 0.01; done
  unlink "$socket_path" "$worker_socket" "$server_log" "$first_output" \
    "$replay_output" 2>/dev/null || true
  rmdir "$worker_dir" "$test_root" 2>/dev/null || true
}
trap cleanup EXIT

start_server
{
  printf 'printf "WORKER-PERSISTED\\n"\n'
  sleep 2
} | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" worker-test \
  >"$first_output" &
attach_pid=$!

for _ in {1..100}; do
  [[ -S "$worker_socket" ]] && break
  sleep 0.02
done

first_pid="$(
  LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list-json |
    python3 -c 'import json,sys; row=json.load(sys.stdin)[0]; assert row["backend"] == "worker"; print(row["pid"])'
)"
[[ -S "$worker_socket" ]]

stop_server
[[ -S "$worker_socket" ]]
kill -0 "$attach_pid"
start_server
kill -0 "$attach_pid"

second_pid="$(
  LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list-json |
    python3 -c 'import json,sys; row=json.load(sys.stdin)[0]; assert row["backend"] == "worker"; print(row["pid"])'
)"
[[ "$first_pid" == "$second_pid" ]]
wait "$attach_pid" || true
attach_pid=""

{
  sleep 0.1
} | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" worker-test \
  >"$replay_output" || true
grep -q 'WORKER-PERSISTED' "$replay_output"

LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --kill worker-test
for _ in {1..150}; do
  [[ ! -S "$worker_socket" ]] && break
  sleep 0.02
done
[[ ! -S "$worker_socket" ]]

echo "worker backend survives broker restart and preserves history"
