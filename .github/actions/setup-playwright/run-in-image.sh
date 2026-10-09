#!/usr/bin/env bash
set -euo pipefail

workspace=${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}
image=$(cat "$workspace/.github/actions/setup-playwright/image.txt")
if [[ ! "$image" =~ ^mcr\.microsoft\.com/playwright:v[0-9]+\.[0-9]+\.[0-9]+-noble@sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::Playwright image must be pinned by version and digest" >&2
  exit 1
fi
if [[ "${CI_IMAGE_MIRROR_ENABLED:-false}" == true ]]; then
  image=$(bun "$workspace/scripts/ci-service-images.ts" --image "$image")
fi
network=host
if [[ "${1:-}" == --offline ]]; then
  network=none
  shift
fi
if [[ "$#" -eq 0 ]]; then
  echo "::error::A browser command is required" >&2
  exit 1
fi
# Safe Chain may put a shell shim on PATH; mount Bun's native executable.
bun_binary=$(bun -p 'process.execPath')
# Isolated global-store entries link outside the workspace into this cache.
bun_cache=$(bun pm cache)
if [[ "$bun_cache" != /* || ! -d "$bun_cache" ]]; then
  echo "::error::Bun install cache is missing or is not an absolute path" >&2
  exit 1
fi
if [[ "$network" == none ]]; then
  echo "Bun install cache: $bun_cache"
  readlink "$workspace/apps/web/node_modules/@playwright/test" || true
  realpath "$workspace/apps/web/node_modules/@playwright/test"
fi
args=(run --rm --init --ipc=host --network "$network"
  --user "$(id -u):$(id -g)"
  --volume "$workspace:$workspace"
  --volume "$bun_cache:$bun_cache:ro"
  --env "BUN_INSTALL_CACHE_DIR=$bun_cache"
  --volume "$bun_binary:/usr/local/bin/bun:ro"
  --volume "$bun_binary:/usr/local/bin/bunx:ro"
  --workdir "$PWD"
  --env HOME=/tmp/playwright-home
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
  --env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)
# Forward browser inputs only, never runner tokens or the Docker socket.
for key in BROWSERS CI NODE_ENV E2E_EXECUTION_PROFILE E2E_EXPECT_DEV_ROUTES E2E_OUTPUT_DIR \
  E2E_WEB_URL E2E_API_URL E2E_LANDING_URL E2E_NETWORK_BASELINE \
  E2E_SOAK_SEED E2E_SOAK_STEPS E2E_SOAK_REPLAY \
  E2E_EDGE_HEADER_NAME E2E_EDGE_HEADER_VALUE SMOKE_SESSION_SECRET \
  STAGING_STATE EXPECTED_COMMIT PLAYWRIGHT_BLOB_OUTPUT_NAME PLAYWRIGHT_JSON_OUTPUT_FILE \
  MARKETING_CAPTURE MARKETING_COMMIT MARKETING_THEME GITHUB_SHA GITHUB_WORKSPACE; do
  if printenv "$key" >/dev/null; then
    args+=(--env "$key")
  fi
done
if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "$GITHUB_STEP_SUMMARY" ]]; then
  args+=(--env GITHUB_STEP_SUMMARY --volume "$GITHUB_STEP_SUMMARY:$GITHUB_STEP_SUMMARY")
fi
exec docker "${args[@]}" "$image" bash -euc 'mkdir -p "$HOME"; exec "$@"' -- "$@"
