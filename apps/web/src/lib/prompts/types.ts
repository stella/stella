/**
 * Shared shape for chat user-message templates.
 *
 * "Prompt" here means a snippet of text the user picks to fill
 * the composer; it isn't a system message / persona. Personas
 * (sticky thread-level system instructions) are a separate
 * concept and don't go through this surface.
 *
 *   - "stock":   curated bundled prompts that ship with the
 *                product (hardcoded list, translated via
 *                `useStockPrompts`)
 *   - "team":    org/workspace-shared prompts created by users
 *                and surfaced to teammates (Stage 3, DB-backed)
 *   - "private": prompts saved by an individual user, only
 *                visible to them (Stage 3, DB-backed)
 *
 * The chip + slash-menu components consume this shape directly;
 * the back end is just one source among several.
 */
export const PROMPT_SCOPES = ["stock", "team", "private"] as const;

export type PromptScope = (typeof PROMPT_SCOPES)[number];

export type ChatPrompt = {
  id: string;
  scope: PromptScope;
  /** Short label shown on the chip and in the slash menu. */
  name: string;
  /**
   * The slash command handle (without the leading `/`). Used for
   * filtering when the user types `/foo` in the composer.
   * Stock prompts don't have a command handle; DB-backed shortcuts do.
   */
  command?: string | undefined;
  /**
   * The body inserted into the composer when the prompt is picked.
   * Plain text — entity mentions get added by the user after.
   */
  body: string;
};
