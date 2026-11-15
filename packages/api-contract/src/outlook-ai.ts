import * as v from "valibot";

/** Maximum email text accepted by the Outlook AI endpoints. */
export const OUTLOOK_AI_INPUT_MAX_CHARS = 20_000;

/** The other field limits of the Outlook AI endpoints, as sent. */
export const OUTLOOK_AI_INTENT_MAX_CHARS = 2000;
export const OUTLOOK_AI_SUBJECT_MAX_CHARS = 500;
export const OUTLOOK_AI_FROM_MAX_CHARS = 320;
export const OUTLOOK_AI_LANGUAGE_MAX_CHARS = 32;

/** Keep client requests within the endpoint's email-text boundary. */
export const truncateOutlookAIInput = (value: string): string =>
  value.slice(0, OUTLOOK_AI_INPUT_MAX_CHARS);

const outlookAISummaryResponseSchema = v.object({ summary: v.string() });
const outlookAIDraftResponseSchema = v.object({ draft: v.string() });
const outlookAIAskSourceSchema = v.object({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  entityId: v.string(),
  workspaceId: v.string(),
  fieldId: v.nullable(v.string()),
  title: v.string(),
});
const outlookAIAskResponseSchema = v.object({
  answer: v.string(),
  sources: v.array(outlookAIAskSourceSchema),
});

/** `POST /v1/ai/summarize`: a plain-text summary of one email. */
export type OutlookAISummaryResponse = v.InferOutput<
  typeof outlookAISummaryResponseSchema
>;
/** `POST /v1/ai/draft-email`: a plain-text reply body. */
export type OutlookAIDraftResponse = v.InferOutput<
  typeof outlookAIDraftResponseSchema
>;

/**
 * One matter document an answer drew on. `number` is the `[n]` marker the
 * answer cites it with; `fieldId` opens the document's file, null when the
 * result has none (a task, a folder).
 */
export type OutlookAIAskSource = v.InferOutput<typeof outlookAIAskSourceSchema>;
/**
 * `POST /v1/ai/ask-email`: a plain-text answer about one email. With a matter
 * named, the answer may cite that matter's documents as `[n]`; `sources`
 * lists the cited ones in marker order.
 */
export type OutlookAIAskResponse = v.InferOutput<
  typeof outlookAIAskResponseSchema
>;

export const parseOutlookAISummaryResponse = (input: unknown) =>
  v.safeParse(outlookAISummaryResponseSchema, input);

export const parseOutlookAIDraftResponse = (input: unknown) =>
  v.safeParse(outlookAIDraftResponseSchema, input);

export const parseOutlookAIAskResponse = (input: unknown) =>
  v.safeParse(outlookAIAskResponseSchema, input);
