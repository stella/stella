#!/usr/bin/env bash
set -euo pipefail

# The workflow supplies the union of inputs. Export only each former step's
# inputs to its command, especially the model key and review credentials.
export -n STAGING_STATE E2E_WEB_URL E2E_API_URL SMOKE_SESSION_SECRET \
  E2E_EDGE_HEADER_NAME E2E_EDGE_HEADER_VALUE EXPECTED_COMMIT SMOKE_AI_OPENAI_API_KEY \
  MCP_CANARY_ENVIRONMENT MCP_CANARY_BASE_URL MCP_CANARY_CONFIGURED_BASE_URL \
  MCP_CANARY_FRONTEND_URL MCP_CANARY_MODE MCP_CANARY_REQUIRE_CREDENTIALS \
  APP_REVIEW_ACCOUNT_EMAIL APP_REVIEW_ORGANIZATION_ID REVIEW_ACCOUNT_PASSWORD \
  RUN_WEB_SMOKE CORPUS_SEARCH_WAIVED

case "${1:?check name}" in
  web-smoke)
    export STAGING_STATE E2E_WEB_URL E2E_API_URL SMOKE_SESSION_SECRET \
      E2E_EDGE_HEADER_NAME E2E_EDGE_HEADER_VALUE EXPECTED_COMMIT
    # EXPECTED_COMMIT makes the web setup wait for the deployed revision.
    bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" bun --filter @stll/web test:e2e:staging
    ;;
  response-policy)
    export E2E_WEB_URL E2E_API_URL E2E_EDGE_HEADER_NAME E2E_EDGE_HEADER_VALUE
    bun apps/api/src/scripts/post-deploy-response-policy.ts
    ;;
  api-smoke|model-turn)
    export E2E_API_URL SMOKE_SESSION_SECRET E2E_EDGE_HEADER_NAME E2E_EDGE_HEADER_VALUE EXPECTED_COMMIT
    if [[ "$1" == model-turn ]]; then
      export SMOKE_AI_OPENAI_API_KEY
      SMOKE_AI_JOURNEY=only bun apps/api/src/scripts/post-deploy-smoke.ts "$E2E_API_URL"
    else
      SMOKE_AI_JOURNEY=skip bun apps/api/src/scripts/post-deploy-smoke.ts "$E2E_API_URL"
    fi
    ;;
  corpus-preflight)
    export E2E_API_URL E2E_EDGE_HEADER_NAME E2E_EDGE_HEADER_VALUE
    timeout 120 bash scripts/staging-corpus-preflight.sh
    ;;
  mcp-smoke)
    export MCP_CANARY_ENVIRONMENT MCP_CANARY_BASE_URL MCP_CANARY_CONFIGURED_BASE_URL \
      MCP_CANARY_FRONTEND_URL MCP_CANARY_MODE MCP_CANARY_REQUIRE_CREDENTIALS \
      APP_REVIEW_ACCOUNT_EMAIL APP_REVIEW_ORGANIZATION_ID REVIEW_ACCOUNT_PASSWORD \
      SMOKE_SESSION_SECRET E2E_EDGE_HEADER_NAME E2E_EDGE_HEADER_VALUE
    bun run canary:mcp
    ;;
  *) echo "::error::Unknown staging check: $1"; exit 1 ;;
esac
