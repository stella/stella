#!/usr/bin/env bash
set -eo pipefail
bash .workflow-tooling/scripts/retry.sh docker pull "$POSTGRES_IMAGE"
bash .workflow-tooling/scripts/retry.sh docker pull "$REDIS_IMAGE"
