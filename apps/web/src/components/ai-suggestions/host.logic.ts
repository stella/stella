/**
 * Pure decision logic extracted from the file-anchored AI chat host
 * (`host.tsx`). These functions take plain inputs and return plain
 * outputs — no React, no DOM, no ProseMirror, no side effects — so the
 * host's most fragile business rules (apply-mode fallback, the
 * first-accept gate, the generate payload assembly, suggestion
 * anchoring) can be unit-tested in isolation.
 *
 * The host still owns all hooks, state setters, effects, the actual
 * API call, and every editor/DOM read; it feeds the already-extracted
 * plain values into these helpers.
 */

import type {
  AIChatMode,
  AIGenerateInput,
  AISuggestion,
  AISuggestionApplyMode,
} from "@stll/folio";

import type { FileAIChatStatus } from "./types";

/**
 * The accept the user most recently triggered while the apply-mode
 * preference was unset. Held until they answer the one-time prompt;
 * then applied with the chosen mode.
 */
export type PendingFirstAccept =
  | { kind: "one"; suggestionId: string }
  | { kind: "group"; messageId: string };

/**
 * Validate a raw localStorage value into the apply-mode union. Returns
 * null for anything that isn't a known mode (absent key, corrupt
 * value), which the caller treats as "no preference yet".
 */
export const parseStoredApplyMode = (
  raw: string | null,
): AISuggestionApplyMode | null => {
  if (raw === "direct" || raw === "tracked-changes") {
    return raw;
  }
  return null;
};

/**
 * Effective apply mode. When the stored preference is null we still
 * need a value for code paths that read it (e.g., the auto-flush effect
 * after unlock); fall back to the host default, then to "direct". The
 * user-facing "ask once" prompt only blocks the very first accept
 * attempt — this resolution never blocks.
 */
export const resolveApplyMode = (
  storedMode: AISuggestionApplyMode | null,
  defaultMode: AISuggestionApplyMode | undefined,
): AISuggestionApplyMode => storedMode ?? defaultMode ?? "direct";

/**
 * Derive the bar status from the live generation flag and the count of
 * pending suggestions. Generation wins over review-ready; both fall
 * back to idle.
 */
export const deriveChatStatus = (
  generating: boolean,
  pendingCount: number,
): FileAIChatStatus => {
  if (generating) {
    return "generating";
  }
  if (pendingCount > 0) {
    return "review-ready";
  }
  return "idle";
};

type FirstAcceptGate =
  | { type: "defer"; pending: PendingFirstAccept }
  | { type: "accept" }
  | { type: "noop" };

/**
 * First-time single accept: decide whether to defer behind the
 * one-time apply-mode prompt, accept immediately, or do nothing.
 *
 * - When no apply mode is stored yet, defer iff the target is still
 *   resolvable (pending); otherwise noop (nothing to defer).
 * - Once a mode is stored, the gate is open: accept.
 */
export const resolveAcceptOneGate = (
  storedMode: AISuggestionApplyMode | null,
  suggestionId: string,
  targetIsPending: boolean,
): FirstAcceptGate => {
  if (storedMode === null) {
    if (!targetIsPending) {
      return { type: "noop" };
    }
    return { type: "defer", pending: { kind: "one", suggestionId } };
  }
  return { type: "accept" };
};

/**
 * First-time group accept: mirror of {@link resolveAcceptOneGate} for
 * accepting every pending suggestion in a message. Defers only when a
 * mode hasn't been chosen and the message still has at least one
 * pending suggestion.
 */
export const resolveAcceptGroupGate = (
  storedMode: AISuggestionApplyMode | null,
  messageId: string,
  hasPending: boolean,
): FirstAcceptGate => {
  if (storedMode === null) {
    if (!hasPending) {
      return { type: "noop" };
    }
    return { type: "defer", pending: { kind: "group", messageId } };
  }
  return { type: "accept" };
};

/**
 * Join the typed prompt with optional pasted text. An empty prompt
 * collapses to just the pasted text; otherwise the two are separated by
 * a blank line. No paste leaves the prompt untouched.
 */
export const joinPromptWithPasted = (
  promptText: string,
  pastedText: string | undefined,
): string => {
  if (!pastedText) {
    return promptText;
  }
  return promptText.length === 0
    ? pastedText
    : `${promptText}\n\n${pastedText}`;
};

type BuildGenerateInputArgs = {
  fullPrompt: string;
  mode: AIChatMode;
  selectionText: string;
  selectionRange: { from: number; to: number } | null;
  cursorPosition: { from: number; to: number } | null;
  documentText: string;
  visibleText: string;
  visibleRange: { from: number; to: number } | null;
  presetId: string | undefined;
};

/**
 * Assemble the `AIGenerateInput` payload from already-extracted plain
 * values. The caller does the editor/DOM reads (selection, visible
 * range, document text); this just decides the final shape, including
 * dropping `presetId` when absent so it stays an optional field.
 */
export const buildGenerateInput = (
  args: BuildGenerateInputArgs,
): AIGenerateInput => ({
  prompt: args.fullPrompt,
  mode: args.mode,
  selectionText: args.selectionText,
  selectionRange: args.selectionRange,
  cursorPosition: args.cursorPosition,
  documentText: args.documentText,
  visibleText: args.visibleText,
  visibleRange: args.visibleRange,
  ...(args.presetId === undefined ? {} : { presetId: args.presetId }),
});

/**
 * Decide which raw suggestions to keep from a generate response: none
 * in "ask" mode (pure answer, no edits), the response list otherwise.
 * Missing lists collapse to empty.
 */
export const selectResponseSuggestions = (
  mode: AIChatMode,
  responseSuggestions: AISuggestion[] | undefined,
): AISuggestion[] => (mode === "ask" ? [] : (responseSuggestions ?? []));

/**
 * Decide the anchored form of one suggestion given the anchor the
 * caller resolved against the live document:
 *
 * - `anchor === undefined`: no editor view available; keep the
 *   suggestion verbatim.
 * - `anchor === null`: anchor lookup failed; mark stale.
 * - otherwise: re-anchor the range.
 *
 * `undefined` vs `null` are kept distinct on purpose: the host passes
 * `undefined` when there's no PM view at all (PDF), and `null` when a
 * view exists but the text could not be located.
 */
export const anchorSuggestion = (
  suggestion: AISuggestion,
  anchor: { from: number; to: number } | null | undefined,
): AISuggestion => {
  if (anchor === undefined) {
    return suggestion;
  }
  if (anchor === null) {
    return { ...suggestion, status: "stale" };
  }
  return { ...suggestion, range: anchor };
};
