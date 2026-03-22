FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    iptables \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash knox \
    && git config --global user.email "knox@localhost" \
    && git config --global user.name "Knox Agent"

WORKDIR /workspace

USER knox

CMD ["sleep", "infinity"]
