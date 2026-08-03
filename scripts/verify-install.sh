#!/usr/bin/env bash
set -uo pipefail

usage() {
  echo "Usage: sudo ./scripts/verify-install.sh [allowed-host]"
  echo "Checks the installed services, PTY sockets, permissions, and HTTP health endpoint."
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ "${EUID}" -ne 0 ]]; then echo "Run this verification script with sudo." >&2; exit 1; fi

runtime_path="/etc/lumen-terminal/runtime.env"
security_path="/etc/lumen-terminal/security.conf"
failures=0
pass() { printf '  [OK]   %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; failures=$((failures + 1)); }
config_value() { sed -n "s/^$1=//p" "$2" 2>/dev/null | tail -n 1; }

printf 'Lumen installation verification\n\n'
if [[ ! -r "$runtime_path" ]]; then
  fail "Runtime configuration is missing: $runtime_path"
  exit 1
fi

listen_target="$(config_value LUMEN_INTERFACE "$runtime_path")"
listen_port="$(config_value LUMEN_PORT "$runtime_path")"
session_backend="$(config_value LUMEN_SESSION_BACKEND "$runtime_path")"
allowed_host="${1:-$(config_value allowed_host "$security_path")}"
[[ -n "$allowed_host" ]] || allowed_host="localhost"

for service in lumen-pty.service lumen-root-pty.service lumen-terminal.service; do
  systemctl is-enabled --quiet "$service" 2>/dev/null && pass "Service is enabled: $service" || fail "Service is not enabled: $service"
  systemctl is-active --quiet "$service" 2>/dev/null && pass "Service is active: $service" || fail "Service is not active: $service"
done

for attempt in {1..20}; do
  [[ -S /run/lumen-terminal/pty.sock && -S /run/lumen-root-terminal/pty.sock ]] && break
  sleep 0.25
done
[[ -S /run/lumen-terminal/pty.sock ]] && pass "Normal PTY socket is ready" || fail "Normal PTY socket is missing"
[[ -S /run/lumen-root-terminal/pty.sock ]] && pass "Root PTY socket is ready" || fail "Root PTY socket is missing"
[[ -d /run/lumen-terminal/sessions ]] && pass "Normal worker directory is ready" || fail "Normal worker directory is missing"
[[ -d /run/lumen-root-terminal/sessions ]] && pass "Root worker directory is ready" || fail "Root worker directory is missing"
if [[ "$session_backend" == "worker" || "$session_backend" == "tmux" ]]; then
  pass "New-session backend is configured: $session_backend"
else
  fail "New-session backend is missing or invalid"
fi

if id lumen-web >/dev/null 2>&1; then
  if runuser -u lumen-web -- env LUMEN_PTY_SOCKET=/run/lumen-terminal/pty.sock \
    /opt/lumen-terminal/bin/lumen-pty --list >/dev/null 2>&1; then
    pass "Web identity can query the normal PTY supervisor"
  else
    fail "Web identity cannot query the normal PTY supervisor"
  fi
  if runuser -u lumen-web -- env LUMEN_PTY_SOCKET=/run/lumen-root-terminal/pty.sock \
    /opt/lumen-terminal/bin/lumen-pty --list >/dev/null 2>&1; then
    pass "Web identity can query the root PTY supervisor"
  else
    fail "Web identity cannot query the root PTY supervisor"
  fi
else
  fail "lumen-web account is missing"
fi

connect_host="$listen_target"
case "$listen_target" in
  lo|localhost|0.0.0.0) connect_host="127.0.0.1" ;;
  ::|::0) connect_host="[::1]" ;;
  *:*) connect_host="[$listen_target]" ;;
  *)
    if command -v ip >/dev/null 2>&1 && ip link show "$listen_target" >/dev/null 2>&1; then
      connect_host="$(ip -o -4 addr show dev "$listen_target" | awk 'NR==1 {split($4,a,"/"); print a[1]}')"
    fi
    ;;
esac

health_url="http://${connect_host}:${listen_port}/healthz"
health_body=""
for attempt in {1..20}; do
  health_body="$(curl --silent --show-error --fail --max-time 3 -H "Host: $allowed_host" "$health_url" 2>/dev/null || true)"
  [[ "$health_body" == *'"status":"ok"'* ]] && break
  sleep 0.25
done
if [[ "$health_body" == *'"status":"ok"'* ]]; then
  pass "HTTP health endpoint responded at $health_url"
else
  fail "HTTP health endpoint did not respond at $health_url (Host: $allowed_host)"
fi

if [[ -r "$security_path" ]] && [[ "$(stat -c '%a' "$security_path" 2>/dev/null)" == "640" ]]; then
  pass "Security policy permissions are 0640"
else
  fail "Security policy is missing or has unexpected permissions"
fi
if [[ "$(stat -c '%a' "$runtime_path" 2>/dev/null)" == "600" ]]; then
  pass "Runtime configuration permissions are 0600"
else
  fail "Runtime configuration has unexpected permissions"
fi

printf '\nResult: %d failure(s)\n' "$failures"
((failures == 0))
