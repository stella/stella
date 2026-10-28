import { panic } from "better-result";

import type { DesktopTimeEntryClassification } from "@stll/api-contract/desktop-time-entries";

import {
  currentReviewContent,
  draftScalars,
  materializeStructure,
} from "./billing-draft-logic";
import type {
  DraftableGroup,
  DraftResult,
  ResolvedStructureProposal,
  ReviewItem,
  StructureSummary,
} from "./billing-draft-logic";

export type SingleReviewContent = {
  type: "single";
  narrative: string;
  billable: boolean;
  classification: DesktopTimeEntryClassification | null;
  notice?: "sourceChanged";
};
export type AcceptedReviewContent = {
  type: "accepted";
  summary: StructureSummary;
  sources: readonly Pick<DraftableGroup, "id" | "ranges" | "roundedTenths">[];
  items: readonly ReviewItem[];
  undoContent: SingleReviewContent;
};
export type ReviewContent = SingleReviewContent | AcceptedReviewContent;
type AppliedDraftState = {
  using: "draft" | "original";
  result: DraftResult;
  readonly originalContent: SingleReviewContent;
  proposal: DraftResult | null;
};
export type DraftEntryState =
  { using: "proposal"; result: DraftResult } | AppliedDraftState;
const transitionAppliedDraft = (
  current: AppliedDraftState,
  next: Omit<AppliedDraftState, "originalContent">,
): AppliedDraftState => ({
  using: next.using,
  result: next.result,
  originalContent: current.originalContent,
  proposal: next.proposal,
});
export type EntryEdit = {
  selected: boolean;
  revision: number;
  content: ReviewContent;
  draft: DraftEntryState | null;
};
export type ReviewState = ReadonlyMap<string, EntryEdit>;
type ReviewTarget = { groupId: string; initial: EntryEdit };
export type ReviewAction =
  | (ReviewTarget & {
      type: "set-narrative";
      itemKey: string;
      narrative: string;
    })
  | (ReviewTarget & {
      type: "set-billable";
      itemKey: string;
      billable: boolean;
    })
  | (ReviewTarget & { type: "set-selected"; selected: boolean })
  | {
      type: "offer-results";
      mode: "initial" | "steer";
      offers: readonly (ReviewTarget & {
        expectedRevision: number;
        result: DraftResult;
      })[];
    }
  | (ReviewTarget & {
      type:
        | "use-original"
        | "use-draft"
        | "apply-proposal"
        | "dismiss-proposal"
        | "undo-structure";
    })
  | (ReviewTarget & {
      type: "accept-structure";
      proposal: ResolvedStructureProposal;
      groups: readonly { group: DraftableGroup; initial: EntryEdit }[];
    })
  | { type: "undo-all" };

export const initialReviewEdit = (content: SingleReviewContent): EntryEdit => ({
  selected: true,
  revision: 0,
  content,
  draft: null,
});

type EntryChange = {
  content?: ReviewContent;
  draft?: DraftEntryState | null;
  selected?: boolean;
};
const changedEntry = (
  entry: EntryEdit,
  {
    content = entry.content,
    draft = entry.draft,
    selected = entry.selected,
  }: EntryChange,
): EntryEdit => ({ selected, revision: entry.revision + 1, content, draft });
const unitIds = (groupId: string, content: ReviewContent) =>
  content.type === "accepted" ? content.sources.map(({ id }) => id) : [groupId];
const ownerOf = (state: ReviewState, groupId: string) => {
  for (const [id, edit] of state) {
    if (
      edit.content.type === "accepted" &&
      edit.content.sources.some((source) => source.id === groupId)
    ) {
      return id;
    }
  }
  return groupId;
};

type CommitChangeOptions = {
  state: ReviewState;
  groupId: string;
  current: EntryEdit;
  change: EntryChange;
  selectUnit?: boolean;
};
const commitChange = ({
  state,
  groupId,
  current,
  change,
  selectUnit = false,
}: CommitChangeOptions): ReviewState => {
  const next = new Map(state);
  const updated = changedEntry(current, change);
  const participants = new Set([
    ...unitIds(groupId, current.content),
    ...unitIds(groupId, updated.content),
  ]);
  next.set(groupId, updated);
  for (const id of participants) {
    if (id === groupId) {
      continue;
    }
    const participant =
      next.get(id) ?? panic("Accepted participant is missing", id);
    next.set(
      id,
      changedEntry(
        participant,
        selectUnit || updated.content.type === "accepted"
          ? { selected: updated.selected }
          : {},
      ),
    );
  }
  return next;
};

const appliedContent = (
  current: SingleReviewContent,
  result: DraftResult,
): SingleReviewContent => {
  const scalars = draftScalars(result.draft);
  const billable = current.billable;
  return {
    type: "single",
    narrative: scalars.narrative,
    classification: scalars.classification,
    billable: scalars.billable ?? billable,
  };
};
const applyResult = (
  state: ReviewState,
  target: ReviewTarget,
  result: DraftResult,
): ReviewState => {
  const current = state.get(target.groupId) ?? target.initial;
  if (
    current.content.type !== "single" ||
    ownerOf(state, target.groupId) !== target.groupId
  ) {
    return state;
  }
  return commitChange({
    state,
    groupId: target.groupId,
    current,
    change: {
      content: appliedContent(current.content, result),
      draft:
        current.draft === null || current.draft.using === "proposal"
          ? {
              using: "draft",
              result,
              originalContent: current.content,
              proposal: null,
            }
          : transitionAppliedDraft(current.draft, {
              using: "draft",
              result,
              proposal: null,
            }),
    },
  });
};

const offerResults = (
  state: ReviewState,
  action: Extract<ReviewAction, { type: "offer-results" }>,
): ReviewState => {
  let next = state;
  for (const offer of action.offers) {
    const current = next.get(offer.groupId) ?? offer.initial;
    if (
      action.mode === "initial" &&
      current.revision === offer.expectedRevision &&
      current.content.type === "single" &&
      ownerOf(next, offer.groupId) === offer.groupId
    ) {
      next = applyResult(next, offer, offer.result);
      continue;
    }
    const draft: DraftEntryState =
      current.draft === null || current.draft.using === "proposal"
        ? { using: "proposal", result: offer.result }
        : transitionAppliedDraft(current.draft, {
            using: current.draft.using,
            result: current.draft.result,
            proposal: offer.result,
          });
    const updated = new Map(next);
    updated.set(offer.groupId, {
      selected: current.selected,
      revision: current.revision,
      content: current.content,
      draft,
    });
    next = updated;
  }
  return next;
};

const editItem = (
  state: ReviewState,
  action: Extract<ReviewAction, { type: "set-narrative" | "set-billable" }>,
): ReviewState => {
  const ownerId = ownerOf(state, action.groupId);
  const current = state.get(ownerId) ?? action.initial;
  const patch =
    action.type === "set-narrative"
      ? { narrative: action.narrative }
      : { billable: action.billable };
  if (current.content.type === "single") {
    if (action.itemKey !== ownerId) {
      return panic("Unknown review item", action.itemKey);
    }
    const content = current.content;
    if (
      (action.type === "set-narrative" &&
        content.narrative === action.narrative) ||
      (action.type === "set-billable" && content.billable === action.billable)
    ) {
      return state;
    }
    return commitChange({
      state,
      groupId: ownerId,
      current,
      change: {
        content: {
          type: "single",
          narrative:
            action.type === "set-narrative"
              ? action.narrative
              : content.narrative,
          billable:
            action.type === "set-billable" ? action.billable : content.billable,
          classification: content.classification,
        },
      },
    });
  }
  const item =
    current.content.items.find(({ key }) => key === action.itemKey) ??
    panic("Unknown review item", action.itemKey);
  if (
    (action.type === "set-narrative" && item.narrative === action.narrative) ||
    (action.type === "set-billable" && item.billable === action.billable)
  ) {
    return state;
  }
  return commitChange({
    state,
    groupId: ownerId,
    current,
    change: {
      content: {
        type: "accepted",
        summary: current.content.summary,
        sources: current.content.sources,
        undoContent: current.content.undoContent,
        items: current.content.items.map((value) =>
          value.key === action.itemKey ? { ...value, ...patch } : value,
        ),
      },
    },
  });
};

type AcceptStructureAction = Extract<
  ReviewAction,
  { type: "accept-structure" }
>;
const prepareStructure = (
  state: ReviewState,
  action: AcceptStructureAction,
) => {
  const own = state.get(action.groupId) ?? action.initial;
  const ownerId = ownerOf(state, action.groupId);
  if (ownerId !== action.groupId || own.content.type !== "single") {
    return null;
  }
  const ids =
    action.proposal.type === "merge"
      ? action.proposal.groupIds
      : [action.groupId];
  if (!ids.includes(action.groupId) || new Set(ids).size !== ids.length) {
    return null;
  }
  const initialized = new Map(state);
  for (const id of ids) {
    const source = action.groups.find(({ group }) => group.id === id);
    if (!source) {
      return null;
    }
    const entry = state.get(id) ?? source.initial;
    if (
      !entry.selected ||
      entry.content.type !== "single" ||
      ownerOf(state, id) !== id
    ) {
      return null;
    }
    initialized.set(id, entry);
  }
  const group = action.groups.find(
    ({ group: candidate }) => candidate.id === action.groupId,
  )?.group;
  if (!group) {
    return null;
  }
  const minutes = group.roundedTenths * 6;
  if (
    (action.proposal.type === "split" &&
      action.proposal.parts.reduce(
        (sum, part) => sum + part.durationMinutes,
        0,
      ) !== minutes) ||
    (action.proposal.type === "move" &&
      action.proposal.durationMinutes > minutes)
  ) {
    return null;
  }
  return { own, content: own.content, initialized, group, ids };
};
export const canAcceptStructure = (
  state: ReviewState,
  action: AcceptStructureAction,
): boolean => prepareStructure(state, action) !== null;

const acceptStructure = (
  state: ReviewState,
  action: AcceptStructureAction,
): ReviewState => {
  const prepared = prepareStructure(state, action);
  if (prepared === null) {
    return state;
  }
  const { own, content, initialized, group, ids } = prepared;
  const items = materializeStructure({
    group,
    content,
    proposal: action.proposal,
    groups: action.groups.map((source) => source.group),
  });
  return commitChange({
    state: initialized,
    groupId: action.groupId,
    current: own,
    change: {
      content: {
        type: "accepted",
        summary: action.proposal.summary,
        sources: action.groups
          .filter(({ group: source }) => ids.includes(source.id))
          .map(({ group: source }) => ({
            id: source.id,
            roundedTenths: source.roundedTenths,
            ranges: source.ranges.map(({ start, end }) => ({ start, end })),
          })),
        items,
        undoContent: content,
      },
    },
  });
};

/** Invalidations persist even if later recording restores the old geometry. */
export const reviewStateForGroups = (
  state: ReviewState,
  groups: ReadonlyMap<string, DraftableGroup>,
): ReviewState => {
  let next = state;
  for (const [groupId, edit] of state) {
    const content = currentReviewContent(edit.content, groups);
    if (content === edit.content) {
      continue;
    }
    next = commitChange({
      state: next,
      groupId,
      current: edit,
      change: { content },
    });
  }
  return next;
};

/** Every offer and user action observes the state React supplies to this reducer. */
export const reviewReducer = (
  state: ReviewState,
  action: ReviewAction,
): ReviewState => {
  if (action.type === "offer-results") {
    return offerResults(state, action);
  }
  if (action.type === "undo-all") {
    let next = state;
    for (const [groupId, entry] of state) {
      if (entry.draft === null) {
        continue;
      }
      const current = next.get(groupId) ?? entry;
      next = commitChange({
        state: next,
        groupId,
        current,
        change: {
          content:
            entry.draft.using === "draft"
              ? entry.draft.originalContent
              : current.content,
          draft: null,
        },
      });
    }
    return next;
  }
  const own = state.get(action.groupId) ?? action.initial;
  const ownerId = ownerOf(state, action.groupId);
  const current =
    ownerId === action.groupId
      ? own
      : (state.get(ownerId) ?? panic("Accepted owner is missing"));
  switch (action.type) {
    case "set-selected":
      if (current.selected === action.selected) {
        return state;
      }
      return commitChange({
        state,
        groupId: ownerId,
        current,
        change: { selected: action.selected },
        selectUnit: true,
      });
    case "set-narrative":
    case "set-billable":
      return editItem(state, action);
    case "accept-structure":
      return acceptStructure(state, action);
    case "undo-structure":
      if (current.content.type !== "accepted") {
        return state;
      }
      return commitChange({
        state,
        groupId: ownerId,
        current,
        change: { content: current.content.undoContent },
      });
    case "use-original":
      if (own.draft?.using !== "draft" || ownerId !== action.groupId) {
        return state;
      }
      return commitChange({
        state,
        groupId: action.groupId,
        current: own,
        change: {
          content: own.draft.originalContent,
          draft: transitionAppliedDraft(own.draft, {
            using: "original",
            result: own.draft.result,
            proposal: own.draft.proposal,
          }),
        },
      });
    case "use-draft":
      return own.draft === null
        ? state
        : applyResult(state, action, own.draft.result);
    case "apply-proposal": {
      const result =
        own.draft?.using === "proposal"
          ? own.draft.result
          : own.draft?.proposal;
      return result ? applyResult(state, action, result) : state;
    }
    case "dismiss-proposal": {
      if (own.draft === null) {
        return state;
      }
      const draft: DraftEntryState | null =
        own.draft.using === "proposal"
          ? null
          : transitionAppliedDraft(own.draft, {
              using: own.draft.using,
              result: own.draft.result,
              proposal: null,
            });
      return commitChange({
        state,
        groupId: action.groupId,
        current: own,
        change: { draft },
      });
    }
    default:
      return panic("Unknown review action", action satisfies never);
  }
};
