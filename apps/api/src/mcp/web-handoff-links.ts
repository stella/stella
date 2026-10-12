import type { CallToolResult } from "@modelcontextprotocol/server";
import { panic } from "better-result";
import * as v from "valibot";

import {
  MCP_WEB_HANDOFF_TOOL_NAME,
  mcpWebHandoffLinkInputSchema,
  mcpWebHandoffLinkOutputSchema,
} from "@stll/api-contract/mcp-web-handoff";

import { getAppBaseUrl } from "@/api/lib/mcp-connectors/app-urls";
import { mintWebHandoff } from "@/api/lib/mcp-web-handoff";
import type { McpRequestContext } from "@/api/mcp/context";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import type {
  McpToolDefinition,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import {
  nullAsAbsent,
  validationErrorResult,
  toolDataResult,
} from "@/api/mcp/tool-utils";
import {
  defineValibotMcpTool,
  defineMcpToolOutput,
} from "@/api/mcp/valibot-tool-definition";
import { handoffLinkResult } from "@/api/mcp/web-handoff-links-core";

export const MCP_WEB_HANDOFF_TOOL = MCP_WEB_HANDOFF_TOOL_NAME;

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
          consentId: context.consentId ?? null,
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

const inputSchema = nullAsAbsent(mcpWebHandoffLinkInputSchema);
const outputSchema = mcpWebHandoffLinkOutputSchema;
const definition = defineValibotMcpTool({
  name: MCP_WEB_HANDOFF_TOOL_NAME,
  description:
    "App-only: refresh a web link when the user opens it. Returns a plain link when sign-in handoff is unavailable.",
  inputSchema,
  consumesServices: false,
  access: "read",
  readClass: "tenant",
  anonymized: { exposure: "excluded", reason: "credential_authority" },
  scope: "stella:read",
  annotations: {
    title: "Open web link",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: ["app"] } },
});
const handler: TypedMcpToolHandler<v.InferInput<typeof outputSchema>> = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(inputSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const result = await withWebHandoffLinks(
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
export const WEB_HANDOFF_TOOL_SET = defineMcpToolSet(
  [definition] as const satisfies readonly McpToolDefinition[],
  { [MCP_WEB_HANDOFF_TOOL_NAME]: handler },
  { [MCP_WEB_HANDOFF_TOOL_NAME]: defineMcpToolOutput(outputSchema) },
);
