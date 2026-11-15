# Cloud agent-sandbox image. Ships the codex harness CLI so the
# TanStack sandbox can spawn `codex exec --experimental-json` inside an
# isolated container. The model credential (CODEX_API_KEY) and the scoped
# stella MCP token are injected at run time by the engine — never baked here.
#
# Build:
#   docker build -f packages/agent-engine/docker/sandbox.Dockerfile \
#     -t stella/agent-sandbox:dev packages/agent-engine/docker
#
FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072

# Pin the harness CLI. Bump deliberately; the pinned-content CI check and the
# engine both assume a known codex surface.
ARG CODEX_VERSION=0.144.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @openai/codex@${CODEX_VERSION} \
  && npm cache clean --force

# Non-root: the agent process never needs root inside the sandbox. Create the
# workspace explicitly so its ownership does not depend on builder-specific
# WORKDIR behavior.
RUN useradd --uid 10000 --create-home --shell /bin/bash agent \
  && mkdir -p /workspace \
  && chown agent:agent /workspace
USER agent
WORKDIR /workspace

# Sanity: the harness must be on PATH for the adapter's spawn to resolve.
RUN codex --version
