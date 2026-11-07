import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";

import { STELLA_MCP_APP_LIMITS } from "@stll/api-contract/stella-mcp-app";

import { chatMcpAppForTool } from "@/api/handlers/chat/mcp-apps/catalog";
import { appCallArgumentsHash } from "@/api/lib/desktop-runner/app-calls";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { McpRequestResources } from "@/api/mcp/context";

const APP_CALL_RECORD_SINK = failureSink({
  event: "mcp.agent_run_app_call_record_failed",
  expected: [],
});

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

type RecordAgentRunAppCallOptions = {
  context: Pick<
    McpRequestResources,
    "credential" | "organizationId" | "userId"
  >;
  toolName: string;
  args: Record<string, unknown>;
  result: CallToolResult;
  record?: DesktopRunnerControl["recordAppCall"];
};

/**
 * Keep what the server answered a local run for a tool a chat app presents,
 * so the chat turn reading the run can show the app from the server's own
 * answer rather than the desktop's copy. Only an agent-run token's call, of
 * a tool a chat app presents, that succeeded with structured content small
 * enough for a chat part, is kept. A failure to keep it never fails the
 * call: the run's own answer has already been decided.
 */
export const recordAgentRunAppCall = async ({
  context,
  toolName,
  args,
  result,
  record = async (options) =>
    await getDesktopRunnerControl().control.recordAppCall(options),
}: RecordAgentRunAppCallOptions): Promise<void> => {
  const { credential } = context;
  if (credential?.type !== "agent_run") {
    return;
  }
  const app = chatMcpAppForTool(toolName);
  const structuredContent = result.structuredContent;
  if (
    app === undefined ||
    result.isError === true ||
    !isPlainRecord(structuredContent)
  ) {
    return;
  }
  const carried = JSON.stringify({
    input: args,
    result: { structuredContent },
  });
  if (carried.length > STELLA_MCP_APP_LIMITS.payloadChars) {
    return;
  }
  const recorded = await record({
    owner: { userId: context.userId, organizationId: context.organizationId },
    runId: credential.runId,
    toolName,
    argumentsHash: appCallArgumentsHash(args),
    resourceUri: app.uri,
    result: structuredContent,
  });
  if (Result.isError(recorded)) {
    observeFailure(recorded.error, { sink: APP_CALL_RECORD_SINK });
  }
};
