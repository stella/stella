import * as v from "valibot";

import { OUTLOOK_AI_INPUT_MAX_CHARS } from "@stll/api-contract/outlook-ai";

const INTENT_MAX_CHARS = 2000;
const ORIGINAL_SUBJECT_MAX_CHARS = 500;
const ORIGINAL_FROM_MAX_CHARS = 320;
const LANGUAGE_MAX_CHARS = 32;

// The length bound applies to the text as sent, before trimming, so a request
// can never make the server trim more than the bound.
const requiredText = (maxLength: number) =>
  v.pipe(v.string(), v.maxLength(maxLength), v.trim(), v.minLength(1));

const optionalText = (maxLength: number) =>
  v.optional(v.pipe(v.string(), v.maxLength(maxLength), v.trim()));

export const summarizeEmailBodySchema = v.strictObject({
  text: requiredText(OUTLOOK_AI_INPUT_MAX_CHARS),
  language: optionalText(LANGUAGE_MAX_CHARS),
});

export type SummarizeEmailBody = v.InferOutput<typeof summarizeEmailBodySchema>;

export const draftEmailBodySchema = v.strictObject({
  intent: requiredText(INTENT_MAX_CHARS),
  originalSubject: optionalText(ORIGINAL_SUBJECT_MAX_CHARS),
  originalBody: v.pipe(
    v.string(),
    v.maxLength(OUTLOOK_AI_INPUT_MAX_CHARS),
    v.trim(),
  ),
  originalFrom: optionalText(ORIGINAL_FROM_MAX_CHARS),
  language: optionalText(LANGUAGE_MAX_CHARS),
});

export type DraftEmailBody = v.InferOutput<typeof draftEmailBodySchema>;
