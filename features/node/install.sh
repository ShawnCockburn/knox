#!/usr/bin/env bash
# Install Node.js via nvm into the knox user's profile.
# This coexists with Claude Code's Node at /opt/claude/ (which is NOT on user PATH).
# Usage: install.sh <major_version>
# Must run as root. Idempotent.
set -euo pipefail

VERSION="${1:?Usage: install.sh <major_version>}"
KNOX_HOME="/home/knox"
NVM_DIR="${KNOX_HOME}/.nvm"

# Install nvm if not present
if [ ! -d "${NVM_DIR}" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | \
    PROFILE=/dev/null NVM_DIR="${NVM_DIR}" bash
fi

# Source nvm and install the requested version
export NVM_DIR
# shellcheck disable=SC1091
. "${NVM_DIR}/nvm.sh"
nvm install "${VERSION}"
nvm alias default "${VERSION}"

# Create symlinks so node/npm/npx are on PATH for all users
NODE_PATH="$(nvm which "${VERSION}")"
NODE_DIR="$(dirname "${NODE_PATH}")"
ln -sf "${NODE_PATH}" /usr/local/bin/node
ln -sf "${NODE_DIR}/npm" /usr/local/bin/npm
ln -sf "${NODE_DIR}/npx" /usr/local/bin/npx

# Fix ownership
chown -R knox:knox "${NVM_DIR}"

echo "Node.js ${VERSION} installed via nvm successfully."
