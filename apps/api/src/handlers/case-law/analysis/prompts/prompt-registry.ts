/**
 * Prompt dispatcher. Resolves the system prompt written for the decision's
 * language, and refuses a language that has none: a prompt in another
 * language would steer the model to headings, holdings and topics that do
 * not match the text.
 */

import { Result, TaggedError } from "better-result";

import { CS_SYSTEM_PROMPT } from "./cs";
import { DE_SYSTEM_PROMPT } from "./de";
import { EN_SYSTEM_PROMPT } from "./en";
import { PL_SYSTEM_PROMPT } from "./pl";
import { SK_SYSTEM_PROMPT } from "./sk";

/** The source of truth for which languages have an analysis prompt. */
export const ANALYSIS_SYSTEM_PROMPTS = {
  cs: CS_SYSTEM_PROMPT,
  sk: SK_SYSTEM_PROMPT,
  de: DE_SYSTEM_PROMPT,
  en: EN_SYSTEM_PROMPT,
  pl: PL_SYSTEM_PROMPT,
} as const satisfies Record<string, string>;

type AnalysisPromptLanguage = keyof typeof ANALYSIS_SYSTEM_PROMPTS;

export class UnsupportedAnalysisLanguageError extends TaggedError(
  "UnsupportedAnalysisLanguageError",
)<{ language: string; message: string }> {}

const isAnalysisPromptLanguage = (
  language: string,
): language is AnalysisPromptLanguage =>
  Object.hasOwn(ANALYSIS_SYSTEM_PROMPTS, language);

/** The system prompt for a decision's language code, or a typed miss. */
export const getSystemPrompt = (
  language: string,
): Result<string, UnsupportedAnalysisLanguageError> =>
  isAnalysisPromptLanguage(language)
    ? Result.ok(ANALYSIS_SYSTEM_PROMPTS[language])
    : Result.err(
        new UnsupportedAnalysisLanguageError({
          language,
          message: `No analysis prompt is written for language "${language}".`,
        }),
      );
