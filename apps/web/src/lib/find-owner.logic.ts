/**
 * Which find bar Cmd/Ctrl+F belongs to for one key press.
 *
 * Four surfaces can answer it: the DOCX editor docked in the inspector, the
 * inspector's external-reference preview, a document opened in full view, and
 * a table view's toolbar. Two or three are often mounted at once, so without
 * a resolution rule which one opens is mount-order luck and more than one can
 * open together. Every surface that answers the shortcut registers here; none
 * may decide on its own.
 *
 * Two rules decide which surface, in order:
 *
 * 1. A surface the key press happened inside wins. Focus is the most specific
 *    statement of what the reader is looking at, and it is what lets the DOCX
 *    pane keep its bar while the table behind it keeps the shortcut elsewhere.
 * 2. Otherwise the first surface in {@link FIND_OWNERS} that reaches the whole
 *    app wins. The inspector leads the full-view document and the table
 *    because it is the surface in front of the reader while it is showing a
 *    document. The full view and the table never share a page, so their
 *    relative order is a statement rather than a tie-break.
 *
 * A surface can hold more than one registration at once, so {@link
 * resolveFindClaim} answers with the registration rather than the owner.
 *
 * An unreachable surface never wins: its pane is CSS-hidden (a background
 * inspector tab) or sits behind a modal. When that leaves no owner the press
 * belongs to the browser, which is what keeps Cmd/Ctrl+F working inside a
 * command palette or a dialog's own input.
 */
const FIND_OWNERS = ["docx", "inspector", "document", "table"] as const;

export type FindOwner = (typeof FIND_OWNERS)[number];

/**
 * How far a claim reaches. A `pane` surface takes the shortcut only for key
 * presses inside its own pane; an `app` surface takes it wherever focus is.
 */
export type FindScope = "app" | "pane";

export type FindCandidate = {
  /** The key press landed inside this surface's own pane. */
  containsTarget: boolean;
  owner: FindOwner;
  /** On screen for this key press: rendered, and not behind a modal. */
  reachable: boolean;
  scope: FindScope;
};

/** One surface's registration, and what it claims for a single key press. */
type FindClaim = {
  candidate: FindCandidate;
};

const firstByPrecedence = (
  candidates: readonly FindCandidate[],
): FindOwner | null =>
  FIND_OWNERS.find((owner) =>
    candidates.some((candidate) => candidate.owner === owner),
  ) ?? null;

const resolveFindOwner = (
  candidates: readonly FindCandidate[],
): FindOwner | null => {
  const live = candidates.filter((candidate) => candidate.reachable);
  return (
    firstByPrecedence(live.filter((candidate) => candidate.containsTarget)) ??
    firstByPrecedence(live.filter((candidate) => candidate.scope === "app"))
  );
};

/**
 * The registration one key press belongs to, or null when it belongs to the
 * browser.
 *
 * Precedence names a surface, not a registration, and one surface can hold two
 * at once: React's development mount/cleanup/mount cycle, and a route
 * transition with both instances still on screen. The registration holding the
 * press wins, so the instance the reader is typing in answers rather than
 * whichever registered first. A press outside every surface has no such
 * tie-break and takes the first that reaches the app.
 */
export const resolveFindClaim = <T extends FindClaim>(
  claims: readonly T[],
): T | null => {
  const owner = resolveFindOwner(claims.map((claim) => claim.candidate));
  const held = claims.filter(
    (claim) => claim.candidate.owner === owner && claim.candidate.reachable,
  );
  return (
    held.find((claim) => claim.candidate.containsTarget) ?? held.at(0) ?? null
  );
};
