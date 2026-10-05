import type { AiCellState } from "@/components/workspaces/ai-cell-state.logic";
import type { TranslationKey } from "@/i18n/types";

const RUN_MENU_LABELS = {
  page: "aiColumns.runColumnPage",
  remaining: "aiColumns.runRemainingPage",
  rerun: "aiColumns.rerunColumnPage",
  rerunAll: "aiColumns.rerunAllPage",
} as const satisfies Record<string, TranslationKey>;

type AiColumnRunMenuItem = {
  type: "remaining" | "rerun";
  label: (typeof RUN_MENU_LABELS)[keyof typeof RUN_MENU_LABELS];
};

export const aiColumnRunMenu = (
  states: readonly AiCellState[],
): AiColumnRunMenuItem[] => {
  const done = states.filter(
    (state) => state.type === "done" || state.type === "failed",
  ).length;
  if (done === 0) {
    return [{ type: "remaining", label: RUN_MENU_LABELS.page }];
  }
  if (done === states.length) {
    return [{ type: "rerun", label: RUN_MENU_LABELS.rerun }];
  }
  return [
    { type: "remaining", label: RUN_MENU_LABELS.remaining },
    { type: "rerun", label: RUN_MENU_LABELS.rerunAll },
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
