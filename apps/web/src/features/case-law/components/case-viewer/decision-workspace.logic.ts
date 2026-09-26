import { panic } from "better-result";

import type { MarginItem } from "./analysis/margin-notes";
import { MARGIN_NOTE_KIND_ATTRIBUTE } from "./analysis/margin-notes.logic";
import type { AnalysisState } from "./analysis/use-decision-analysis";

/** The notes margin's mutually exclusive source filter. */
export type NotesFilter = "all" | "ai" | "mine";

/** Whether a filter shows the AI's notes, and so the visitor's offer. */
export const NOTES_FILTER_SHOWS_AI = {
  ai: true,
  all: true,
  mine: false,
} as const satisfies Record<NotesFilter, boolean>;

/** The notes column's resize handle, which a column-wide click must skip. */
export const READER_ASIDE_RESIZE_SLOT = "reader-aside-resize";

type VisitorOfferOptions = {
  analysisStatus: AnalysisState["status"];
  notesFilter: NotesFilter;
  /** The account gate; `undefined` for a member or a workspace still loading. */
  onRequest: (() => void) | undefined;
};

/**
 * The visitor's account gate while there is no analysis to show them and
 * the AI's notes are on screen. Under the "mine" filter the offer and its
 * examples are hidden, so nothing in the column may open it either.
 */
export const resolveVisitorOffer = ({
  analysisStatus,
  notesFilter,
  onRequest,
}: VisitorOfferOptions): (() => void) | undefined =>
  analysisStatus === "idle" && NOTES_FILTER_SHOWS_AI[notesFilter]
    ? onRequest
    : undefined;

/**
 * Which notes are part of the visitor's offer. The reader's own comments and
 * the comment composer work without an account, so a click in them is never
 * a request for one.
 */
const NOTE_KIND_OPENS_VISITOR_OFFER = {
  annotation: false,
  card: false,
  comment: false,
  composer: false,
  example: true,
} as const satisfies Record<MarginItem["kind"], boolean>;

const isMarginNoteKind = (
  kind: string,
): kind is keyof typeof NOTE_KIND_OPENS_VISITOR_OFFER =>
  Object.hasOwn(NOTE_KIND_OPENS_VISITOR_OFFER, kind);

/**
 * Whether a click in the visitor's notes column asks for the account: on the
 * column's own surface or an example note, but not on the resize handle or
 * inside a note the reader works with.
 */
export const clickOpensVisitorOffer = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest(`[data-slot="${READER_ASIDE_RESIZE_SLOT}"]`) !== null) {
    return false;
  }
  const note = target.closest(`[${MARGIN_NOTE_KIND_ATTRIBUTE}]`);
  if (note === null) {
    return true;
  }
  const kind = note.getAttribute(MARGIN_NOTE_KIND_ATTRIBUTE) ?? "";
  if (!isMarginNoteKind(kind)) {
    return panic(`Unknown margin note kind: ${kind}`);
  }
  return NOTE_KIND_OPENS_VISITOR_OFFER[kind];
};
