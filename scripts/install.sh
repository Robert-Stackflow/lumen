#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: sudo ./scripts/install.sh <non-root-user> <allowed-host> [options]"
  echo
  echo "Options:"
  echo "  --listen <address-or-interface>  Bind target (default: lo)"
  echo "  --port <port>                    TCP port (default: 7681)"
  echo "  --max-clients <count>            Concurrent terminals (default: 16)"
  echo "  --max-sessions <count>           Persistent PTY sessions (default: 16)"
  echo "  --history-bytes <bytes>          Reconnect replay per session (default: 2097152)"
  echo "  --ping-interval <seconds>        WebSocket keepalive (default: 15)"
  echo "  --idle-timeout <seconds>         Automatic reclaim timeout; 0 disables it (default: 0)"
  echo "  --root-max-sessions <count>      Privileged root sessions (default: 2)"
  echo "  --root-idle-timeout <seconds>    Root idle reclaim timeout (default: 1800)"
  echo "  --client-ip-header <header>      Trusted proxy client-IP header"
  echo "  --insecure-cookie                Permit session cookies over HTTP"
  echo "  --replace-legacy-sessions        Stop and remove the retired tmux supervisor"
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

service_user="${1:-}"
allowed_host="${2:-}"
if [[ -z "$service_user" || "$service_user" == "root" || -z "$allowed_host" ]]; then
  usage >&2
  exit 64
fi
shift 2

listen_interface="lo"
listen_port="7681"
max_clients="16"
max_sessions="16"
history_bytes="2097152"
ping_interval="15"
idle_timeout="0"
root_max_sessions="2"
root_idle_timeout="1800"
client_ip_header=""
cookie_secure="true"
replace_legacy_sessions="false"

while (($#)); do
  case "$1" in
    --listen)
      listen_interface="${2:-}"
      shift 2
      ;;
    --port)
      listen_port="${2:-}"
      shift 2
      ;;
    --max-clients)
      max_clients="${2:-}"
      shift 2
      ;;
    --max-sessions)
      max_sessions="${2:-}"
      shift 2
      ;;
    --history-bytes)
      history_bytes="${2:-}"
      shift 2
      ;;
    --ping-interval)
      ping_interval="${2:-}"
      shift 2
      ;;
    --idle-timeout)
      idle_timeout="${2:-}"
      shift 2
      ;;
    --root-max-sessions)
      root_max_sessions="${2:-}"
      shift 2
      ;;
    --root-idle-timeout)
      root_idle_timeout="${2:-}"
      shift 2
      ;;
    --client-ip-header)
      client_ip_header="${2:-}"
      shift 2
      ;;
    --insecure-cookie)
      cookie_secure="false"
      shift
      ;;
    --replace-legacy-sessions)
      replace_legacy_sessions="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if [[ ! "$listen_interface" =~ ^[A-Za-z0-9_.:%-]+$ ]]; then
  echo "Invalid listen address or interface: $listen_interface" >&2
  exit 64
fi
if [[ ! "$allowed_host" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
  echo "Invalid allowed host: $allowed_host" >&2
  exit 64
fi
if [[ ! "$listen_port" =~ ^[0-9]+$ ]] || ((listen_port < 1 || listen_port > 65535)); then
  echo "Invalid port: $listen_port" >&2
  exit 64
fi
if [[ ! "$max_clients" =~ ^[0-9]+$ ]] || ((max_clients < 1 || max_clients > 64)); then
  echo "Invalid max client count: $max_clients" >&2
  exit 64
fi
if [[ ! "$max_sessions" =~ ^[0-9]+$ ]] || ((max_sessions < 1 || max_sessions > 64)); then
  echo "Invalid maximum session count: $max_sessions" >&2
  exit 64
fi
if [[ ! "$history_bytes" =~ ^[0-9]+$ ]] ||
  ((history_bytes < 65536 || history_bytes > 67108864)); then
  echo "Invalid PTY history size: $history_bytes" >&2
  exit 64
fi
if [[ ! "$ping_interval" =~ ^[0-9]+$ ]] || ((ping_interval > 300)); then
  echo "Invalid ping interval: $ping_interval" >&2
  exit 64
fi
if [[ ! "$idle_timeout" =~ ^[0-9]+$ ]] || ((idle_timeout > 31536000)); then
  echo "Invalid idle timeout: $idle_timeout" >&2
  exit 64
fi
if [[ ! "$root_max_sessions" =~ ^[0-9]+$ ]] ||
  ((root_max_sessions < 1 || root_max_sessions > 8)); then
  echo "Invalid root session count: $root_max_sessions" >&2
  exit 64
fi
if [[ ! "$root_idle_timeout" =~ ^[0-9]+$ ]] ||
  ((root_idle_timeout < 300 || root_idle_timeout > 86400)); then
  echo "Invalid root idle timeout: $root_idle_timeout" >&2
  exit 64
fi
if [[ -n "$client_ip_header" && ! "$client_ip_header" =~ ^[A-Za-z0-9-]+$ ]]; then
  echo "Invalid client IP header: $client_ip_header" >&2
  exit 64
fi

passwd_entry="$(getent passwd "$service_user" || true)"
if [[ -z "$passwd_entry" ]]; then
  echo "Unknown user: $service_user" >&2
  exit 65
fi

service_home="$(cut -d: -f6 <<<"$passwd_entry")"
service_uid="$(id -u "$service_user")"
service_gid="$(id -g "$service_user")"
service_shell="$(cut -d: -f7 <<<"$passwd_entry")"
if [[ -z "$service_shell" || ! -x "$service_shell" || "$service_shell" == *[[:space:]]* ]]; then
  echo "The login shell for $service_user must be an executable path without whitespace." >&2
  exit 69
fi
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="/opt/lumen-terminal"
unit_path="/etc/systemd/system/lumen-terminal.service"
pty_unit_path="/etc/systemd/system/lumen-pty.service"
root_pty_unit_path="/etc/systemd/system/lumen-root-pty.service"
legacy_unit_path="/etc/systemd/system/lumen-session.service"
security_dir="/etc/lumen-terminal"
security_path="$security_dir/security.conf"
runtime_path="$security_dir/runtime.env"
web_user="lumen-web"
pty_user="lumen-pty"
socket_group="lumen-terminal"
root_socket_group="lumen-root-terminal"
auth_state="/var/lib/lumen-terminal"

getent group "$socket_group" >/dev/null || groupadd --system "$socket_group"
getent group "$root_socket_group" >/dev/null || groupadd --system "$root_socket_group"
getent group "$web_user" >/dev/null || groupadd --system "$web_user"
if ! id "$pty_user" >/dev/null 2>&1; then
  useradd --system --gid "$socket_group" --home-dir /var/lib/lumen-pty \
    --shell /usr/sbin/nologin "$pty_user"
else
  usermod -g "$socket_group" "$pty_user"
fi
if ! id "$web_user" >/dev/null 2>&1; then
  useradd --system --gid "$socket_group" --groups "$web_user" --home-dir "$auth_state" \
    --shell /usr/sbin/nologin "$web_user"
else
  usermod -g "$socket_group" -a -G "$web_user" "$web_user"
fi
usermod -a -G "$root_socket_group" "$web_user"
web_uid="$(id -u "$web_user")"
web_group="$web_user"

legacy_sessions="false"
if systemctl is-active --quiet lumen-session.service; then
  legacy_sessions="true"
fi

inside_legacy_session() {
  local ancestor="${PPID}"
  local command_line
  local cgroup
  while [[ "$ancestor" =~ ^[0-9]+$ ]] && ((ancestor > 1)); do
    command_line="$(tr '\0' ' ' <"/proc/$ancestor/cmdline" 2>/dev/null || true)"
    cgroup="$(tr '\n' ' ' <"/proc/$ancestor/cgroup" 2>/dev/null || true)"
    if [[ "$command_line" == *"tmux"*"-L lumen"* ]] ||
      [[ "$cgroup" == *"/lumen-session.service"* ]]; then
      return 0
    fi
    ancestor="$(ps -o ppid= -p "$ancestor" 2>/dev/null | tr -d ' ' || true)"
  done
  return 1
}

if [[ "$replace_legacy_sessions" == "true" && "$legacy_sessions" == "true" ]] &&
  inside_legacy_session; then
  echo "The one-time legacy migration cannot run from inside Lumen itself." >&2
  echo "Verify the new PTY service first, then run cleanup from SSH/console." >&2
  exit 73
fi

make -C "$project_dir" build
install -d -o root -g root -m 0755 "$install_dir/bin" "$install_dir/dist" "$install_dir/scripts"
install -d -o "$web_user" -g "$web_group" -m 0700 "$auth_state"
install -d -o "$pty_user" -g "$socket_group" -m 0700 /var/lib/lumen-pty
install -o root -g root -m 0755 "$project_dir/bin/lumen-ttyd" "$install_dir/bin/lumen-ttyd"
install -o root -g root -m 0755 "$project_dir/bin/lumen-pty" "$install_dir/bin/lumen-pty"
install -o root -g root -m 0644 "$project_dir/dist/index.html" "$install_dir/dist/index.html"
install -o root -g root -m 0644 "$project_dir/web/login.template.html" "$install_dir/dist/login.html"
install -o root -g root -m 0755 "$project_dir/scripts/lumen-auth" "$install_dir/scripts/lumen-auth"
install -o root -g root -m 0644 "$project_dir/scripts/lumen-shell-integration.sh" \
  "$install_dir/scripts/lumen-shell-integration.sh"
install -o root -g root -m 0644 "$project_dir/README.md" "$install_dir/README.md"

install -d -o root -g root -m 0700 "$security_dir"
if [[ ! -e "$security_path" ]]; then
  auth_args=(
    init
    --config "$security_path"
    --username "$service_user"
    --host "$allowed_host"
    --state-dir "$auth_state"
  )
  if [[ "$cookie_secure" == "false" ]]; then
    auth_args+=(--insecure-cookie)
  fi
  if [[ -n "$client_ip_header" ]]; then
    auth_args+=(--client-ip-header "$client_ip_header")
  fi
  "$project_dir/scripts/lumen-auth" "${auth_args[@]}"
else
  echo "Keeping existing security policy: $security_path"
  "$project_dir/scripts/lumen-auth" relocate-state --config "$security_path" --state-dir "$auth_state"
fi
chown -R "$web_user:$web_group" "$auth_state"
chmod 0700 "$auth_state"
find "$auth_state" -maxdepth 1 -type f -exec chmod 0600 {} +
chown root:"$web_group" "$security_path"
chmod 0640 "$security_path"
chown root:"$web_group" "$security_dir"
chmod 0750 "$security_dir"

runtime_temp="$(mktemp "$security_dir/.runtime.XXXXXX")"
{
  printf 'LUMEN_INTERFACE=%s\n' "$listen_interface"
  printf 'LUMEN_PORT=%s\n' "$listen_port"
  printf 'LUMEN_SECURITY_CONFIG=%s\n' "$security_path"
  printf 'LUMEN_MAX_CLIENTS=%s\n' "$max_clients"
  printf 'LUMEN_MAX_SESSIONS=%s\n' "$max_sessions"
  printf 'LUMEN_PTY_HISTORY_BYTES=%s\n' "$history_bytes"
  printf 'LUMEN_PING_INTERVAL=%s\n' "$ping_interval"
  printf 'LUMEN_IDLE_SESSION_SECONDS=%s\n' "$idle_timeout"
  printf 'LUMEN_ROOT_MAX_SESSIONS=%s\n' "$root_max_sessions"
  printf 'LUMEN_ROOT_IDLE_SESSION_SECONDS=%s\n' "$root_idle_timeout"
} >"$runtime_temp"
chown root:root "$runtime_temp"
chmod 0600 "$runtime_temp"
mv -f "$runtime_temp" "$runtime_path"

rm -f "/etc/sudoers.d/lumen-terminal-$service_user"

sed \
  -e "s|@WEB_USER@|$web_user|g" \
  -e "s|@SOCKET_GROUP@|$socket_group|g" \
  -e "s|@ROOT_SOCKET_GROUP@|$root_socket_group|g" \
  -e "s|@AUTH_STATE@|$auth_state|g" \
  "$project_dir/deploy/lumen-terminal.service.in" >"$unit_path"
chmod 0644 "$unit_path"

sed \
  -e "s|@SOCKET_GROUP@|$socket_group|g" \
  -e "s|@UID@|$service_uid|g" \
  -e "s|@GID@|$service_gid|g" \
  -e "s|@HOME@|$service_home|g" \
  -e "s|@SHELL@|$service_shell|g" \
  "$project_dir/deploy/lumen-pty.service.in" >"$pty_unit_path"
chmod 0644 "$pty_unit_path"

sed \
  -e "s|@ROOT_SOCKET_GROUP@|$root_socket_group|g" \
  -e "s|@WEB_UID@|$web_uid|g" \
  "$project_dir/deploy/lumen-root-pty.service.in" >"$root_pty_unit_path"
chmod 0644 "$root_pty_unit_path"

systemctl daemon-reload
if [[ "$replace_legacy_sessions" == "true" ]]; then
  systemctl disable --now lumen-session.service 2>/dev/null || true
  rm -f "$legacy_unit_path"
  systemctl daemon-reload
fi
systemctl enable lumen-pty.service
systemctl enable lumen-root-pty.service
systemctl enable lumen-terminal.service
systemctl start lumen-pty.service
systemctl start lumen-root-pty.service
systemctl restart lumen-terminal.service

echo
echo "Lumen is listening on $listen_interface:$listen_port."
echo "Security policy: $security_path"
echo "Runtime settings: $runtime_path"
if [[ "$legacy_sessions" == "true" && "$replace_legacy_sessions" == "false" ]]; then
  echo "The previous tmux service is still running to protect its active tasks."
  echo "After verifying the new terminal, rerun from SSH with --replace-legacy-sessions."
fi
