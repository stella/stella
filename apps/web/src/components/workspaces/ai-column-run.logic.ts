import type { AiCellState } from "@/components/workspaces/ai-cell-state.logic";
import type { TranslationKey } from "@/i18n/types";

type AiColumnRunMenuItem = {
  type: "remaining" | "rerun";
  label: TranslationKey;
};

export const aiColumnRunMenu = (
  states: readonly AiCellState[],
): AiColumnRunMenuItem[] => {
  const done = states.filter(
    (state) => state.type === "done" || state.type === "failed",
  ).length;
  if (done === 0) {
    return [{ type: "remaining", label: "aiColumns.runColumnPage" }];
  }
  if (done === states.length) {
    return [{ type: "rerun", label: "aiColumns.rerunColumnPage" }];
  }
  return [
    { type: "remaining", label: "aiColumns.runRemainingPage" },
    { type: "rerun", label: "aiColumns.rerunAllPage" },
  ];
};

type AiColumnRunScopeOptions = {
  pageRowIds: readonly string[];
  selectedRowIds: readonly string[];
};
export const aiColumnRunScope = ({
  pageRowIds,
  selectedRowIds,
}: AiColumnRunScopeOptions) => {
  const selected = new Set(selectedRowIds);
  const picked = pageRowIds.filter((id) => selected.has(id));
  const rowIds = picked.length > 0 ? picked : pageRowIds;
  return {
    type: picked.length > 0 ? ("selection" as const) : ("page" as const),
    rowIds,
    count: rowIds.length,
  };
};
