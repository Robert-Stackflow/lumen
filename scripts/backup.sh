#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: sudo ./scripts/backup.sh [output.tar.gz]"
  echo "Backs up Lumen configuration, authentication state, installed files, and units."
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ "${EUID}" -ne 0 ]]; then echo "Run this backup script with sudo." >&2; exit 1; fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_path="${1:-/var/backups/lumen-terminal/lumen-backup-$timestamp.tar.gz}"
if [[ "$output_path" != /* ]]; then output_path="$(pwd)/$output_path"; fi
install -d -o root -g root -m 0700 "$(dirname -- "$output_path")"

backup_paths=()
for path in \
  etc/lumen-terminal \
  var/lib/lumen-terminal \
  var/lib/lumen-pty \
  opt/lumen-terminal \
  etc/systemd/system/lumen-terminal.service \
  etc/systemd/system/lumen-pty.service \
  etc/systemd/system/lumen-root-pty.service; do
  [[ -e "/$path" ]] && backup_paths+=("$path")
done

if ((${#backup_paths[@]} == 0)); then
  echo "No installed Lumen files were found." >&2
  exit 66
fi

tar -C / -czf "$output_path" "${backup_paths[@]}"
chmod 0600 "$output_path"
echo "Backup written to $output_path"
echo "Active terminal processes and tmux sessions are not included in this archive."
