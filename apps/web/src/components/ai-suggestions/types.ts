/**
 * File-anchored AI chat — types.
 *
 * The bar mounted over a file viewer is a chat thread tied to a
 * specific file (DOCX or PDF). Each user prompt yields an assistant
 * message that may carry plain text, a list of suggested edits, a
 * list of source citations, or any combination. The interaction
 * model is the same as the regular Stella chat — the only difference
 * is that this thread is anchored to the file in view, and the
 * assistant has access to the file's contents + can attach edit
 * suggestions when the file is editable.
 */

import type {
  AIBarStatus,
  AIChatMode,
  AICitation,
  AIGenerateInput,
  AISuggestion,
  AISuggestionApplyMode,
  AISuggestionPreset,
} from "@stll/folio";

/**
 * A user-attached file added to the bar's prompt context. Phase 1
 * mock holds metadata only (no upload); the chip lets the user see
 * what they attached and remove it before submit. Real backend will
 * carry the bytes / object URL alongside.
 */
export type AttachmentChip = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
};

export type ThreadMessageId = string;

export type UserThreadMessage = {
  id: ThreadMessageId;
  role: "user";
  /** What the user typed (or the resolved preset prompt). */
  prompt: string;
  /** Slash-command preset id, when the message was sent via `/preset`. */
  presetId?: string;
  /** Pasted blob, surfaced as a chip in the bubble; not part of `prompt`. */
  pastedText?: string;
  /** Mode the bar was in when the user submitted. */
  mode: AIChatMode;
  createdAt: number;
};

type AssistantThreadMessageCommon = {
  id: ThreadMessageId;
  role: "assistant";
  /** Markdown-flavoured response. May be empty when the message is suggestions-only. */
  text: string;
  /** Edit suggestions attached to this turn. Empty for plain-text answers. */
  suggestions: AISuggestion[];
  /** Source citations attached to this turn. Empty for sourceless answers. */
  citations: AICitation[];
  /** Mode that produced the response (mirrors the user message). */
  mode: AIChatMode;
  createdAt: number;
};

type AssistantThreadMessageState =
  | { status: "loading" }
  | { status: "complete" }
  | { status: "error"; error: string };

export type AssistantThreadMessage = AssistantThreadMessageCommon &
  AssistantThreadMessageState;

export type ThreadMessage = UserThreadMessage | AssistantThreadMessage;

/**
 * What the host expects back from `onGenerate`. The host keeps the
 * caller's response shape thin — text, suggestions, citations, or
 * any combination.
 */
export type AIGenerateResponse = {
  /** Plain-text / markdown answer to display in the assistant bubble. */
  text?: string;
  /** Edit suggestions attached to this turn. */
  suggestions?: AISuggestion[];
  /** Source citations attached to this turn. */
  citations?: AICitation[];
};

export type FileAIChatConfig = {
  /**
   * Called when the user submits a prompt. The implementation can
   * call back with text, suggestions, citations, or any combination.
   * Folio's apply pipeline runs against the suggestions; the text
   * renders as a chat bubble; citations render as inline chips that
   * scroll the source viewer to the cited range.
   */
  onGenerate: (input: AIGenerateInput) => Promise<AIGenerateResponse>;
  /** Pre-saved prompts shown in the slash menu. */
  presets?: AISuggestionPreset[];
  /** Placeholder for the empty input. */
  inputPlaceholder?: string;
  /** Default mode when the file is first opened. Defaults to "ask". */
  defaultMode?: AIChatMode;
  /** Default apply mode (direct edit vs Word tracked changes). */
  defaultApplyMode?: AISuggestionApplyMode;
  /** Author label shown for tracked-change applies. */
  applyAuthor?: string;
  /**
   * Called when the user accepts a suggestion while the editor is
   * read-only. The host queues the accept; once the editor unlocks
   * (and a fresh PM view is reported via `editorView`) the queued
   * accepts are applied.
   */
  onUnlockRequest?: () => void;
};

export type FileAIChatStatus = AIBarStatus;
