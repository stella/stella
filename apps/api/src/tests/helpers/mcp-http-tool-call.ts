import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";

import { toSafeId } from "@/api/lib/branded-types";
import { withActionAdmission } from "@/api/lib/rate-limit/action-admission";
import { MCP_ALL_RESOURCE_SCOPES, type McpMode } from "@/api/mcp/constants";
import type { McpRequestContext } from "@/api/mcp/context";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { listOfferedStaticMcpToolDefinitions } from "@/api/mcp/gateway/static-tool-visibility";
import { createMcpHttpRequestHandler } from "@/api/mcp/server-core";
import {
  getMcpToolDefinition,
  getMcpToolRequiredScopesHint,
  handleMcpToolCall,
} from "@/api/mcp/tools";
import { createTestDemoActionBudget } from "@/api/tests/helpers/demo-action-budget";
import { readTestJson } from "@/api/tests/helpers/test-tool-set";

type McpHttpToolCallOptions = {
  /** Replaces the admission step, so a test can observe whether it ran. */
  admitAction?: typeof withActionAdmission;
  args: Record<string, unknown>;
  context: McpRequestContext;
  mode: McpMode;
  toolName: string;
};

/**
 * A `tools/call` over the HTTP transport the CLI and every remote client use,
 * with the production tool lookup, admission and dispatch. Only the session,
 * its context and the demo action counter's store are stubbed, so the answer
 * is the one the server's own ordering produces. The session holds every scope: scope
 * refusals are covered elsewhere and would mask the decision under test.
 */
export const callMcpToolOverHttp = async ({
  admitAction,
  args,
  context,
  mode,
  toolName,
}: McpHttpToolCallOptions): Promise<CallToolResult> => {
  // The session's user is not the demo account, so its budget never counts.
  const demo = createTestDemoActionBudget({
    demoUserId: toSafeId<"user">("demo_user"),
    nowMs: Date.UTC(2026, 0, 15),
  });
  const handler = createMcpHttpRequestHandler({
    admitAction:
      admitAction ??
      (async (options) =>
        await withActionAdmission({
          ...options,
          demoActionBudget: demo.budget,
        })),
    authenticateMcpRequest: async () =>
      await Promise.resolve(
        Result.ok({
          organizationId: "org_1",
          scopes: [...MCP_ALL_RESOURCE_SCOPES],
          userId: "user_1",
        }),
      ),
    captureError: () => undefined,
    getMcpToolDefinition,
    getMcpToolRequiredScopesHint,
    handleMcpToolCall,
    listMcpResources: () => [],
    // The static offer only: the dynamic families read the database.
    listMcpTools: async (listContext, listMode = "default") =>
      await Promise.resolve(
        toMcpTools(
          listOfferedStaticMcpToolDefinitions({
            context: listContext,
            mode: listMode,
          }),
          { mode: listMode, context: listContext },
        ),
      ),
    readMcpResource: () => ({ contents: [] }),
    recordMcpSessionInitialized: () => undefined,
    resolveMcpSessionContext: async () => await Promise.resolve(context),
  });
  const response = await handler(
    new Request("http://localhost/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      method: "POST",
    }),
    { mode },
  );
  const body = await readTestJson<{ result: CallToolResult }>(response);
  return body.result;
};
