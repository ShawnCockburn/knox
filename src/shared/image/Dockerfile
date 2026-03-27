FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git \
    iptables \
    apt-utils \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js and Claude Code CLI into /opt/claude/ (isolated from user PATH)
ENV CLAUDE_HOME=/opt/claude
RUN mkdir -p ${CLAUDE_HOME} \
    && curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz \
       | tar -xJ --strip-components=1 -C ${CLAUDE_HOME} \
    && ${CLAUDE_HOME}/bin/npm install -g @anthropic-ai/claude-code \
    && ln -sf ${CLAUDE_HOME}/lib/node_modules/@anthropic-ai/claude-code/cli.cjs ${CLAUDE_HOME}/bin/claude

RUN useradd -m -s /bin/bash knox \
    && git config --global user.email "knox@localhost" \
    && git config --global user.name "Knox Agent"

WORKDIR /workspace

USER knox

CMD ["sleep", "infinity"]
