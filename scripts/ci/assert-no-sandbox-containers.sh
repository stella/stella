#!/usr/bin/env bash
set -eo pipefail
mapfile -t container_ids < <(
  docker ps --all --no-trunc --quiet --filter "ancestor=$AGENT_ENGINE_DOCKER_IMAGE"
)
if [[ "${#container_ids[@]}" -ne 1 || "${container_ids[0]}" != "$(docker inspect --format '{{.Id}}' "$NETWORK_CANARY_CONTAINER")" ]]; then
  echo "::error title=Sandbox cleanup failed::Unexpected sandbox image container survived the integration suite."
  docker ps --all --filter "ancestor=$AGENT_ENGINE_DOCKER_IMAGE"
  exit 1
fi
