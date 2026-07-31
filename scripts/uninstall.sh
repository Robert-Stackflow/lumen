#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/uninstall.sh [options]

Options:
  --stop-sessions  End all normal and root sessions before uninstalling
  --purge-data     Remove /etc/lumen-terminal and /var/lib/lumen-terminal
  --remove-users   Remove Lumen's system users and groups (requires --purge-data)
  --yes            Skip the final interactive confirmation
  -h, --help       Show this help

Configuration and authentication state are retained by default. A backup is
always created before files are removed. The script refuses to continue while
sessions exist unless --stop-sessions is supplied.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ "${EUID}" -ne 0 ]]; then echo "Run this uninstall script with sudo." >&2; exit 1; fi
stop_sessions="false"
purge_data="false"
remove_users="false"
assume_yes="false"
while (($#)); do
  case "$1" in
    --stop-sessions) stop_sessions="true" ;;
    --purge-data) purge_data="true" ;;
    --remove-users) remove_users="true" ;;
    --yes) assume_yes="true" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done
if [[ "$remove_users" == "true" && "$purge_data" != "true" ]]; then
  echo "--remove-users requires --purge-data so retained files do not lose their owner." >&2
  exit 64
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pty_binary="/opt/lumen-terminal/bin/lumen-pty"

session_inventory() {
  local socket_path="$1"
  local service_name="$2"
  if [[ ! -S "$socket_path" ]]; then
    if systemctl cat "$service_name" >/dev/null 2>&1; then
      echo "$service_name is installed but its socket is unavailable; start or repair it before uninstalling." >&2
      return 1
    fi
    printf '[]'
    return
  fi
  [[ -x "$pty_binary" ]] || { echo "PTY client is missing: $pty_binary" >&2; return 1; }
  id lumen-web >/dev/null 2>&1 || { echo "lumen-web account is missing." >&2; return 1; }
  runuser -u lumen-web -- env LUMEN_PTY_SOCKET="$socket_path" "$pty_binary" --list-json
}

normal_inventory="$(session_inventory /run/lumen-terminal/pty.sock lumen-pty.service)"
root_inventory="$(session_inventory /run/lumen-root-terminal/pty.sock lumen-root-pty.service)"
if grep -q '"id"[[:space:]]*:' <<<"$normal_inventory$root_inventory" && [[ "$stop_sessions" != "true" ]]; then
  echo "Active Lumen sessions were found. Re-run with --stop-sessions to end them explicitly." >&2
  exit 73
fi

if [[ "$assume_yes" != "true" ]]; then
  echo "This removes Lumen programs and systemd units."
  [[ "$stop_sessions" == "true" ]] && echo "All detected terminal sessions will be ended."
  [[ "$purge_data" == "true" ]] && echo "Configuration and authentication state will be removed after backup."
  read -r -p "Type 'uninstall' to continue: " confirmation
  [[ "$confirmation" == "uninstall" ]] || { echo "Cancelled."; exit 1; }
fi

"$project_dir/scripts/backup.sh"

kill_inventory() {
  local socket_path="$1"
  local inventory="$2"
  while IFS= read -r session_id; do
    [[ -n "$session_id" ]] || continue
    runuser -u lumen-web -- env LUMEN_PTY_SOCKET="$socket_path" \
      "$pty_binary" --kill-force "$session_id" >/dev/null
  done < <(python3 -c 'import json,sys; print("\n".join(str(x["id"]) for x in json.load(sys.stdin)))' <<<"$inventory")
}
if [[ "$stop_sessions" == "true" ]]; then
  kill_inventory /run/lumen-terminal/pty.sock "$normal_inventory"
  kill_inventory /run/lumen-root-terminal/pty.sock "$root_inventory"
fi

systemctl disable --now lumen-terminal.service lumen-pty.service lumen-root-pty.service 2>/dev/null || true
rm -f -- \
  /etc/systemd/system/lumen-terminal.service \
  /etc/systemd/system/lumen-pty.service \
  /etc/systemd/system/lumen-root-pty.service
systemctl daemon-reload
rm -rf -- /opt/lumen-terminal

if [[ "$purge_data" == "true" ]]; then
  rm -rf -- /etc/lumen-terminal /var/lib/lumen-terminal /var/lib/lumen-pty
fi
if [[ "$remove_users" == "true" ]]; then
  userdel lumen-web 2>/dev/null || true
  userdel lumen-pty 2>/dev/null || true
  groupdel lumen-web 2>/dev/null || true
  groupdel lumen-root-terminal 2>/dev/null || true
  groupdel lumen-terminal 2>/dev/null || true
fi

echo "Lumen has been uninstalled."
[[ "$purge_data" == "true" ]] || echo "Configuration and authentication state were retained."
