#!/usr/bin/env bash
set -eo pipefail
docker ps --all --quiet --filter "ancestor=$AGENT_ENGINE_DOCKER_IMAGE" | xargs --no-run-if-empty docker rm --force
docker network rm "$AGENT_ENGINE_DOCKER_NETWORK" 2>/dev/null || true
