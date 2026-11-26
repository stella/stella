#!/usr/bin/env bash
set -eo pipefail
bun .workflow-tooling/scripts/ci-service-images.ts --build packages/agent-engine/docker/sandbox.Dockerfile -- --file packages/agent-engine/docker/sandbox.Dockerfile --tag "$AGENT_ENGINE_DOCKER_IMAGE" packages/agent-engine/docker
