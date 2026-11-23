FROM node:24-slim
WORKDIR /opt/scout
COPY worker/runtime/package.json worker/runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY lib/supplied-passages.mjs lib/catalog.mjs lib/brief.mjs lib/brief-validation.mjs lib/brief-reference.mjs lib/public-url.mjs lib/worker-protocol.mjs lib/worker-failure.mjs lib/worker-usage.mjs ./lib/
COPY research/SKILL.md ./research/SKILL.md
COPY worker/bridge.mjs worker/index.mjs worker/research.mjs worker/session.mjs ./worker/
ENV HOME=/workspace
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/scout/worker/index.mjs"]
CMD []
