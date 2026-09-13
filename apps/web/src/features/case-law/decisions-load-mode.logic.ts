/**
 * Whether the results route holds a navigation until its rows arrive.
 *
 * Only the rows are unknown when a reader adds a filter, sorts, or refines:
 * the rail, the toolbar, the column headers and the pager are all on screen
 * and all still correct. A loader that awaits the new rows takes the whole
 * shell away and gives back a skeleton, so it awaits only when there is
 * nothing to take away.
 */
export type DecisionsLoadMode =
  /** Nothing is on screen: the rows are the page, and the markup lists them. */
  | "await"
  /** A result set is already drawn: the components swap the rows in place. */
  | "background";

type DecisionsLoadModeInput = {
  /** Why the router is loading: `stay` means this match is already rendered. */
  cause: "enter" | "preload" | "stay";
  /** Whether this exact search already has its pages in the query cache. */
  hasCachedPages: boolean;
};

export const decisionsLoadMode = ({
  cause,
  hasCachedPages,
}: DecisionsLoadModeInput): DecisionsLoadMode =>
  hasCachedPages || cause === "stay" ? "background" : "await";
