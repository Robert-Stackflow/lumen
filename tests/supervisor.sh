#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d)"
socket_path="$test_root/pty.sock"
server_log="$test_root/server.log"
first_output="$test_root/first.out"
replay_output="$test_root/replay.out"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  unlink "$server_log" "$first_output" "$replay_output" 2>/dev/null || true
  unlink "$socket_path" 2>/dev/null || true
  rmdir "$test_root" 2>/dev/null || true
}
trap cleanup EXIT

LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" \
  --serve \
  --socket "$socket_path" \
  --shell /bin/bash \
  --cwd "$test_root" \
  --history-bytes 65536 \
  --max-sessions 2 \
  >"$server_log" 2>&1 &
server_pid=$!

for _ in {1..100}; do
  [[ -S "$socket_path" ]] && break
  sleep 0.02
done
[[ -S "$socket_path" ]]

{
  printf 'printf "LUMEN-PERSISTED\\n"\n'
  sleep 0.2
} | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" test \
  >"$first_output" || true

LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list |
  grep -q '^test '

replay_seen="false"
for _ in {1..60}; do
  {
    sleep 0.05
  } | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" test \
    >"$replay_output" || true
  if grep -q 'LUMEN-PERSISTED' "$replay_output"; then
    replay_seen="true"
    break
  fi
  sleep 0.02
done
if [[ "$replay_seen" != "true" ]]; then
  echo "Session output was not available for replay." >&2
  exit 1
fi

{
  printf 'exit\n'
  sleep 0.3
} | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" test \
  >/dev/null || true

session_removed="false"
for _ in {1..150}; do
  session_list="$(
    LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list
  )"
  if ! grep -q '^test ' <<<"$session_list"; then
    session_removed="true"
    break
  fi
  sleep 0.02
done
if [[ "$session_removed" != "true" ]]; then
  echo "Session survived an explicit shell exit." >&2
  exit 1
fi

{
  printf 'sleep 30\n'
  sleep 0.2
} | LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" terminate \
  >/dev/null || true
LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --kill terminate
sleep 0.2
if LUMEN_PTY_SOCKET="$socket_path" "$project_dir/bin/lumen-pty" --list |
  grep -q '^terminate '; then
  echo "Terminated session is still present." >&2
  exit 1
fi

echo "supervisor persistence and termination checks passed"
