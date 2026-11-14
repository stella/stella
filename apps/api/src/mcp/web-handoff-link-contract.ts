import {
  MCP_WEB_HANDOFF_TOOL_NAME,
  mcpWebHandoffLinkInputSchema,
  mcpWebHandoffLinkOutputSchema,
} from "@stll/api-contract/mcp-web-handoff";

import type { defineValibotMcpTool } from "@/api/mcp/valibot-tool-definition";

const definition = {
  name: MCP_WEB_HANDOFF_TOOL_NAME,
  description:
    "App-only: refresh a web link when the user opens it. Returns a plain link when sign-in handoff is unavailable.",
  consumesServices: false,
  access: "write",
  permissions: {
    type: "delegated",
    reason:
      "The mint operation verifies the current OAuth consent and its live user grant.",
  },
  accountAccess: "standard",
  anonymized: { exposure: "excluded", reason: "credential_authority" },
  scope: "stella:read",
  annotations: {
    title: "Open web link",
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  nonDestructiveReason:
    "Adds an expiring handoff credential tied to existing user consent; it does not modify workspace records.",
  _meta: { ui: { visibility: ["app"] } },
} as const satisfies Omit<
  Extract<
    Parameters<typeof defineValibotMcpTool>[0],
    { access: "write"; annotations: { destructiveHint: false } }
  >,
  "inputSchema"
>;

/** Pure contract metadata shared by runtime registration and app generation. */
export const WEB_HANDOFF_TOOL_CONTRACT = {
  definition,
  inputSchema: mcpWebHandoffLinkInputSchema,
  outputSchema: mcpWebHandoffLinkOutputSchema,
} as const;
