#!/usr/bin/env bash
# Install Deno runtime.
# Usage: install.sh <version>
# Must run as root. Idempotent.
set -euo pipefail

VERSION="${1:?Usage: install.sh <version>}"

# Skip if already installed at the requested version
if command -v deno &>/dev/null; then
  CURRENT=$(deno --version 2>/dev/null | head -1 | awk '{print $2}')
  if [[ "${CURRENT}" == "${VERSION}"* ]]; then
    echo "deno ${VERSION} already installed, skipping."
    exit 0
  fi
fi

curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s "v${VERSION}"

echo "Deno ${VERSION} installed successfully."
