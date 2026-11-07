FROM node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b
WORKDIR /opt/scout
COPY worker/runtime/package.json worker/runtime/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY lib/catalog.mjs lib/brief.mjs lib/brief-reference.mjs lib/worker-protocol.mjs ./lib/
COPY research/SKILL.md ./research/SKILL.md
COPY worker/bridge.mjs worker/index.mjs worker/research.mjs worker/session.mjs ./worker/
ENV HOME=/workspace
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/scout/worker/index.mjs"]
CMD []
