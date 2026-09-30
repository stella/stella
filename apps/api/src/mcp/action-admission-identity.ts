import type { ActionPeriodIdentity } from "@/api/lib/rate-limit/action-period-budget";

const MCP_TOOL_CALL_ACTION_KIND = "mcp.tools/call";

type McpActionIdentityOptions = {
  sessionId: string | undefined;
  rpcId: string | number;
  requestId: string;
};

export const mcpActionPeriodIdentity = ({
  sessionId,
  rpcId,
  requestId,
}: McpActionIdentityOptions): ActionPeriodIdentity => ({
  actionKind: MCP_TOOL_CALL_ACTION_KIND,
  // JSON encoding preserves both the session boundary and the RPC ID's type.
  logicalPhaseId:
    sessionId === undefined ? requestId : JSON.stringify([sessionId, rpcId]),
});
