#!/usr/bin/env bash
# Install Ruby via ruby-install.
# Usage: install.sh <version>
# Must run as root. Idempotent.
set -euo pipefail

VERSION="${1:?Usage: install.sh <version>}"

# Skip if already installed at the requested version
if command -v ruby &>/dev/null; then
  CURRENT=$(ruby --version 2>/dev/null | awk '{print $2}')
  if [[ "${CURRENT}" == "${VERSION}"* ]]; then
    echo "ruby ${VERSION} already installed, skipping."
    exit 0
  fi
fi

# Install build dependencies
apt-get update -qq
apt-get install -y -qq \
  build-essential \
  libssl-dev \
  libreadline-dev \
  zlib1g-dev \
  libyaml-dev \
  libffi-dev

# Install ruby-install
RUBY_INSTALL_VERSION="0.9.3"
curl -fsSL "https://github.com/postmodern/ruby-install/releases/download/v${RUBY_INSTALL_VERSION}/ruby-install-${RUBY_INSTALL_VERSION}.tar.gz" \
  | tar -xz -C /tmp
cd "/tmp/ruby-install-${RUBY_INSTALL_VERSION}"
make install

# Install Ruby
ruby-install --system ruby "${VERSION}"

# Clean up
rm -rf "/tmp/ruby-install-${RUBY_INSTALL_VERSION}"

echo "Ruby ${VERSION} installed successfully."
