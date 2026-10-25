import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import * as v from "valibot";

import { mintWebHandoff } from "@/api/lib/auth";
import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import type { McpRequestContext } from "@/api/mcp/context";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import type {
  McpToolDefinition,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import {
  nullAsAbsent,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { WEB_HANDOFF_TOOL_CONTRACT } from "@/api/mcp/web-handoff-link-contract";
import { handoffLinkResult } from "@/api/mcp/web-handoff-links-core";

export const MCP_WEB_HANDOFF_TOOL = WEB_HANDOFF_TOOL_CONTRACT.definition.name;

export const withWebHandoffLinks = async (
  result: CallToolResult,
  context: McpRequestContext,
  kind: "text" | "click" = "text",
): Promise<CallToolResult> => {
  if (context.credentialType !== "oauth") {
    return result;
  }
  return await handoffLinkResult({
    result,
    appBaseUrl: getAppBaseUrl(),
    mint: async (paths) =>
      await mintWebHandoff(
        {
          userId: context.userId,
          organizationId: context.organizationId,
          credentialType: context.credentialType ?? "anonymous",
          clientId: context.clientId ?? null,
          grantedScopes: context.grantedScopes,
          ipAddress: context.clientIp ?? null,
          userAgent: context.request?.headers.get("user-agent") ?? null,
          ...(context.request === undefined
            ? {}
            : { request: context.request }),
        },
        paths,
        kind,
      ),
  });
};

const inputSchema = nullAsAbsent(WEB_HANDOFF_TOOL_CONTRACT.inputSchema);
const { outputSchema } = WEB_HANDOFF_TOOL_CONTRACT;
const definition = defineValibotMcpTool({
  ...WEB_HANDOFF_TOOL_CONTRACT.definition,
  inputSchema,
});
export const createWebHandoffToolSet = (decorate = withWebHandoffLinks) => {
  const handler: TypedMcpToolHandler<
    v.InferInput<typeof outputSchema>
  > = async ({ args, context }) => {
    const parsed = v.safeParse(inputSchema, args);
    if (!parsed.success) {
      return validationErrorResult(parsed.issues);
    }
    const result = await decorate(
      { content: [], structuredContent: { url: parsed.output.url } },
      context,
      "click",
    );
    const output = v.safeParse(outputSchema, result.structuredContent);
    if (!output.success) {
      return panic("Web handoff link result must preserve its URL field");
    }
    return toolDataResult(output.output);
  };
  return defineMcpToolSet(
    [definition] as const satisfies readonly McpToolDefinition[],
    { [MCP_WEB_HANDOFF_TOOL]: handler },
    { [MCP_WEB_HANDOFF_TOOL]: defineMcpToolOutput(outputSchema) },
  );
};

export const WEB_HANDOFF_TOOL_SET = createWebHandoffToolSet();
