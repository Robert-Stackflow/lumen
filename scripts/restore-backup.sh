#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/restore-backup.sh <backup.tar.gz> [--yes]

Validates and restores an archive produced by scripts/backup.sh. The current
installation is backed up first. The web service is restarted, while running
PTY supervisors and their sessions are left untouched.
EOF
}

archive="${1:-}"
[[ "$archive" == "-h" || "$archive" == "--help" ]] && { usage; exit 0; }
if [[ "${EUID}" -ne 0 ]]; then echo "Run this restore script with sudo." >&2; exit 1; fi
[[ -n "$archive" && -f "$archive" ]] || { usage >&2; exit 64; }
assume_yes="false"
shift
while (($#)); do
  case "$1" in
    --yes) assume_yes="true" ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

invalid_entry="$(tar -tzf "$archive" | awk '
  /^\// || /(^|\/)\.\.($|\/)/ {print; exit}
  !/^(etc\/lumen-terminal\/?$|etc\/lumen-terminal\/|var\/lib\/lumen-terminal\/?$|var\/lib\/lumen-terminal\/|var\/lib\/lumen-pty\/?$|var\/lib\/lumen-pty\/|opt\/lumen-terminal\/?$|opt\/lumen-terminal\/|etc\/systemd\/system\/lumen-(terminal|pty|root-pty)\.service$)/ {print; exit}
')"
if [[ -n "$invalid_entry" ]]; then
  echo "Archive contains an unexpected path: $invalid_entry" >&2
  exit 65
fi

if [[ "$assume_yes" != "true" ]]; then
  echo "This overwrites the installed Lumen configuration and program files."
  read -r -p "Type 'restore' to continue: " confirmation
  [[ "$confirmation" == "restore" ]] || { echo "Cancelled."; exit 1; }
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -e /opt/lumen-terminal || -e /etc/lumen-terminal || -e /var/lib/lumen-terminal ]]; then
  if [[ -x "$project_dir/scripts/backup.sh" ]]; then
    "$project_dir/scripts/backup.sh"
  elif [[ -x /opt/lumen-terminal/scripts/backup.sh ]]; then
    /opt/lumen-terminal/scripts/backup.sh
  fi
fi

tar -C / -xzf "$archive"
systemctl daemon-reload
systemctl enable lumen-pty.service lumen-root-pty.service lumen-terminal.service
systemctl start lumen-pty.service lumen-root-pty.service
systemctl restart lumen-terminal.service
if [[ -x /opt/lumen-terminal/scripts/verify-install.sh ]]; then
  /opt/lumen-terminal/scripts/verify-install.sh
elif [[ -x "$project_dir/scripts/verify-install.sh" ]]; then
  "$project_dir/scripts/verify-install.sh"
fi
echo "Backup restored from $archive"
