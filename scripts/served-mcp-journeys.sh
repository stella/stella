#!/usr/bin/env bash
set -euo pipefail

# Boot the release API bundle on Bun.serve against disposable Postgres and
# Valkey, then run the deployed MCP journeys (apps/api/src/scripts/mcp-canary.ts)
# against it over a real socket. In-process requests never exercise what a
# client sends over the wire; this does.
#
# The caller provides migrated-or-empty services through DATABASE_URL and
# REDIS_URL and an installed workspace. Never reads repository .env files for
# the server: its environment is the release configuration below.
if [[ $# != 0 ]]; then
  echo "Usage: DATABASE_URL=... REDIS_URL=... bash scripts/served-mcp-journeys.sh" >&2
  exit 2
fi
: "${DATABASE_URL:?DATABASE_URL must name the disposable database}"
: "${REDIS_URL:?REDIS_URL must name the disposable cache}"
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
port=${SERVED_MCP_API_PORT:-3101}
work=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/served-mcp.XXXXXX")
bundle="$work/bundle"
api_log=${SERVED_MCP_API_LOG:-$work/api.log}
api_pid=""
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  if [[ "$status" != 0 && -f "$api_log" ]]; then
    echo "--- last API log lines ---" >&2
    tail -100 "$api_log" >&2 || true
  fi
  rm -rf "$bundle"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$repo"
bun --filter @stll/api generate:capability-runtime
# Disposable database: online index builds must not wait on EBS metrics or a
# wall-clock busy window.
migrate_log="$work/migrate.log"
if ! (
  cd apps/api
  NODE_ENV=development STELLA_LOCAL_DEV=1 DB_LOAD_GATE_EBS_SIGNAL=disabled \
    DB_LOAD_GATE_BUSY_WINDOWS='[]' bun --no-env-file src/db/migrate.ts
) > "$migrate_log" 2>&1; then
  tail -50 "$migrate_log" >&2
  echo "Migrations failed on the disposable database." >&2
  exit 1
fi
echo "Migrations applied"
bun apps/api/scripts/build-server-bundle.ts "$bundle"

origin="http://127.0.0.1:$port"
smoke_secret=$(openssl rand -hex 32)
# Release runtime: NODE_ENV=production without local development access,
# action admission and the size limits enabled as on the hosted deployment.
# Outbound integrations point at closed loopback ports; no journey uses them.
(
  cd apps/api
  exec env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
    NODE_ENV=production REQUIRE_PERSONAL_AI_KEY=true PORT="$port" \
    STELLA_YARA_RULES_DIR="$repo/apps/api/src/lib/file-scan/yara" \
    DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
    DB_LOAD_GATE_EBS_SIGNAL=disabled DB_LOAD_GATE_BUSY_WINDOWS='[]' \
    BETTER_AUTH_SECRET="$(openssl rand -hex 32)" BETTER_AUTH_URL="$origin" \
    FRONTEND_URL="$origin" \
    CONTENT_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
    SMOKE_SESSION_SECRET="$smoke_secret" \
    FEATURE_ACTION_ADMISSION=true \
    ACTION_REQUEST_MAX_BYTES=1048576 ACTION_RESPONSE_MAX_BYTES=1048576 \
    ACTION_PAGE_SIZE_MAX=100 \
    EMAIL_PROVIDER=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025 \
    TRANSACTIONAL_EMAIL_FROM=noreply@example.invalid \
    GOOGLE_GENERATIVE_AI_API_KEY=served-journeys USE_MOCK_AI=false \
    GOTENBERG_URL=http://127.0.0.1:9 GOTENBERG_USERNAME=served GOTENBERG_PASSWORD=served \
    POSTHOG_HOST=http://127.0.0.1:9 POSTHOG_KEY=phc_ \
    S3_BUCKET=served-journeys S3_ENDPOINT=http://127.0.0.1:9 S3_REGION=us-east-1 \
    bun --no-env-file "$bundle/server.js"
) > "$api_log" 2>&1 &
api_pid=$!

ready=false
for ((attempt = 0; attempt < 90; attempt++)); do
  if curl --connect-timeout 2 --max-time 5 -sf "$origin/live" > /dev/null 2>&1; then
    ready=true
    break
  fi
  kill -0 "$api_pid" 2>/dev/null || break
  sleep 1
done
[[ "$ready" == true ]] || { echo "The API bundle never answered /live." >&2; exit 1; }
echo "API bundle serving on $origin"

# The journeys mint their credentials from the smoke session, as on a hosted
# preview. Third-party client metadata hosts are off: this run proves the
# served contract, not their availability.
MCP_CANARY_ENVIRONMENT=staging \
  MCP_CANARY_MODE=full \
  MCP_CANARY_BASE_URL="$origin" \
  MCP_CANARY_CONFIGURED_BASE_URL="$origin" \
  MCP_CANARY_FRONTEND_URL="$origin" \
  MCP_CANARY_THIRD_PARTY_FETCHES=skip \
  SMOKE_SESSION_SECRET="$smoke_secret" \
  bun run canary:mcp
