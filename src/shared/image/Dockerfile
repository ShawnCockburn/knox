FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git \
    iptables \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash knox \
    && git config --global user.email "knox@localhost" \
    && git config --global user.name "Knox Agent"

WORKDIR /workspace

USER knox

CMD ["sleep", "infinity"]
