#!/usr/bin/env bash
# Install CPython via deadsnakes PPA.
# Usage: install.sh <version>
# Must run as root. Idempotent.
set -euo pipefail

VERSION="${1:?Usage: install.sh <version>}"

# Skip if already installed at the requested version
if command -v "python${VERSION}" &>/dev/null; then
  echo "python${VERSION} already installed, skipping."
  exit 0
fi

apt-get update -qq
apt-get install -y -qq software-properties-common
add-apt-repository -y ppa:deadsnakes/ppa
apt-get update -qq
apt-get install -y -qq "python${VERSION}" "python${VERSION}-venv"

# Ensure pip is available
"python${VERSION}" -m ensurepip --upgrade 2>/dev/null || true

# Set up unversioned symlinks
update-alternatives --install /usr/bin/python3 python3 "/usr/bin/python${VERSION}" 1
update-alternatives --install /usr/bin/python python "/usr/bin/python${VERSION}" 1
ln -sf /usr/bin/python3 /usr/bin/pip3-wrapper

# Make pip available via simple symlinks
"python${VERSION}" -m pip install --upgrade pip 2>/dev/null || true
ln -sf "/usr/bin/python${VERSION}" /usr/local/bin/python
ln -sf "/usr/bin/python${VERSION}" /usr/local/bin/python3

# Create pip wrapper that uses the correct python
cat > /usr/local/bin/pip <<'PIPEOF'
#!/bin/sh
exec python3 -m pip "$@"
PIPEOF
chmod +x /usr/local/bin/pip
cp /usr/local/bin/pip /usr/local/bin/pip3

echo "Python ${VERSION} installed successfully."
