/**
 * What the reviewer is told after asking for a note on a clause.
 *
 * The note is typed into a popover and exists nowhere else, so every way the
 * write can end has to be said out loud: a note that did not reach the
 * document leaves the text in the box and the reviewer with a reason.
 */

import { panic } from "better-result";

import type { DocxEditModeBlockReason } from "@/components/docx/docx-browser-editor.logic";
import type { TranslationKey } from "@/i18n/types";

export type CounterpartyNoteOutcome =
  | { type: "applied" }
  | { type: "failed" }
  | { type: "blocked"; reason: DocxEditModeBlockReason };

type CounterpartyNoteMessage = {
  tone: "error" | "info" | "success" | "warning";
  title: TranslationKey;
  description?: TranslationKey;
};

export type CounterpartyNoteReport = CounterpartyNoteMessage & {
  /** Whether the note is in the document. False keeps the reviewer's text. */
  applied: boolean;
};

/**
 * One message per way edit mode can refuse. An unsafe document reuses the
 * wording the edit-mode control already shows, so the reviewer reads the same
 * explanation wherever the block surfaces.
 */
export const COUNTERPARTY_NOTE_BLOCKED_MESSAGES = {
  pendingCompatibility: {
    tone: "info",
    title: "inspector.review.noteNotAdded",
    description: "inspector.review.noteBlockedChecking",
  },
  unsafe: {
    tone: "warning",
    title: "folio.unsupportedDocxEditTitle",
    description: "folio.unsupportedDocxEditDescription",
  },
  collaboration: {
    tone: "info",
    title: "inspector.review.noteNotAdded",
    description: "inspector.review.noteBlockedCollaboration",
  },
  opening: {
    tone: "info",
    title: "inspector.review.noteNotAdded",
    description: "inspector.review.noteBlockedOpening",
  },
} as const satisfies Record<DocxEditModeBlockReason, CounterpartyNoteMessage>;

export const reportCounterpartyNote = (
  outcome: CounterpartyNoteOutcome,
): CounterpartyNoteReport => {
  switch (outcome.type) {
    case "applied":
      return {
        applied: true,
        tone: "success",
        title: "inspector.review.noteAdded",
      };
    case "failed":
      return {
        applied: false,
        tone: "error",
        title: "inspector.review.commentFailed",
      };
    case "blocked":
      return {
        applied: false,
        ...COUNTERPARTY_NOTE_BLOCKED_MESSAGES[outcome.reason],
      };
    default:
      outcome satisfies never;
      return panic(`Unhandled counterparty-note outcome: ${String(outcome)}`);
  }
};
