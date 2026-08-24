import { panic } from "better-result";

export type PageRotation = 0 | 90 | 180 | 270;

export type NormalizedCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type OrganizerPage = {
  id: string;
  sourceId: string;
  sourcePageIndex: number;
  rotation: PageRotation;
  crop?: NormalizedCrop;
};

export type PageOrganizerPlan = {
  pages: readonly OrganizerPage[];
  splitBeforePageIds: readonly string[];
};

export type PageOrganizerUI = {
  selectedPageIds: readonly string[];
  anchorPageId: string | null;
};

export type PageOrganizerHistory = {
  past: readonly PageOrganizerPlan[];
  present: PageOrganizerPlan;
  future: readonly PageOrganizerPlan[];
};

export type PageOrganizerState = {
  history: PageOrganizerHistory;
  ui: PageOrganizerUI;
};

export type PageOrganizerAction =
  | { type: "replaceSelection"; pageIds: readonly string[] }
  | { type: "toggleSelection"; pageId: string }
  | { type: "selectRange"; pageId: string }
  | { type: "selectAll" }
  | { type: "moveSelectedBefore"; targetPageId: string }
  | { type: "moveSelectedStep"; direction: "backward" | "forward" }
  | { type: "rotateSelected"; degrees: 90 | -90 }
  | { type: "duplicateSelected"; newPageIds: readonly string[] }
  | { type: "deleteSelected" }
  | { type: "appendSourcePages"; pages: readonly OrganizerPage[] }
  | { type: "toggleSplit"; pageId: string }
  | { type: "setCrop"; crop: NormalizedCrop | null }
  | { type: "undo" }
  | { type: "redo" };

const MAX_HISTORY_ENTRIES = 100;
const DEFAULT_UI: PageOrganizerUI = {
  selectedPageIds: [],
  anchorPageId: null,
};

const normalizeRotation = (degrees: number): PageRotation => {
  const normalized = ((degrees % 360) + 360) % 360;
  switch (normalized) {
    case 0:
    case 90:
    case 180:
    case 270:
      return normalized;
    default:
      return panic("Page rotation must use quarter turns");
  }
};

const pageIds = (pages: readonly OrganizerPage[]): Set<string> => {
  const ids = new Set<string>();
  for (const page of pages) {
    if (ids.has(page.id)) {
      panic(`Duplicate page id: ${page.id}`);
    }
    ids.add(page.id);
  }
  return ids;
};

const normalizePlan = (plan: PageOrganizerPlan): PageOrganizerPlan => {
  const ids = pageIds(plan.pages);
  const firstId = plan.pages.at(0)?.id;
  const splitBeforePageIds: string[] = [];
  for (const id of plan.splitBeforePageIds) {
    if (id !== firstId && ids.has(id) && !splitBeforePageIds.includes(id)) {
      splitBeforePageIds.push(id);
    }
  }
  return { pages: [...plan.pages], splitBeforePageIds };
};

const normalizeUI = (
  ui: PageOrganizerUI,
  plan: PageOrganizerPlan,
): PageOrganizerUI => {
  const ids = pageIds(plan.pages);
  const selectedPageIds: string[] = [];
  for (const id of ui.selectedPageIds) {
    if (ids.has(id) && !selectedPageIds.includes(id)) {
      selectedPageIds.push(id);
    }
  }
  return {
    selectedPageIds,
    anchorPageId:
      ui.anchorPageId !== null && ids.has(ui.anchorPageId)
        ? ui.anchorPageId
        : null,
  };
};

export const createPageOrganizerState = (
  plan: PageOrganizerPlan,
  ui?: PageOrganizerUI,
): PageOrganizerState => {
  const present = normalizePlan(plan);
  return {
    history: { past: [], present, future: [] },
    ui: normalizeUI(ui ?? DEFAULT_UI, present),
  };
};

const currentPlan = (state: PageOrganizerState): PageOrganizerPlan =>
  state.history.present;

const samePlan = (a: PageOrganizerPlan, b: PageOrganizerPlan): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const commit = (
  state: PageOrganizerState,
  nextPlan: PageOrganizerPlan,
  nextUI = state.ui,
): PageOrganizerState => {
  const present = normalizePlan(nextPlan);
  if (samePlan(present, currentPlan(state))) {
    return { ...state, ui: normalizeUI(nextUI, present) };
  }
  return {
    history: {
      past: [...state.history.past, currentPlan(state)].slice(
        -MAX_HISTORY_ENTRIES,
      ),
      present,
      future: [],
    },
    ui: normalizeUI(nextUI, present),
  };
};

const withSelection = (
  state: PageOrganizerState,
  selectedPageIds: readonly string[],
  anchorPageId: string | null = state.ui.anchorPageId,
): PageOrganizerState => ({
  ...state,
  ui: normalizeUI({ selectedPageIds, anchorPageId }, currentPlan(state)),
});

const selectedInOrder = (state: PageOrganizerState): OrganizerPage[] => {
  const selected = new Set(state.ui.selectedPageIds);
  return currentPlan(state).pages.filter((page) => selected.has(page.id));
};

const movePages = (
  pages: readonly OrganizerPage[],
  selectedIds: ReadonlySet<string>,
  targetPageId: string,
): OrganizerPage[] => {
  if (selectedIds.has(targetPageId)) {
    return [...pages];
  }
  const selected = pages.filter((page) => selectedIds.has(page.id));
  if (selected.length === 0) {
    return [...pages];
  }
  const remaining = pages.filter((page) => !selectedIds.has(page.id));
  const targetIndex = remaining.findIndex((page) => page.id === targetPageId);
  if (targetIndex === -1) {
    return [...pages];
  }
  remaining.splice(targetIndex, 0, ...selected);
  return remaining;
};

const moveOneStep = (
  pages: readonly OrganizerPage[],
  selectedIds: ReadonlySet<string>,
  direction: "backward" | "forward",
): OrganizerPage[] => {
  const result = [...pages];
  const indexes = pages
    .map((page, index) => (selectedIds.has(page.id) ? index : -1))
    .filter((index) => index >= 0);
  const ordered = direction === "backward" ? indexes : indexes.toReversed();
  for (const index of ordered) {
    const otherIndex = direction === "backward" ? index - 1 : index + 1;
    const page = result.at(index);
    const otherPage = result.at(otherIndex);
    if (
      page === undefined ||
      otherPage === undefined ||
      selectedIds.has(otherPage.id)
    ) {
      continue;
    }
    result[index] = otherPage;
    result[otherIndex] = page;
  }
  return result;
};

export const reducePageOrganizer = (
  state: PageOrganizerState,
  action: PageOrganizerAction,
): PageOrganizerState => {
  const plan = currentPlan(state);
  switch (action.type) {
    case "replaceSelection":
      return withSelection(
        state,
        action.pageIds,
        action.pageIds.at(-1) ?? null,
      );
    case "toggleSelection": {
      const selected = new Set(state.ui.selectedPageIds);
      if (selected.has(action.pageId)) {
        selected.delete(action.pageId);
      } else {
        selected.add(action.pageId);
      }
      return withSelection(state, [...selected], action.pageId);
    }
    case "selectRange": {
      const anchor = state.ui.anchorPageId ?? action.pageId;
      const anchorIndex = plan.pages.findIndex((page) => page.id === anchor);
      const targetIndex = plan.pages.findIndex(
        (page) => page.id === action.pageId,
      );
      if (anchorIndex === -1 || targetIndex === -1) {
        return state;
      }
      const [start, end] =
        anchorIndex < targetIndex
          ? [anchorIndex, targetIndex]
          : [targetIndex, anchorIndex];
      return withSelection(
        state,
        plan.pages.slice(start, end + 1).map((page) => page.id),
        anchor,
      );
    }
    case "selectAll":
      return withSelection(
        state,
        plan.pages.map((page) => page.id),
        state.ui.anchorPageId,
      );
    case "moveSelectedBefore": {
      const pages = movePages(
        plan.pages,
        new Set(state.ui.selectedPageIds),
        action.targetPageId,
      );
      return commit(state, { ...plan, pages });
    }
    case "moveSelectedStep": {
      const pages = moveOneStep(
        plan.pages,
        new Set(state.ui.selectedPageIds),
        action.direction,
      );
      return commit(state, { ...plan, pages });
    }
    case "rotateSelected": {
      const selected = new Set(state.ui.selectedPageIds);
      const pages = plan.pages.map((page) =>
        selected.has(page.id)
          ? {
              ...page,
              rotation: normalizeRotation(page.rotation + action.degrees),
            }
          : page,
      );
      return commit(state, { ...plan, pages });
    }
    case "duplicateSelected": {
      const selected = selectedInOrder(state);
      if (selected.length !== action.newPageIds.length) {
        panic("A new id is required for each selected page");
      }
      const ids = pageIds(plan.pages);
      for (const id of action.newPageIds) {
        if (ids.has(id)) {
          panic(`Duplicate page id: ${id}`);
        }
        ids.add(id);
      }
      const duplicateById = new Map<string, OrganizerPage>();
      for (const [index, page] of selected.entries()) {
        const id = action.newPageIds.at(index);
        if (id === undefined) {
          panic("A new id is required for each selected page");
        }
        duplicateById.set(page.id, { ...page, id });
      }
      const pages: OrganizerPage[] = [];
      for (const page of plan.pages) {
        pages.push(page);
        const duplicate = duplicateById.get(page.id);
        if (duplicate) {
          pages.push(duplicate);
        }
      }
      return commit(
        state,
        { ...plan, pages },
        {
          selectedPageIds: action.newPageIds,
          anchorPageId: action.newPageIds.at(-1) ?? null,
        },
      );
    }
    case "deleteSelected": {
      const selected = new Set(state.ui.selectedPageIds);
      if (selected.size === 0 || selected.size >= plan.pages.length) {
        return state;
      }
      const pages = plan.pages.filter((page) => !selected.has(page.id));
      return commit(
        state,
        { ...plan, pages },
        { selectedPageIds: [], anchorPageId: null },
      );
    }
    case "appendSourcePages": {
      const ids = pageIds(plan.pages);
      for (const page of action.pages) {
        if (ids.has(page.id)) {
          panic(`Duplicate page id: ${page.id}`);
        }
        ids.add(page.id);
      }
      return commit(state, {
        ...plan,
        pages: [...plan.pages, ...action.pages],
      });
    }
    case "toggleSplit": {
      const pageIndex = plan.pages.findIndex(
        (page) => page.id === action.pageId,
      );
      if (pageIndex <= 0) {
        return state;
      }
      const markers = new Set(plan.splitBeforePageIds);
      if (markers.has(action.pageId)) {
        markers.delete(action.pageId);
      } else {
        markers.add(action.pageId);
      }
      return commit(state, { ...plan, splitBeforePageIds: [...markers] });
    }
    case "setCrop": {
      const selected = new Set(state.ui.selectedPageIds);
      const pages = plan.pages.map((page) => {
        if (!selected.has(page.id)) {
          return page;
        }
        if (action.crop !== null) {
          return { ...page, crop: action.crop };
        }
        const { crop: _crop, ...withoutCrop } = page;
        return withoutCrop;
      });
      return commit(state, { ...plan, pages });
    }
    case "undo": {
      const previous = state.history.past.at(-1);
      if (!previous) {
        return state;
      }
      return {
        history: {
          past: state.history.past.slice(0, -1),
          present: previous,
          future: [currentPlan(state), ...state.history.future],
        },
        ui: normalizeUI(state.ui, previous),
      };
    }
    case "redo": {
      const next = state.history.future.at(0);
      if (!next) {
        return state;
      }
      return {
        history: {
          past: [...state.history.past, currentPlan(state)].slice(
            -MAX_HISTORY_ENTRIES,
          ),
          present: next,
          future: state.history.future.slice(1),
        },
        ui: normalizeUI(state.ui, next),
      };
    }
    default:
      return action satisfies never;
  }
};
