/**
 * Write-time safety for AI memory content.
 *
 * Stored memories are replayed into the chat system prompt for *every*
 * future session in their scope — a user-scope row reaches all of that
 * lawyer's chats, a firm-scope row reaches the whole organization. That
 * makes the memory store a persistent prompt-injection surface: text
 * captured from one untrusted conversation (or pasted into the settings
 * form) must not be able to smuggle model-control sequences or invisible
 * exfiltration characters into later prompts across the ethical wall.
 *
 * Every write path (the `remember` tool, the background extractor, and the
 * REST create/update handlers) funnels content through
 * {@link sanitizeMemoryContent} so the constraint lives in one place. The
 * read path strips the same characters again as defence in depth, but the
 * authoritative control is here: poison is refused storage, fail-closed.
 */

import { Result } from "better-result";

import {
  containsModelRoleControlTokens,
  stripPromptUnsafeChars,
} from "@/api/lib/prompt-safety";

export const MEMORY_CONTENT_REJECTION = {
  // Carried a structural model-control token (ChatML / Llama role markers).
  modelControlTokens: "model-control-tokens",
  // Nothing legible survived stripping (e.g. only invisible characters).
  emptyAfterSanitize: "empty-after-sanitize",
} as const;

export type MemoryContentRejection =
  (typeof MEMORY_CONTENT_REJECTION)[keyof typeof MEMORY_CONTENT_REJECTION];

/**
 * Normalize untrusted memory text and reject it fail-closed when it carries
 * an unambiguous injection signal.
 *
 * - Strips ASCII control codes and Unicode bidi / zero-width overrides.
 * - Collapses every whitespace run (newlines included) to a single space,
 *   so a multi-line `\nSystem:` payload cannot reconstitute itself as its
 *   own instruction line once the row is rendered as a one-line bullet.
 * - Rejects content bearing structural model-control tokens; these never
 *   occur in real legal prose, so refusing storage is safe.
 * - Rejects content that is empty once sanitized.
 *
 * Returns the cleaned, trimmed content on success.
 */
export const sanitizeMemoryContent = (
  raw: string,
): Result<string, MemoryContentRejection> => {
  const stripped = stripPromptUnsafeChars(raw);

  if (containsModelRoleControlTokens(stripped)) {
    return Result.err(MEMORY_CONTENT_REJECTION.modelControlTokens);
  }

  const collapsed = stripped.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return Result.err(MEMORY_CONTENT_REJECTION.emptyAfterSanitize);
  }

  return Result.ok(collapsed);
};
