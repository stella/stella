#!/usr/bin/env bash
set -eo pipefail
bun build packages/agent-engine/scripts/mcp-canary-server.ts \
  --target=node \
  --outfile="$RUNNER_TEMP/mcp-canary-server.mjs"
docker run --detach \
  --name "$NETWORK_CANARY_CONTAINER" \
  --network "$AGENT_ENGINE_DOCKER_NETWORK" \
  --network-alias stella-agent-network-canary \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --tmpfs /state:rw,noexec,nosuid,size=1m,mode=1777 \
  --volume "$RUNNER_TEMP/mcp-canary-server.mjs:/workspace/mcp-canary-server.mjs:ro" \
  "$AGENT_ENGINE_DOCKER_IMAGE" \
  node /workspace/mcp-canary-server.mjs
for _ in {1..40}; do
  if docker exec "$NETWORK_CANARY_CONTAINER" node -e \
    'fetch("http://127.0.0.1:8787/health", { signal: AbortSignal.timeout(1000) }).then(async (response) => process.exit(response.ok && await response.text() === "sandbox-network-canary" ? 0 : 1), () => process.exit(1))'; then
    exit 0
  fi
  sleep 0.1
done
docker logs "$NETWORK_CANARY_CONTAINER"
exit 1
