/**
 * Which find bar Cmd/Ctrl+F belongs to for one key press.
 *
 * Three bars can be mounted at once: the DOCX editor docked in the inspector,
 * the inspector's external-reference preview, and a table view's toolbar. All
 * three bind the shortcut, so without a resolution rule which one opens is
 * mount-order luck and more than one can open together. Every surface that
 * binds the shortcut registers here; none may decide on its own.
 *
 * Two rules decide it, in order:
 *
 * 1. A surface the key press happened inside wins. Focus is the most specific
 *    statement of what the reader is looking at, and it is what lets the DOCX
 *    pane keep its bar while the table behind it keeps the shortcut elsewhere.
 * 2. Otherwise the first surface in {@link FIND_OWNERS} that reaches the whole
 *    app wins. The inspector leads the table because it is the surface in
 *    front of the reader while it is showing a document.
 *
 * An unreachable surface never wins: its pane is CSS-hidden (a background
 * inspector tab) or sits behind a modal. When that leaves no owner the press
 * belongs to the browser, which is what keeps Cmd/Ctrl+F working inside a
 * command palette or a dialog's own input.
 */
const FIND_OWNERS = ["docx", "inspector", "table"] as const;

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

const firstByPrecedence = (
  candidates: readonly FindCandidate[],
): FindOwner | null =>
  FIND_OWNERS.find((owner) =>
    candidates.some((candidate) => candidate.owner === owner),
  ) ?? null;

export const resolveFindOwner = (
  candidates: readonly FindCandidate[],
): FindOwner | null => {
  const live = candidates.filter((candidate) => candidate.reachable);
  return (
    firstByPrecedence(live.filter((candidate) => candidate.containsTarget)) ??
    firstByPrecedence(live.filter((candidate) => candidate.scope === "app"))
  );
};
