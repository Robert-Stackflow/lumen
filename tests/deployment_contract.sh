#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

for script in check-env.sh verify-install.sh backup.sh restore-backup.sh upgrade.sh uninstall.sh; do
  test -x "$project_dir/scripts/$script"
  "$project_dir/scripts/$script" --help >/dev/null
done

grep -q 'scripts/verify-install.sh' "$project_dir/scripts/install.sh"
grep -q -- '--max-sessions 8' "$project_dir/deploy/lumen-root-pty.service.in"
grep -q '^LUMEN_IDLE_SESSION_SECONDS=' "$project_dir/deploy/runtime.env.example"
grep -q 'github.com/Robert-Stackflow/lumen.git' "$project_dir/README.md"
if grep -q 'github.com/RanranranQAQ/lumen.git' "$project_dir/README.md"; then
  echo "README still contains the retired repository URL" >&2
  exit 1
fi
