FROM node:22-slim

RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN git config --global user.email "knox@localhost" \
    && git config --global user.name "Knox Agent"

WORKDIR /workspace

CMD ["sleep", "infinity"]
