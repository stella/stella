import { panic } from "better-result";

import {
  applyAll,
  applyOne,
  type CleanScanPageReview,
  type CleanScanReview,
  createCleanScanReview,
  rejectOne,
  setPageReview,
  undoCleanScanReview,
} from "@stll/scan-engine/review";
import type { ScanOptions } from "@stll/scan-engine/types";

import type { PageCleanScan } from "@/lib/pdf/page-editor/clean-scan-placement";
import type {
  CleanScanFailure,
  CleanScanGeometry,
} from "@/lib/pdf/page-editor/clean-scan-run";
import type { PagePlanEntry } from "@/lib/pdf/page-editor/page-editor-protocol";

export type PageRotation = 0 | 90 | 180 | 270;

export type PageDropEdge = "before" | "after";

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
  /** Key into `PageOrganizerState.cleanScans`; the page shows that cleaned scan. */
  cleanScanId?: string;
};

export type PageOrganizerPlan = {
  pages: readonly OrganizerPage[];
};

export type PageOrganizerUI = {
  selectedPageIds: readonly string[];
  anchorPageId: string | null;
};

type PageOrganizerHistory = {
  initial: PageOrganizerPlan;
  past: readonly PageOrganizerPlan[];
  present: PageOrganizerPlan;
  future: readonly PageOrganizerPlan[];
};

export const DEFAULT_CLEAN_SCAN_OPTIONS = {
  output: "grayscale",
  contentCrop: "on",
  deskew: "on",
} as const satisfies ScanOptions;

/**
 * One clean-scan review: the pages it covers, what the engine returned for
 * each, and the user's apply and reject decisions. Nothing reaches the plan
 * until the review is committed.
 */
export type CleanScanSession = {
  /** Identifies this run, so results from an abandoned run are ignored. */
  runId: string;
  options: ScanOptions;
  review: CleanScanReview;
  /** Source geometry per previewed page, needed to place its cleaned image. */
  geometry: ReadonlyMap<string, CleanScanGeometry>;
  failures: readonly CleanScanFailure[];
};

export type PageOrganizerState = {
  history: PageOrganizerHistory;
  ui: PageOrganizerUI;
  /**
   * Committed cleaned scans retained by the present plan or undo/redo history.
   */
  cleanScans: ReadonlyMap<string, PageCleanScan>;
  cleanScan: CleanScanSession | null;
};

export type PageOrganizerAction =
  | { type: "replaceSelection"; pageIds: readonly string[] }
  | { type: "toggleSelection"; pageId: string }
  | { type: "selectRange"; pageId: string }
  | { type: "toggleSelectAll" }
  | {
      type: "moveSelected";
      targetPageId: string;
      edge: PageDropEdge;
    }
  | { type: "moveSelectedStep"; direction: "backward" | "forward" }
  | { type: "rotateSelected"; degrees: 90 | -90 }
  | { type: "duplicateSelected"; newPageIds: readonly string[] }
  | { type: "deleteSelected" }
  | { type: "appendSourcePages"; pages: readonly OrganizerPage[] }
  | { type: "setPageCrops"; crops: ReadonlyMap<string, NormalizedCrop | null> }
  | CleanScanAction
  | { type: "undo" }
  | { type: "redo" };

type CleanScanAction =
  | {
      type: "startCleanScan";
      runId: string;
      pageIds: readonly string[];
      options: ScanOptions;
    }
  | {
      type: "cleanScanPageReviewed";
      runId: string;
      review: CleanScanPageReview;
      geometry: CleanScanGeometry;
    }
  | { type: "cleanScanPageFailed"; runId: string; failure: CleanScanFailure }
  | { type: "applyCleanScanPage"; pageId: string }
  | { type: "applyAllCleanScanPages" }
  | { type: "rejectCleanScanPage"; pageId: string }
  | { type: "undoCleanScanReview" }
  | { type: "commitCleanScan" }
  | { type: "cancelCleanScan" };

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
  pageIds(plan.pages);
  return { pages: [...plan.pages] };
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
  if (plan.pages.length === 0) {
    return panic("A PDF page organizer requires at least one page");
  }
  const present = normalizePlan(plan);
  return {
    history: { initial: present, past: [], present, future: [] },
    ui: normalizeUI(ui ?? DEFAULT_UI, present),
    cleanScans: new Map(),
    cleanScan: null,
  };
};

const currentPlan = (state: PageOrganizerState): PageOrganizerPlan =>
  state.history.present;

const samePlan = (a: PageOrganizerPlan, b: PageOrganizerPlan): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export const isPageOrganizerDirty = (state: PageOrganizerState): boolean =>
  !samePlan(state.history.initial, state.history.present);

/** The page's committed cleaned scan, if it shows one. */
export const pageCleanScan = (
  state: PageOrganizerState,
  page: OrganizerPage,
): PageCleanScan | undefined => {
  if (page.cleanScanId === undefined) {
    return undefined;
  }
  return (
    state.cleanScans.get(page.cleanScanId) ??
    panic(`Unknown clean scan: ${page.cleanScanId}`)
  );
};

/** The current plan as the page transform reads it: cleaned pages carry their scan. */
export const transformPagePlanEntries = (
  state: PageOrganizerState,
): PagePlanEntry[] =>
  currentPlan(state).pages.map((page) => {
    const { cleanScanId: _cleanScanId, ...entry } = page;
    const scan = pageCleanScan(state, page);
    return scan === undefined ? entry : { ...entry, scan };
  });

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
      initial: state.history.initial,
      past: [...state.history.past, currentPlan(state)].slice(
        -MAX_HISTORY_ENTRIES,
      ),
      present,
      future: [],
    },
    ui: normalizeUI(nextUI, present),
    cleanScans: state.cleanScans,
    cleanScan: state.cleanScan,
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

type MovePagesOptions = {
  edge: PageDropEdge;
  pages: readonly OrganizerPage[];
  selectedIds: ReadonlySet<string>;
  targetPageId: string;
};

const movePages = ({
  edge,
  pages,
  selectedIds,
  targetPageId,
}: MovePagesOptions): OrganizerPage[] => {
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
  const insertionIndex = edge === "before" ? targetIndex : targetIndex + 1;
  remaining.splice(insertionIndex, 0, ...selected);
  return remaining;
};

type GetPageMoveDestinationOptions = {
  draggedPageId: string;
  edge: PageDropEdge;
  pages: readonly OrganizerPage[];
  selectedPageIds: readonly string[];
  targetPageId: string;
};

export const getPageMoveDestination = ({
  draggedPageId,
  edge,
  pages,
  selectedPageIds,
  targetPageId,
}: GetPageMoveDestinationOptions): number | null => {
  const movedIds = new Set(
    selectedPageIds.includes(draggedPageId) ? selectedPageIds : [draggedPageId],
  );
  if (movedIds.has(targetPageId)) {
    return null;
  }
  const remaining = pages.filter((page) => !movedIds.has(page.id));
  const targetIndex = remaining.findIndex((page) => page.id === targetPageId);
  if (targetIndex === -1) {
    return null;
  }
  return (edge === "before" ? targetIndex : targetIndex + 1) + 1;
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

/**
 * An engine result is a fact about the page, not a user decision, so it is
 * written into every undo snapshot as well: undoing an apply or reject made
 * while the run was still going never returns a finished page to pending.
 */
const recordEngineResult = (
  review: CleanScanReview,
  result: CleanScanPageReview,
): CleanScanReview => {
  const reviewed = setPageReview(review, result);
  if (reviewed === review) {
    return review;
  }
  return {
    pages: reviewed.pages,
    past: review.past.map((pages) =>
      pages.map((page) => (page.pageId === result.pageId ? result : page)),
    ),
  };
};

type UpdateCleanScanSessionOptions = {
  runId?: string | undefined;
  state: PageOrganizerState;
  update: (session: CleanScanSession) => CleanScanSession;
};

/** Apply `update` to the open session; a stale run id changes nothing. */
const updateCleanScanSession = ({
  runId,
  state,
  update,
}: UpdateCleanScanSessionOptions): PageOrganizerState => {
  const session = state.cleanScan;
  if (session === null || (runId !== undefined && runId !== session.runId)) {
    return state;
  }
  return { ...state, cleanScan: update(session) };
};

/** Move the applied previews into the plan as one undoable edit. */
const commitCleanScan = (
  state: PageOrganizerState,
  session: CleanScanSession,
): PageOrganizerState => {
  const cleanScans = new Map(state.cleanScans);
  const scanIdByPage = new Map<string, string>();
  for (const page of session.review.pages) {
    if (page.type !== "applied") {
      continue;
    }
    const geometry = session.geometry.get(page.pageId);
    if (!geometry) {
      return panic(`Applied clean scan has no page geometry: ${page.pageId}`);
    }
    const scanId = `${session.runId}:${page.pageId}`;
    cleanScans.set(scanId, { ...geometry, image: page.scan.image });
    scanIdByPage.set(page.pageId, scanId);
  }
  const plan = currentPlan(state);
  const pages = plan.pages.map((page) => {
    const cleanScanId = scanIdByPage.get(page.id);
    return cleanScanId === undefined ? page : { ...page, cleanScanId };
  });
  return commit({ ...state, cleanScans, cleanScan: null }, { ...plan, pages });
};

const reduceCleanScan = (
  state: PageOrganizerState,
  action: CleanScanAction,
): PageOrganizerState => {
  switch (action.type) {
    case "startCleanScan": {
      const ids = pageIds(currentPlan(state).pages);
      if (
        action.pageIds.length === 0 ||
        action.pageIds.some((id) => !ids.has(id))
      ) {
        return panic("A clean scan reviews one or more pages of the plan");
      }
      return {
        ...state,
        cleanScan: {
          runId: action.runId,
          options: action.options,
          review: createCleanScanReview(action.pageIds),
          geometry: new Map(),
          failures: [],
        },
      };
    }
    case "cleanScanPageReviewed":
      return updateCleanScanSession({
        runId: action.runId,
        state,
        update: (session) => {
          const geometry = new Map(session.geometry);
          geometry.set(action.review.pageId, action.geometry);
          return {
            ...session,
            review: recordEngineResult(session.review, action.review),
            geometry,
          };
        },
      });
    case "cleanScanPageFailed":
      return updateCleanScanSession({
        runId: action.runId,
        state,
        update: (session) => ({
          ...session,
          failures: [...session.failures, action.failure],
        }),
      });
    case "applyCleanScanPage":
      return updateCleanScanSession({
        state,
        update: (session) => ({
          ...session,
          review: applyOne(session.review, action.pageId),
        }),
      });
    case "applyAllCleanScanPages":
      return updateCleanScanSession({
        state,
        update: (session) => ({
          ...session,
          review: applyAll(session.review),
        }),
      });
    case "rejectCleanScanPage":
      return updateCleanScanSession({
        state,
        update: (session) => ({
          ...session,
          review: rejectOne(session.review, action.pageId),
        }),
      });
    case "undoCleanScanReview":
      return updateCleanScanSession({
        state,
        update: (session) => ({
          ...session,
          review: undoCleanScanReview(session.review),
        }),
      });
    case "commitCleanScan":
      return state.cleanScan === null
        ? state
        : commitCleanScan(state, state.cleanScan);
    case "cancelCleanScan":
      return { ...state, cleanScan: null };
    default: {
      action satisfies never;
      return panic(`Unhandled clean scan action: ${String(action)}`);
    }
  }
};

const CLEAN_SCAN_ACTION_TYPES = {
  startCleanScan: true,
  cleanScanPageReviewed: true,
  cleanScanPageFailed: true,
  applyCleanScanPage: true,
  applyAllCleanScanPages: true,
  rejectCleanScanPage: true,
  undoCleanScanReview: true,
  commitCleanScan: true,
  cancelCleanScan: true,
} as const satisfies Record<CleanScanAction["type"], true>;

const isCleanScanAction = (
  action: PageOrganizerAction,
): action is CleanScanAction =>
  Object.hasOwn(CLEAN_SCAN_ACTION_TYPES, action.type);

const reducePageOrganizerAction = (
  state: PageOrganizerState,
  action: PageOrganizerAction,
): PageOrganizerState => {
  if (isCleanScanAction(action)) {
    return reduceCleanScan(state, action);
  }
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
    case "toggleSelectAll":
      return withSelection(
        state,
        state.ui.selectedPageIds.length === plan.pages.length
          ? []
          : plan.pages.map((page) => page.id),
        state.ui.anchorPageId,
      );
    case "moveSelected": {
      const pages = movePages({
        edge: action.edge,
        pages: plan.pages,
        selectedIds: new Set(state.ui.selectedPageIds),
        targetPageId: action.targetPageId,
      });
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
    case "setPageCrops": {
      const pages = plan.pages.map((page) => {
        const crop = action.crops.get(page.id);
        if (crop === undefined) {
          return page;
        }
        if (crop !== null) {
          return { ...page, crop };
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
          initial: state.history.initial,
          past: state.history.past.slice(0, -1),
          present: previous,
          future: [currentPlan(state), ...state.history.future],
        },
        ui: normalizeUI(state.ui, previous),
        cleanScans: state.cleanScans,
        cleanScan: state.cleanScan,
      };
    }
    case "redo": {
      const next = state.history.future.at(0);
      if (!next) {
        return state;
      }
      return {
        history: {
          initial: state.history.initial,
          past: [...state.history.past, currentPlan(state)].slice(
            -MAX_HISTORY_ENTRIES,
          ),
          present: next,
          future: state.history.future.slice(1),
        },
        ui: normalizeUI(state.ui, next),
        cleanScans: state.cleanScans,
        cleanScan: state.cleanScan,
      };
    }
    default: {
      action satisfies never;
      return panic(`Unhandled action: ${String(action)}`);
    }
  }
};

const retainRestorableCleanScans = (
  state: PageOrganizerState,
): PageOrganizerState => {
  const retainedIds = new Set<string>();
  // `initial` is a dirty-check baseline, never an undo/redo destination.
  for (const plan of [
    state.history.present,
    ...state.history.past,
    ...state.history.future,
  ]) {
    for (const page of plan.pages) {
      if (page.cleanScanId !== undefined) {
        retainedIds.add(page.cleanScanId);
      }
    }
  }
  if (
    retainedIds.size === state.cleanScans.size &&
    [...retainedIds].every((id) => state.cleanScans.has(id))
  ) {
    return state;
  }
  const cleanScans = new Map<string, PageCleanScan>();
  for (const id of retainedIds) {
    cleanScans.set(
      id,
      state.cleanScans.get(id) ?? panic(`Unknown clean scan: ${id}`),
    );
  }
  return { ...state, cleanScans };
};

export const reducePageOrganizer = (
  state: PageOrganizerState,
  action: PageOrganizerAction,
): PageOrganizerState => {
  const next = reducePageOrganizerAction(state, action);
  if (next.history === state.history && next.cleanScans === state.cleanScans) {
    return next;
  }
  return retainRestorableCleanScans(next);
};
