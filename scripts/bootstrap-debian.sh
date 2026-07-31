#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: sudo ./scripts/bootstrap-debian.sh <non-root-user> <allowed-host> [install-options]"
  echo
  echo "Installs the Debian/Ubuntu build dependencies, runs the test suite, and"
  echo "forwards all arguments to scripts/install.sh."
  echo
  echo "Example:"
  echo "  sudo ./scripts/bootstrap-debian.sh ubuntu terminal.example.com \\"
  echo "    --listen lo --port 7681 --client-ip-header X-Real-IP"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this bootstrap script with sudo." >&2
  exit 1
fi

if (($# < 2)); then
  usage >&2
  exit 64
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This bootstrap script supports Debian and Ubuntu hosts with apt-get." >&2
  exit 69
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "A systemd-based host is required by the production installer." >&2
  exit 69
fi

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  build-essential \
  bubblewrap \
  ca-certificates \
  cmake \
  curl \
  git \
  libjson-c-dev \
  libssl-dev \
  libuv1-dev \
  libwebsockets-dev libfido2-dev libqrencode-dev \
  iproute2 \
  nodejs \
  pkg-config \
  python3 \
  tmux \
  zlib1g-dev

"$project_dir/scripts/check-env.sh" "${1:-}" "${2:-}"
make -C "$project_dir" check
exec "$project_dir/scripts/install.sh" "$@"
