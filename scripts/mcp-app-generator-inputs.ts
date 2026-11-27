/**
 * Script entry points executed by `scripts/prepare-mcp-apps.ts` and
 * `apps/api/scripts/generate-capability-runtime.ts` during E2E setup.
 * Shared between `scripts/generated-files.ts` and
 * `scripts/detect-route-smoke-changes.ts` so both stay in sync without
 * adding file readers to static root-check closures.
 */
export const MCP_APP_CONTRACT_SCRIPT_INPUTS = [
  "apps/api/scripts/generate-mcp-app-contracts.ts",
  "apps/api/scripts/lib/mcp-app-inputs.ts",
  "scripts/generated-artifacts.ts",
] as const;
