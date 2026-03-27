#!/usr/bin/env bash
# Install Rust via rustup.
# Usage: install.sh <version>
# Must run as root. Idempotent.
set -euo pipefail

VERSION="${1:?Usage: install.sh <version>}"
KNOX_HOME="/home/knox"
RUSTUP_HOME="${KNOX_HOME}/.rustup"
CARGO_HOME="${KNOX_HOME}/.cargo"

export RUSTUP_HOME CARGO_HOME

# Install rustup if not present
if [ ! -f "${CARGO_HOME}/bin/rustup" ]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain "${VERSION}" --no-modify-path
else
  "${CARGO_HOME}/bin/rustup" toolchain install "${VERSION}"
  "${CARGO_HOME}/bin/rustup" default "${VERSION}"
fi

# Create symlinks
ln -sf "${CARGO_HOME}/bin/rustc" /usr/local/bin/rustc
ln -sf "${CARGO_HOME}/bin/cargo" /usr/local/bin/cargo
ln -sf "${CARGO_HOME}/bin/rustup" /usr/local/bin/rustup

# Fix ownership
chown -R knox:knox "${RUSTUP_HOME}" "${CARGO_HOME}"

echo "Rust ${VERSION} installed successfully."
