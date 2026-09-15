/**
 * What a docked decision tab offers towards the main view.
 *
 * Both case-law inspector tabs — the compact reader and the facts of the
 * decision — carry the same maximize, so the rule that decides it lives in
 * one place: while the main view is already this decision there is nothing to
 * show, and while it holds another decision the two exchange places rather
 * than one being silently dropped.
 */
export type DecisionMainViewAction<T> =
  | { type: "already-main" }
  | { type: "move-to-main" }
  | { type: "swap-with-main"; mainDecision: T };

export const decisionMainViewAction = <T extends { id: string }>({
  decisionId,
  mainDecision,
}: {
  decisionId: string;
  /** The decision the main view renders; absent on every other route. */
  mainDecision: T | undefined;
}): DecisionMainViewAction<T> => {
  if (mainDecision === undefined) {
    return { type: "move-to-main" };
  }
  if (mainDecision.id === decisionId) {
    return { type: "already-main" };
  }
  return { type: "swap-with-main", mainDecision };
};
