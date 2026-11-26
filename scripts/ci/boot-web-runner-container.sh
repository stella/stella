#!/usr/bin/env bash
set -euo pipefail
docker run --detach --name web-runner \
  --publish 127.0.0.1:3199:3002 stella-web-runner:ci
ready=
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3199/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
docker logs web-runner
if [[ "$ready" != "1" ]]; then
  echo "web runner image failed to serve /health" >&2
  exit 1
fi
