import * as v from "valibot";

export const MCP_HANDOFF_STEP_UP_REQUIRED = "step_up_required";

export const mcpHandoffSessionsSchema = v.strictObject({
  sessions: v.array(
    v.strictObject({ id: v.string(), clientName: v.nullable(v.string()) }),
  ),
});

export const mcpHandoffRedeemResultSchema = v.variant("status", [
  v.object({ status: v.literal("redeemed") }),
  v.object({
    status: v.literal("needs_confirmation"),
    email: v.string(),
    organizationName: v.string(),
  }),
  v.object({ status: v.literal("refused") }),
]);

export const MCP_WEB_HANDOFF_TOOL_NAME = "mint_web_handoff";
export const mcpWebHandoffLinkInputSchema = v.strictObject({
  url: v.pipe(
    v.string(),
    v.maxLength(8192),
    v.description("Web URL the user chose to open."),
  ),
});

export const mcpWebHandoffLinkOutputSchema = v.strictObject({
  url: v.string(),
});
