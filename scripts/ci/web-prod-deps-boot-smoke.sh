#!/usr/bin/env bash
set -euo pipefail
# Reproduce apps/web/Dockerfile's deps-prod stage exactly. Wipe
# node_modules first (a plain --production reinstall only skips ADDING
# devDeps; it does not prune ones the build install already placed),
# and scope to @stll/web — an unfiltered install pulls other apps' deps
# and could mask a package the web runtime reaches but @stll/web never
# declared. dist/ and .env are untouched.
rm -rf node_modules
bun scripts/ci-install.ts "$RUNNER_TEMP/bun-install/web-production.log" --filter @stll/web --production --frozen-lockfile --ignore-scripts
cd apps/web
PORT=3199 HOST=127.0.0.1 bun dist/runtime.js &
server_pid=$!
ready=
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3199/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
kill "$server_pid" 2>/dev/null || true
if [[ "$ready" != "1" ]]; then
  echo "web SSR runtime failed to boot under --production deps" >&2
  exit 1
fi
