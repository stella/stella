import * as v from "valibot";

export const REQUEST_SECRET_TOOL_NAME = "request_secret";
export const USE_CONNECTOR_SECRET_TOOL_NAME = "use_connector_secret";
export const CHAT_SECRET_KINDS = ["token", "password", "key"] as const;
export const chatSecretTargetSchema = v.strictObject({
  type: v.literal("mcp-connector"),
  connectorSlug: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
});
export const requestSecretInputSchema = v.strictObject({
  purpose: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  kind: v.picklist(CHAT_SECRET_KINDS),
  target: chatSecretTargetSchema,
  formatHint: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export const requestSecretOutputSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("provided"),
    secretRef: v.pipe(v.string(), v.uuid()),
    target: chatSecretTargetSchema,
  }),
  v.strictObject({
    status: v.literal("declined"),
    target: chatSecretTargetSchema,
  }),
]);
export type RequestSecretInput = v.InferOutput<typeof requestSecretInputSchema>;
export type RequestSecretOutput = v.InferOutput<
  typeof requestSecretOutputSchema
>;
export type ChatSecretTarget = v.InferOutput<typeof chatSecretTargetSchema>;
