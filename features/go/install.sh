#!/usr/bin/env bash
# Install Go programming language.
# Usage: install.sh <version>
# Must run as root. Idempotent.
set -euo pipefail

VERSION="${1:?Usage: install.sh <version>}"

# Skip if already installed at the requested version
if command -v go &>/dev/null; then
  CURRENT=$(go version 2>/dev/null | awk '{print $3}' | sed 's/go//')
  if [[ "${CURRENT}" == "${VERSION}"* ]]; then
    echo "go ${VERSION} already installed, skipping."
    exit 0
  fi
fi

# Download and extract
ARCH=$(dpkg --print-architecture)
case "${ARCH}" in
  amd64) GOARCH="amd64" ;;
  arm64) GOARCH="arm64" ;;
  *) echo "Unsupported architecture: ${ARCH}"; exit 1 ;;
esac

curl -fsSL "https://go.dev/dl/go${VERSION}.linux-${GOARCH}.tar.gz" \
  | tar -xz -C /usr/local

# Add to PATH via symlink
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt

echo "Go ${VERSION} installed successfully."
