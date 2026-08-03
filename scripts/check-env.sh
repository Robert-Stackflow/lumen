#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/check-env.sh [non-root-user] [allowed-host] [options]

Checks whether a Debian/Ubuntu host is ready to build and run Lumen. The
script does not change the host and may be run before or after installation.

Options:
  --listen <address-or-interface>  Planned bind target (default: lo)
  --port <port>                    Planned TCP port (default: 7681)
  --installed                     Also inspect the installed Lumen services
  -h, --help                      Show this help
EOF
}

shell_user=""
allowed_host=""
listen_target="lo"
listen_port="7681"
check_installed="false"
listen_explicit="false"
port_explicit="false"
installed_backend=""

if (($#)) && [[ "$1" != -* ]]; then shell_user="$1"; shift; fi
if (($#)) && [[ "$1" != -* ]]; then allowed_host="$1"; shift; fi
while (($#)); do
  case "$1" in
    --listen)
      (($# >= 2)) || { echo "--listen requires a value" >&2; exit 64; }
      listen_target="$2"; listen_explicit="true"; shift 2
      ;;
    --port)
      (($# >= 2)) || { echo "--port requires a value" >&2; exit 64; }
      listen_port="$2"; port_explicit="true"; shift 2
      ;;
    --installed) check_installed="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
done

if [[ "$check_installed" == "true" && -r /etc/lumen-terminal/runtime.env ]]; then
  if [[ "$listen_explicit" != "true" ]]; then
    listen_target="$(sed -n 's/^LUMEN_INTERFACE=//p' /etc/lumen-terminal/runtime.env | tail -n 1)"
  fi
  if [[ "$port_explicit" != "true" ]]; then
    listen_port="$(sed -n 's/^LUMEN_PORT=//p' /etc/lumen-terminal/runtime.env | tail -n 1)"
  fi
  installed_backend="$(sed -n 's/^LUMEN_SESSION_BACKEND=//p' /etc/lumen-terminal/runtime.env | tail -n 1)"
fi

failures=0
warnings=0
pass() { printf '  [OK]   %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; warnings=$((warnings + 1)); }
fail() { printf '  [FAIL] %s\n' "$*"; failures=$((failures + 1)); }

printf 'Lumen environment check\n\n'

if [[ "$check_installed" == "true" ]]; then
  if [[ "$installed_backend" == "worker" || "$installed_backend" == "tmux" ]]; then
    pass "New-session backend is configured: $installed_backend"
  else
    fail "LUMEN_SESSION_BACKEND is missing or invalid"
  fi
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    ubuntu:*|debian:*|*:debian*) pass "Supported operating system: ${PRETTY_NAME:-$ID}" ;;
    *) fail "Unsupported operating system: ${PRETTY_NAME:-unknown}; use Debian or Ubuntu" ;;
  esac
else
  fail "Cannot read /etc/os-release"
fi

if command -v systemctl >/dev/null 2>&1; then
  if [[ "$(systemctl is-system-running 2>/dev/null || true)" =~ ^(running|degraded)$ ]]; then
    pass "systemd is running"
  else
    fail "systemd is unavailable or not running"
  fi
else
  fail "systemctl is missing"
fi

required_commands=(apt-get bwrap cc cmake curl git ip make node pkg-config python3 ss tmux)
for command_name in "${required_commands[@]}"; do
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "Command available: $command_name"
  else
    fail "Missing command: $command_name"
  fi
done

architecture="$(uname -m)"
case "$architecture" in
  x86_64|aarch64|arm64) pass "Supported host architecture: $architecture" ;;
  *) warn "Host architecture is not covered by CI: $architecture" ;;
esac

if command -v pkg-config >/dev/null 2>&1; then
  required_modules=(json-c openssl libuv libwebsockets libfido2 libqrencode zlib)
  for module in "${required_modules[@]}"; do
    if pkg-config --exists "$module" 2>/dev/null; then
      pass "Development library available: $module"
    else
      fail "Missing development library: $module"
    fi
  done
fi

if [[ -n "$shell_user" ]]; then
  passwd_entry="$(getent passwd "$shell_user" 2>/dev/null || true)"
  if [[ -z "$passwd_entry" || "$shell_user" == "root" ]]; then
    fail "Shell user must be an existing non-root account: $shell_user"
  else
    shell_path="${passwd_entry##*:}"
    home_path="$(cut -d: -f6 <<<"$passwd_entry")"
    [[ -d "$home_path" && -x "$home_path" ]] && pass "Shell home is accessible: $home_path" || fail "Shell home is not accessible: $home_path"
    [[ -x "$shell_path" ]] && pass "Login shell is executable: $shell_path" || fail "Login shell is not executable: $shell_path"
  fi
fi

if [[ -n "$allowed_host" ]]; then
  if [[ "$allowed_host" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
    pass "Allowed Host value is valid: $allowed_host"
  else
    fail "Allowed Host contains unsupported characters: $allowed_host"
  fi
  dns_host="${allowed_host%%:*}"
  if [[ "$dns_host" == "localhost" ]] || getent ahosts "$dns_host" >/dev/null 2>&1; then
    pass "Host resolves locally: $dns_host"
  else
    warn "Host does not currently resolve on this machine: $dns_host"
  fi
fi

if [[ ! "$listen_port" =~ ^[0-9]+$ ]] || ((listen_port < 1 || listen_port > 65535)); then
  fail "Invalid TCP port: $listen_port"
elif command -v ss >/dev/null 2>&1 && ss -H -ltn "sport = :$listen_port" 2>/dev/null | grep -q .; then
  if [[ "$check_installed" == "true" ]] && systemctl is-active --quiet lumen-terminal.service 2>/dev/null; then
    pass "TCP port $listen_port is owned by the installed Lumen service"
  else
    warn "TCP port $listen_port is already in use"
  fi
else
  pass "TCP port $listen_port is available"
fi

if [[ ! "$listen_target" =~ ^[A-Za-z0-9_.:%-]+$ ]]; then
  fail "Invalid bind target: $listen_target"
elif [[ "$listen_target" =~ ^[A-Za-z] ]] && [[ "$listen_target" != *:* ]] && [[ "$listen_target" != "localhost" ]] &&
  command -v ip >/dev/null 2>&1 && ! ip link show "$listen_target" >/dev/null 2>&1; then
  fail "Network interface does not exist: $listen_target"
else
  pass "Bind target is valid: $listen_target"
fi

available_kib="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ "$available_kib" =~ ^[0-9]+$ ]] && ((available_kib >= 1048576)); then
  pass "At least 1 GiB of build disk space is available"
else
  warn "Less than 1 GiB of build disk space is available"
fi
memory_kib="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
if [[ "$memory_kib" =~ ^[0-9]+$ ]] && ((memory_kib >= 524288)); then
  pass "At least 512 MiB of memory is available"
else
  warn "Less than 512 MiB of memory is available"
fi

max_user_namespaces="$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || true)"
if [[ "$max_user_namespaces" =~ ^[0-9]+$ ]] && ((max_user_namespaces > 0)); then
  pass "User namespaces are enabled for bubblewrap/Codex"
else
  warn "User namespaces appear disabled; Codex sandboxing may not work"
fi
if [[ -r /proc/sys/kernel/unprivileged_userns_clone ]] &&
  [[ "$(</proc/sys/kernel/unprivileged_userns_clone)" != "1" ]]; then
  warn "kernel.unprivileged_userns_clone is disabled; Codex sandboxing may not work"
fi
if command -v bwrap >/dev/null 2>&1 && [[ -n "$shell_user" ]] && id "$shell_user" >/dev/null 2>&1; then
  sandbox_command=(bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user --unshare-pid /bin/true)
  if [[ "$EUID" -eq 0 ]]; then
    if sandbox_output="$(runuser -u "$shell_user" -- timeout 5 "${sandbox_command[@]}" 2>&1)"; then
      pass "bubblewrap can create a sandbox for $shell_user"
    else
      warn "bubblewrap sandbox probe failed for $shell_user: ${sandbox_output%%$'\n'*}"
    fi
  elif [[ "$(id -un)" == "$shell_user" ]]; then
    if sandbox_output="$(timeout 5 "${sandbox_command[@]}" 2>&1)"; then
      pass "bubblewrap can create a sandbox for $shell_user"
    else
      warn "bubblewrap sandbox probe failed for $shell_user: ${sandbox_output%%$'\n'*}"
    fi
  else
    warn "Run this check as root or $shell_user to probe bubblewrap sandbox creation"
  fi
fi

if [[ "$check_installed" == "true" ]]; then
  for path in /opt/lumen-terminal/bin/lumen-ttyd /opt/lumen-terminal/bin/lumen-pty \
    /etc/lumen-terminal/security.conf /etc/lumen-terminal/runtime.env; do
    [[ -e "$path" ]] && pass "Installed path exists: $path" || fail "Installed path is missing: $path"
  done
  for service in lumen-pty.service lumen-root-pty.service lumen-terminal.service; do
    systemctl is-active --quiet "$service" 2>/dev/null && pass "Service is active: $service" || fail "Service is not active: $service"
  done
  [[ -S /run/lumen-terminal/pty.sock ]] && pass "Normal PTY socket is ready" || fail "Normal PTY socket is missing"
  [[ -S /run/lumen-root-terminal/pty.sock ]] && pass "Root PTY socket is ready" || fail "Root PTY socket is missing"
fi

printf '\nResult: %d failure(s), %d warning(s)\n' "$failures" "$warnings"
((failures == 0))
