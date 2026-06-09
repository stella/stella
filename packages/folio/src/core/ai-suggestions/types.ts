/**
 * AI Suggestion Types
 *
 * AI suggestions are external review items, not document changes.
 * They sit in a separate queue, render as non-mutating decorations,
 * and only become document changes when the user accepts them.
 */

export type AISuggestionSeverity = "typo" | "style" | "substantive";

export type AISuggestionStatus = "pending" | "accepted" | "rejected" | "stale";

export type AISuggestionApplyMode = "direct" | "tracked-changes";

/**
 * A single AI suggestion sitting in the review queue.
 *
 * The `range` is a ProseMirror position range captured at generation time.
 * The `originalText` plus `contextBefore`/`contextAfter` form the anchor
 * used to detect staleness if the document is edited between generation
 * and apply.
 */
export type AISuggestion = {
  id: string;
  topic: string;
  severity: AISuggestionSeverity;
  range: { from: number; to: number };
  originalText: string;
  suggestedText: string;
  contextBefore: string;
  contextAfter: string;
  rationale: string;
  /** 0..1 model confidence. Optional — not displayed prominently. */
  confidence?: number;
  status: AISuggestionStatus;
  /**
   * Optional display metadata the host may attach to describe the
   * suggestion's payload with badges (e.g., a template-field proposal's
   * value type and whether a person or AI fills it). Folio stays
   * agnostic: `valueKind` is an opaque string the host resolves against
   * its own registry; unknown values simply render no badge.
   */
  display?: {
    valueKind?: string;
    filledBy?: "person" | "ai";
  };
};

/**
 * Conversation mode — intent dial passed from the bar to the
 * generator. The model decides what to do; mode just tells it
 * what kind of response the user wants.
 */
export type AIChatMode = "ask" | "edit";

/**
 * Input passed to the host's generate function.
 */
export type AIGenerateInput = {
  /**
   * Free-form instruction the user typed into the bar (or the prompt
   * text of the preset they picked). Empty string means "general
   * review — surface anything notable".
   */
  prompt: string;
  /**
   * Conversation mode the user is in.
   * - "ask": no edit suggestions; pure answer.
   * - "edit": text + suggestions allowed, accept UI rendered.
   */
  mode: AIChatMode;
  /** Selected text, if any. Empty string when no selection. */
  selectionText: string;
  /** PM range of the selection, or null when there is no selection. */
  selectionRange: { from: number; to: number } | null;
  /**
   * Last known cursor position (Folio only). Always set when a PM
   * view is available, even when the selection is collapsed; null
   * for non-PM viewers (PDF). Drives "near my cursor" prompts.
   */
  cursorPosition: { from: number; to: number } | null;
  /** Plain-text snapshot of the document body. */
  documentText: string;
  /**
   * Subset of `documentText` currently visible in the viewport. Lets
   * the model bias its answer toward what the user is looking at.
   * Empty string when the host can't infer the visible range.
   */
  visibleText: string;
  /**
   * PM range of the visible region (Folio only). null when the host
   * can't compute it (PDF, or before the first paint).
   */
  visibleRange: { from: number; to: number } | null;
  /**
   * If the prompt came from a preset, its id is forwarded so the
   * generator can take a faster path or attribute the request.
   */
  presetId?: string;
};

/**
 * A pre-saved instruction the user can pick from a dropdown next to
 * the prompt input. Presets bundle a one-line label, an icon glyph,
 * the prompt text that will be sent to the generator, and the
 * conversation mode the prompt is naturally meant for.
 */
export type AISuggestionPreset = {
  id: string;
  /** Short label shown in the dropdown (e.g., "Catch typos"). */
  label: string;
  /** Optional one-line description shown beneath the label. */
  description?: string;
  /** Prompt text sent to the generator when the preset is picked. */
  prompt: string;
  /**
   * Mode the preset is naturally meant for. Picking it switches the
   * bar's mode globally. Default: "edit" (most legacy presets are
   * edit-shaped).
   */
  mode?: AIChatMode;
};

/**
 * Citation — a pointer from an AI answer back to the source range in
 * the document. Folio (DOCX) cites by PM range; PDF cites by bounding
 * box.
 *
 * The `pdf-bbox` shape is flat and byte-compatible with `BoundingBox`
 * from `@stll/api/types` — same field names, same semantics — so a
 * Stella API justification can be lifted into an `AICitationSource`
 * (and vice versa) with `{ kind: "pdf-bbox", ...box }`. We don't
 * import the API type directly to avoid a folio→api package edge
 * for what is universally a PDF bbox shape.
 */
export type AICitationSource =
  | {
      kind: "folio-range";
      /** ProseMirror positions in the live document. */
      from: number;
      to: number;
    }
  | {
      kind: "pdf-bbox";
      pageNumber: number;
      xMin: number;
      yMin: number;
      xMax: number;
      yMax: number;
    };

export type AICitation = {
  /** Stable id within the message (e.g., used as `[1]` reference). */
  id: string;
  /** Short label rendered in the inline chip ("1", "§3.2", etc.). */
  label: string;
  /** Verbatim quoted text from the source — surfaces on hover/expand. */
  quote: string;
  /** Where the cited text lives in the source document. */
  source: AICitationSource;
};

/**
 * Bar status, surfaced by Folio to the user.
 */
export type AIBarStatus =
  | "idle"
  | "generating"
  | "review-ready"
  | "applying"
  | "error";

/**
 * Configuration for the AI suggestions feature.
 */
export type AISuggestionsConfig = {
  /**
   * Called when the user requests new suggestions. Returns the suggestions
   * to be queued for review. Folio handles all UI state, conflict
   * detection, and apply orchestration.
   */
  onGenerate: (input: AIGenerateInput) => Promise<AISuggestion[]>;
  /**
   * Pre-saved prompts shown in the bar's dropdown. When omitted,
   * Folio falls back to a small set of generic legal-drafting presets.
   */
  presets?: AISuggestionPreset[];
  /**
   * Placeholder text shown in the prompt input when it is empty.
   * Defaults to a neutral "Ask AI to review…" prompt.
   */
  inputPlaceholder?: string;
  /**
   * Default apply mode. The user can toggle in the panel.
   * Defaults to "direct".
   */
  defaultApplyMode?: AISuggestionApplyMode;
  /** Author label used when applying as tracked changes. */
  applyAuthor?: string;
  /**
   * Called when the user accepts a suggestion while the editor is
   * read-only. The host should transition the editor into editing
   * mode (e.g., acquire the file lock); Folio queues the accepted
   * suggestions and applies them once the editor becomes editable.
   *
   * If omitted, accept buttons are inert in read-only mode.
   */
  onUnlockRequest?: () => void;
};

/**
 * Default presets used when the host provides none. Each is tagged
 * with the mode it's naturally meant for; picking the preset flips
 * the bar to that mode.
 */
export const DEFAULT_AI_SUGGESTION_PRESETS: AISuggestionPreset[] = [
  {
    id: "summary",
    label: "Summarise this document",
    description: "Quick overview of the parties, subject, and key terms.",
    prompt:
      "Summarise this document. List parties, subject matter, and key terms.",
    mode: "ask",
  },
  {
    id: "governing-law",
    label: "Identify governing law",
    description: "Surface the governing-law clause and the chosen forum.",
    prompt: "What is the governing law and the dispute-resolution forum?",
    mode: "ask",
  },
  {
    id: "typos",
    label: "Catch typos and spelling",
    description: "Flag misspellings and small surface errors only.",
    prompt: "Find typos, misspellings, and small surface errors only.",
    mode: "edit",
  },
  {
    id: "concision",
    label: "Tighten language",
    description: "Cut verbose phrases and prefer plain alternatives.",
    prompt: "Tighten verbose phrases and prefer plain alternatives.",
    mode: "edit",
  },
  {
    id: "defined-terms",
    label: "Check defined terms",
    description: "Flag inconsistent capitalization of defined terms.",
    prompt:
      "Flag inconsistent capitalization or usage of defined terms across the document.",
    mode: "edit",
  },
  {
    id: "shall",
    label: "Plain-language pass",
    description: "Replace “shall” and other archaisms with modern equivalents.",
    prompt:
      "Replace “shall” and other legal archaisms with modern equivalents.",
    mode: "edit",
  },
  {
    id: "general",
    label: "General review",
    description: "Surface anything notable — typos, style, substantive.",
    prompt: "",
    mode: "edit",
  },
];
