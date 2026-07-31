#!/usr/bin/env bash
set -euo pipefail

test_root="$(mktemp -d)"
policy="$test_root/security.conf"
state="$test_root/state"
cookies="$test_root/cookies"
mkdir -m 0700 "$state"

init_output="$(
  scripts/lumen-auth init \
    --config "$policy" \
    --username tester \
    --host 127.0.0.1 \
    --state-dir "$state" \
    --insecure-cookie
)"
password="$(sed -n 's/^Password: //p' <<<"$init_output")"

LUMEN_LOGIN_TEMPLATE="$PWD/web/login.template.html" \
  bin/lumen-ttyd \
  --port 39091 \
  --interface lo \
  --writable \
  --check-origin \
  --security-config "$policy" \
  --index "$PWD/dist/index.html" \
  /bin/sh >"$test_root/server.log" 2>&1 &
server_pid=$!
cleanup() {
  status=$?
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -fsS -c "$cookies" http://127.0.0.1:39091/login -o "$test_root/login.html" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

csrf="$(sed -n 's/.*name="csrf" value="\([0-9a-f]*\)".*/\1/p' "$test_root/login.html" | head -1)"
test "${#csrf}" -eq 64

login_status="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -b "$cookies" \
    -c "$cookies" \
    -H 'Origin: http://127.0.0.1:39091' \
    --data-urlencode username=tester \
    --data-urlencode "password=$password" \
    --data-urlencode totp= \
    --data-urlencode "csrf=$csrf" \
    http://127.0.0.1:39091/auth/login
)"
test "$login_status" = 303
test "$(wc -l <"$state/sessions")" -eq 1

authenticated_status="$(
  curl -sS -o /dev/null -w '%{http_code}' -b "$cookies" http://127.0.0.1:39091/
)"
test "$authenticated_status" = 200

kill "$server_pid"
wait "$server_pid"
LUMEN_LOGIN_TEMPLATE="$PWD/web/login.template.html" \
  bin/lumen-ttyd \
  --port 39091 \
  --interface lo \
  --writable \
  --check-origin \
  --security-config "$policy" \
  --index "$PWD/dist/index.html" \
  /bin/sh >>"$test_root/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 30); do
  if authenticated_status="$(
    curl -sS -o /dev/null -w '%{http_code}' -b "$cookies" http://127.0.0.1:39091/ 2>/dev/null
  )" && test "$authenticated_status" = 200; then
    break
  fi
  sleep 0.1
done
test "$authenticated_status" = 200

logout_status="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -b "$cookies" \
    -H 'Origin: http://127.0.0.1:39091' \
    -H 'X-Lumen-Action: logout' \
    -X POST \
    http://127.0.0.1:39091/auth/logout
)"
test "$logout_status" = 303
test "$(wc -l <"$state/sessions")" -eq 0

revoked_status="$(
  curl -sS -o /dev/null -w '%{http_code}' -b "$cookies" http://127.0.0.1:39091/
)"
test "$revoked_status" = 303

echo "server-side session creation and revocation checks passed"
