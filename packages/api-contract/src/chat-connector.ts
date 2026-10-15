import * as v from "valibot";

export const CONNECT_CONNECTOR_TOOL_NAME = "connect_connector";

const connectorSlugSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(80));

export const connectConnectorInputSchema = v.strictObject({
  connectorSlug: connectorSlugSchema,
  purpose: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
});
export const connectConnectorOutputSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("connected"),
    connectorSlug: connectorSlugSchema,
  }),
  v.strictObject({
    status: v.literal("declined"),
    connectorSlug: connectorSlugSchema,
  }),
]);
export const CONNECT_CONNECTOR_DECISIONS = ["connected", "declined"] as const;
/** The card's report; the server decides whether `connected` is true. */
export const connectConnectorSubmissionSchema = v.strictObject({
  decision: v.picklist(CONNECT_CONNECTOR_DECISIONS),
});

export type ConnectConnectorInput = v.InferOutput<
  typeof connectConnectorInputSchema
>;
export type ConnectConnectorOutput = v.InferOutput<
  typeof connectConnectorOutputSchema
>;
export type ConnectConnectorDecision =
  (typeof CONNECT_CONNECTOR_DECISIONS)[number];
