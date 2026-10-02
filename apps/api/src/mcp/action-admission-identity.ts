import type { AdmittedActionIdentity } from "@/api/lib/rate-limit/action-kinds";

export const mcpActionPeriodIdentity = (
  consumesServices: boolean,
): AdmittedActionIdentity => ({
  actionKind: consumesServices ? "mcp.services/call" : "mcp.data/call",
  // RPC IDs are client-chosen correlation tokens, not idempotency keys.
  logicalPhaseId: Bun.randomUUIDv7(),
});
