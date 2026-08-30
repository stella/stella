import * as v from "valibot";

const nullableStringSchema = v.nullable(v.string());

const outlookWorkspaceSchema = v.object({
  client: v.nullable(
    v.object({
      displayName: v.string(),
    }),
  ),
  id: v.string(),
  lastActivityAt: nullableStringSchema,
  name: v.string(),
  reference: nullableStringSchema,
});

const outlookWorkspacesResponseSchema = v.object({
  workspaces: v.array(outlookWorkspaceSchema),
});

const outlookFilePropertySchema = v.object({
  content: v.object({ type: v.string() }),
  id: v.string(),
});

const outlookPropertiesResponseSchema = v.array(outlookFilePropertySchema);
const outlookPropertyCreatedResponseSchema = v.object({ id: v.string() });

const outlookPresignResponseSchema = v.variant("state", [
  v.object({
    state: v.literal("existing"),
    uploadId: v.string(),
  }),
  v.object({
    expiresAt: v.string(),
    headers: v.record(v.string(), v.string()),
    state: v.literal("reserved"),
    uploadId: v.string(),
    url: v.string(),
  }),
]);

const outlookEmailIngestResultSchema = v.object({
  attachmentEntityIds: v.array(v.string()),
  entityId: v.string(),
  fieldId: v.string(),
  type: v.literal("email_ingest"),
});

const outlookFinalizeResponseSchema = v.object({
  finalizedResult: outlookEmailIngestResultSchema,
});

const outlookReconcileResponseSchema = v.variant("state", [
  v.object({ state: v.literal("reserved") }),
  v.object({ state: v.literal("finalizing") }),
  v.object({ reason: v.string(), state: v.literal("retryable") }),
  v.object({ reason: v.string(), state: v.literal("rejected") }),
  v.object({
    finalizedResult: outlookEmailIngestResultSchema,
    state: v.literal("complete"),
  }),
]);

const outlookAIDraftResponseSchema = v.object({ draft: v.string() });
const outlookAISummaryResponseSchema = v.object({ summary: v.string() });

export type OutlookWorkspacesResponse = v.InferOutput<
  typeof outlookWorkspacesResponseSchema
>;
export type OutlookPropertiesResponse = v.InferOutput<
  typeof outlookPropertiesResponseSchema
>;
export type OutlookPropertyCreatedResponse = v.InferOutput<
  typeof outlookPropertyCreatedResponseSchema
>;
export type OutlookPresignResponse = v.InferOutput<
  typeof outlookPresignResponseSchema
>;
export type OutlookFinalizeResponse = v.InferOutput<
  typeof outlookFinalizeResponseSchema
>;
export type OutlookReconcileResponse = v.InferOutput<
  typeof outlookReconcileResponseSchema
>;
export type OutlookAIDraftResponse = v.InferOutput<
  typeof outlookAIDraftResponseSchema
>;
export type OutlookAISummaryResponse = v.InferOutput<
  typeof outlookAISummaryResponseSchema
>;

export const parseOutlookWorkspacesResponse = (input: unknown) =>
  v.safeParse(outlookWorkspacesResponseSchema, input);

export const parseOutlookPropertiesResponse = (input: unknown) =>
  v.safeParse(outlookPropertiesResponseSchema, input);

export const parseOutlookPropertyCreatedResponse = (input: unknown) =>
  v.safeParse(outlookPropertyCreatedResponseSchema, input);

export const parseOutlookPresignResponse = (input: unknown) =>
  v.safeParse(outlookPresignResponseSchema, input);

export const parseOutlookFinalizeResponse = (input: unknown) =>
  v.safeParse(outlookFinalizeResponseSchema, input);

export const parseOutlookReconcileResponse = (input: unknown) =>
  v.safeParse(outlookReconcileResponseSchema, input);

export const parseOutlookAIDraftResponse = (input: unknown) =>
  v.safeParse(outlookAIDraftResponseSchema, input);

export const parseOutlookAISummaryResponse = (input: unknown) =>
  v.safeParse(outlookAISummaryResponseSchema, input);
