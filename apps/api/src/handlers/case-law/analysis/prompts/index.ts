/**
 * Prompt dispatcher. Resolves the appropriate system prompt
 * based on the decision's language.
 */

import { CS_SYSTEM_PROMPT } from "./cs";
import { DE_SYSTEM_PROMPT } from "./de";
import { EN_SYSTEM_PROMPT } from "./en";
import { PL_SYSTEM_PROMPT } from "./pl";
import { SK_SYSTEM_PROMPT } from "./sk";

const PROMPT_MAP: Record<string, string> = {
  cs: CS_SYSTEM_PROMPT,
  sk: SK_SYSTEM_PROMPT,
  de: DE_SYSTEM_PROMPT,
  en: EN_SYSTEM_PROMPT,
  pl: PL_SYSTEM_PROMPT,
};

/**
 * Get the system prompt for a given language code.
 * Falls back to English for unsupported languages.
 */
export const getSystemPrompt = (language: string): string =>
  PROMPT_MAP[language] ?? EN_SYSTEM_PROMPT;
