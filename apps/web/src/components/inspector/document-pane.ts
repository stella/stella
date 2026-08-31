/**
 * Which pane the document route reads its review in.
 *
 * Three arrangements, one search param:
 *
 * - `document` (the default, written as the absence of the param): the
 *   document holds the main pane and the findings list sits in the inspector.
 * - `review` swaps them — the findings get the full width of the document
 *   column and the document moves to the inspector's preview.
 * - `margin` keeps the document in the main pane and turns the inspector into
 *   a margin: each finding becomes a sidenote level with the clause it is
 *   about, so the eye travels sideways instead of back and forth.
 *
 * A search param rather than client state so a reload, a back button, and a
 * shared link all land on the same arrangement.
 */

/** The values the route's search schema accepts. The default arrangement is
 *  the absence of the param, so it is not one of them. */
export const DOCUMENT_PANE_SEARCH_VALUES = ["review", "margin"] as const;

export const DOCUMENT_PANE = {
  document: "document",
  review: "review",
  margin: "margin",
} as const;

export type DocumentPane = (typeof DOCUMENT_PANE)[keyof typeof DOCUMENT_PANE];

/** What the facet header offers, when the facet is looking at the route's own
 *  document. Absent everywhere else: another tab's facet has no main pane. */
export type ReviewPaneSwap = {
  pane: DocumentPane;
  onToggle: (pane: DocumentPane) => void;
};
