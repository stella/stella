import type { ActionPeriodIdentity } from "@/api/lib/rate-limit/action-period-budget";

const MCP_TOOL_CALL_ACTION_KIND = "mcp.tools/call";

export const mcpActionPeriodIdentity = (): ActionPeriodIdentity => ({
  actionKind: MCP_TOOL_CALL_ACTION_KIND,
  // RPC IDs are client-chosen correlation tokens, not idempotency keys.
  logicalPhaseId: Bun.randomUUIDv7(),
});
