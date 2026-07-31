#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/upgrade.sh <non-root-user> <allowed-host> [install-options]

Creates a timestamped backup, runs the test suite, installs the current source
tree, and verifies the result. Existing PTY supervisors are not restarted.
All remaining options are passed to scripts/install.sh.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi
if [[ "${EUID}" -ne 0 ]]; then echo "Run this upgrade script with sudo." >&2; exit 1; fi
if (($# < 2)); then usage >&2; exit 64; fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="/var/backups/lumen-terminal/lumen-backup-$timestamp.tar.gz"
"$project_dir/scripts/backup.sh" "$backup_path"
if ! make -C "$project_dir" check; then
  echo "Upgrade tests failed; the installed service was not changed." >&2
  exit 1
fi
if ! "$project_dir/scripts/install.sh" "$@"; then
  echo "Upgrade failed. Review the error, or restore with:" >&2
  echo "  sudo $project_dir/scripts/restore-backup.sh $backup_path" >&2
  exit 1
fi
