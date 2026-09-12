/**
 * What "save into matter" saves.
 *
 * A reader who picked rows means those rows. A reader who picked none means
 * what is in front of them, which is the page — never the whole result set,
 * which can be millions of decisions and is not what a matter is for. The
 * distinction is carried in the type so the button can say which it is before
 * it is pressed.
 */
export type MatterPinSet =
  | { type: "selection"; decisionIds: readonly string[] }
  | { type: "page"; decisionIds: readonly string[] }
  | { type: "empty" };

type MatterPinSetInput = {
  /** Every decision on the page, in the order it is drawn. */
  pageDecisionIds: readonly string[];
  /** The rows the reader picked; empty means they picked none. */
  selectedDecisionIds: readonly string[];
};

export const matterPinSet = ({
  pageDecisionIds,
  selectedDecisionIds,
}: MatterPinSetInput): MatterPinSet => {
  const onPage = new Set(pageDecisionIds);
  // A selection survives a filter change that drops the row it named, so only
  // what is actually on this page can be saved from it.
  const picked = [...new Set(selectedDecisionIds)].filter((decisionId) =>
    onPage.has(decisionId),
  );
  if (picked.length > 0) {
    return { type: "selection", decisionIds: picked };
  }
  if (pageDecisionIds.length > 0) {
    return { type: "page", decisionIds: [...pageDecisionIds] };
  }
  return { type: "empty" };
};
