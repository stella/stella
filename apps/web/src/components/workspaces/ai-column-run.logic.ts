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

/**
 * The picked rows the page still shows, or `null` when every pick is shown.
 * A new search can answer on the same page; a pick it no longer shows goes
 * with its row, so a selection count is the count a run would use.
 */
export const selectionShownOnPage = ({
  pageRowIds,
  selectedRowIds,
}: AiColumnRunScopeOptions): readonly string[] | null => {
  const shown = new Set(pageRowIds);
  return selectedRowIds.every((id) => shown.has(id))
    ? null
    : selectedRowIds.filter((id) => shown.has(id));
};

/**
 * Whether the header Play stays on screen or appears with hover and keyboard
 * focus. It stays while it is the header's only sign of rows that never ran or
 * are in flight, and while the column menu is open (the pointer has left the
 * header for the menu).
 */
export const AI_COLUMN_RUN_REVEAL = {
  pinned: "pinned",
  onInteraction: "on-interaction",
} as const;

export type AiColumnRunReveal =
  (typeof AI_COLUMN_RUN_REVEAL)[keyof typeof AI_COLUMN_RUN_REVEAL];

const RUN_REVEAL_BY_CELL_STATE = {
  not_run: AI_COLUMN_RUN_REVEAL.pinned,
  queued: AI_COLUMN_RUN_REVEAL.pinned,
  running: AI_COLUMN_RUN_REVEAL.pinned,
  // Each of these reads in its own cell, so the header adds nothing.
  done: AI_COLUMN_RUN_REVEAL.onInteraction,
  not_stated: AI_COLUMN_RUN_REVEAL.onInteraction,
  failed: AI_COLUMN_RUN_REVEAL.onInteraction,
  refused: AI_COLUMN_RUN_REVEAL.onInteraction,
  refused_budget: AI_COLUMN_RUN_REVEAL.onInteraction,
} as const satisfies Record<AiCellState["type"], AiColumnRunReveal>;

type AiColumnRunRevealOptions = {
  states: readonly AiCellState[];
  menuOpen: boolean;
};

export const aiColumnRunReveal = ({
  states,
  menuOpen,
}: AiColumnRunRevealOptions): AiColumnRunReveal =>
  menuOpen ||
  states.some(
    (state) =>
      RUN_REVEAL_BY_CELL_STATE[state.type] === AI_COLUMN_RUN_REVEAL.pinned,
  )
    ? AI_COLUMN_RUN_REVEAL.pinned
    : AI_COLUMN_RUN_REVEAL.onInteraction;
