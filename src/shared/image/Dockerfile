FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git \
    iptables \
    apt-utils \
    unzip \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js and Claude Code CLI into /opt/claude/ (isolated from user PATH)
ENV CLAUDE_HOME=/opt/claude
RUN mkdir -p ${CLAUDE_HOME} \
    && curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz \
       | tar -xJ --strip-components=1 -C ${CLAUDE_HOME} \
    && ${CLAUDE_HOME}/bin/node ${CLAUDE_HOME}/bin/npm install -g @anthropic-ai/claude-code \
    && rm -f ${CLAUDE_HOME}/bin/claude \
    && printf '#!/bin/sh\nexec /opt/claude/bin/node /opt/claude/lib/node_modules/@anthropic-ai/claude-code/cli.js "$@"\n' > ${CLAUDE_HOME}/bin/claude \
    && chmod +x ${CLAUDE_HOME}/bin/claude

# Install Codex CLI into /opt/codex/ (isolated from user PATH)
ENV CODEX_HOME=/opt/codex
RUN mkdir -p ${CODEX_HOME} \
    && ${CLAUDE_HOME}/bin/npm install -g --prefix ${CODEX_HOME} @openai/codex

RUN useradd -m -s /bin/bash knox \
    && git config --global user.email "knox@localhost" \
    && git config --global user.name "Knox Agent"

WORKDIR /workspace

USER knox

CMD ["sleep", "infinity"]
