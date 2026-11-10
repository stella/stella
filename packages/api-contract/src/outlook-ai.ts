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

/** `POST /v1/ai/summarize`: a plain-text summary of one email. */
export type OutlookAISummaryResponse = v.InferOutput<
  typeof outlookAISummaryResponseSchema
>;
/** `POST /v1/ai/draft-email`: a plain-text reply body. */
export type OutlookAIDraftResponse = v.InferOutput<
  typeof outlookAIDraftResponseSchema
>;

export const parseOutlookAISummaryResponse = (input: unknown) =>
  v.safeParse(outlookAISummaryResponseSchema, input);

export const parseOutlookAIDraftResponse = (input: unknown) =>
  v.safeParse(outlookAIDraftResponseSchema, input);
