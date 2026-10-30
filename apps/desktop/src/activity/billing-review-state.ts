import { panic } from "better-result";

import type { DesktopTimeEntryClassification } from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import {
  captureReviewSources,
  currentReviewContent,
  draftScalars,
  materializeStructure,
  reviewSourcesCurrent,
} from "./billing-draft-logic";
import type {
  DraftableGroup,
  DraftResult,
  ResolvedStructureProposal,
  ReviewItem,
  StructureSummary,
} from "./billing-draft-logic";

type ReviewAcceptance = {
  sources: readonly DraftableGroup[];
  undoContent: SingleReviewContent;
};
type ScalarSourceBinding =
  | ({ type: "ai" } & ReviewAcceptance)
  | { type: "user"; sources: readonly DraftableGroup[] };
export type SingleReviewContent = {
  type: "single";
  narrative: string;
  billable: boolean;
  classification: DesktopTimeEntryClassification | null;
  notice?: "sourceChanged";
  sourceBinding?: ScalarSourceBinding;
};
export type AcceptedReviewContent = {
  sources: readonly DraftableGroup[];
  recovery: ReviewRecovery;
  type: "accepted";
  ownership: "ai" | "user";
  notice?: never;
  summary: StructureSummary;
  items: readonly ReviewItem[];
};
export type ReviewRecovery = {
  type: "undo-structure";
  content: SingleReviewContent;
};
export type BlockedReviewContent = {
  type: "blocked";
  ownership: "user";
  notice: "sourceChanged";
  sources: readonly DraftableGroup[];
  summary: StructureSummary;
  items: readonly ReviewItem[];
  recovery: ReviewRecovery;
};
export type ReviewContent =
  SingleReviewContent | AcceptedReviewContent | BlockedReviewContent;

/** Structured content owns its recovery independently of optional AI suggestions. */
export const reviewRecovery = (
  content: ReviewContent,
): ReviewRecovery | null => {
  switch (content.type) {
    case "single":
      return null;
    case "accepted":
      return content.recovery;
    case "blocked":
      return content.recovery;
    default:
      return panic("Unknown review content", content satisfies never);
  }
};
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
type RetainedReview = { group: DraftableGroup; edit: EntryEdit };

/** Active ownership and historical user work are separate; history never participates in lookups. */
export class ReviewState extends Map<string, EntryEdit> {
  readonly groups: Map<string, DraftableGroup>;
  readonly retained: Map<string, RetainedReview>;
  constructor(entries: Iterable<readonly [string, EntryEdit]> = []) {
    super(entries);
    this.groups = new Map(entries instanceof ReviewState ? entries.groups : []);
    this.retained = new Map(
      entries instanceof ReviewState ? entries.retained : [],
    );
  }
}
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
      groups: ReadonlyMap<string, DraftableGroup>;
      mode: "initial" | "steer";
      offers: readonly (ReviewTarget & {
        expectedRevision: number;
        result: DraftResult;
      })[];
    }
  | (ReviewTarget & {
      type: "use-original" | "dismiss-proposal" | "undo-structure";
    })
  | (ReviewTarget & {
      type: "use-draft";
      groups: ReadonlyMap<string, DraftableGroup>;
    })
  | (ReviewTarget & {
      type: "apply-proposal";
      groups: ReadonlyMap<string, DraftableGroup>;
    })
  | (ReviewTarget & {
      type: "accept-structure";
      proposal: ResolvedStructureProposal;
      groups: readonly { group: DraftableGroup; initial: EntryEdit }[];
    })
  | { type: "undo-all" };

/** Source context is supplied by the review owner, never by a pending request. */
type SourceBoundAction = Extract<
  ReviewAction,
  { groups: ReadonlyMap<string, DraftableGroup> }
>;
export type ReviewEvent =
  | Exclude<ReviewAction, SourceBoundAction>
  | {
      [Type in SourceBoundAction["type"]]: Omit<
        Extract<SourceBoundAction, { type: Type }>,
        "groups"
      >;
    }[SourceBoundAction["type"]];

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
  content.type === "single" ? [groupId] : content.sources.map(({ id }) => id);
const ownerOf = (state: ReviewState, groupId: string) => {
  for (const [id, edit] of state) {
    if (
      state.groups.has(id) &&
      edit.content.type !== "single" &&
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
  const next = new ReviewState(state);
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
        selectUnit || updated.content.type !== "single"
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
    sourceBinding: {
      type: "ai",
      sources: result.sources,
      undoContent:
        current.sourceBinding?.type === "ai"
          ? current.sourceBinding.undoContent
          : current,
    },
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

const applyReviewedResult = (
  state: ReviewState,
  action: Extract<ReviewAction, { type: "use-draft" | "apply-proposal" }>,
  result: DraftResult,
): ReviewState => {
  const sources = result.sources.map((source) => action.groups.get(source.id));
  if (sources.some((source) => source === undefined)) {
    return state;
  }
  return applyResult(state, action, {
    draft: result.draft,
    sources: captureReviewSources(
      sources.filter((source) => source !== undefined),
    ),
  });
};

const offerResults = (
  state: ReviewState,
  action: Extract<ReviewAction, { type: "offer-results" }>,
): ReviewState => {
  let next = reviewStateForGroups(state, action.groups);
  for (const offer of action.offers) {
    if (!action.groups.has(offer.groupId)) {
      continue;
    }
    const current = next.get(offer.groupId) ?? offer.initial;
    const sourceCurrent = reviewSourcesCurrent(
      offer.result.sources,
      action.groups,
    );
    if (
      action.mode === "initial" &&
      sourceCurrent &&
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
    const updated = new ReviewState(next);
    updated.set(offer.groupId, {
      selected: current.selected,
      revision: current.revision,
      content:
        !sourceCurrent && current.content.type === "single"
          ? {
              type: "single",
              narrative: current.content.narrative,
              billable: current.content.billable,
              classification: current.content.classification,
              notice: "sourceChanged",
              ...(current.content.sourceBinding
                ? { sourceBinding: current.content.sourceBinding }
                : {}),
            }
          : current.content,
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
          ...(content.notice ? { notice: content.notice } : {}),
          ...(content.sourceBinding
            ? {
                sourceBinding: {
                  type: "user" as const,
                  sources: content.sourceBinding.sources,
                },
              }
            : {}),
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
  const items = current.content.items.map((value) =>
    value.key === action.itemKey ? { ...value, ...patch } : value,
  );
  const content: ReviewContent =
    current.content.type === "blocked"
      ? {
          type: "blocked",
          ownership: "user",
          notice: "sourceChanged",
          sources: current.content.sources,
          summary: current.content.summary,
          items,
          recovery: current.content.recovery,
        }
      : {
          type: "accepted",
          ownership: "user",
          sources: current.content.sources,
          summary: current.content.summary,
          items,
          recovery: current.content.recovery,
        };
  return commitChange({
    state,
    groupId: ownerId,
    current,
    change: { content },
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
  const currentState = reviewStateForGroups(
    state,
    new Map(action.groups.map(({ group }) => [group.id, group])),
  );
  const own = currentState.get(action.groupId) ?? action.initial;
  const ownerId = ownerOf(currentState, action.groupId);
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
  const initialized = new ReviewState(currentState);
  initialized.groups.clear();
  for (const { group } of action.groups) {
    initialized.groups.set(group.id, structuredClone(group));
  }
  for (const id of ids) {
    const source = action.groups.find(({ group }) => group.id === id);
    if (!source) {
      return null;
    }
    const entry = currentState.get(id) ?? source.initial;
    if (
      !entry.selected ||
      entry.content.type !== "single" ||
      ownerOf(currentState, id) !== id
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
        ownership: "ai",
        summary: action.proposal.summary,
        sources: captureReviewSources(
          action.groups
            .filter(({ group: source }) => ids.includes(source.id))
            .map(({ group: source }) => source),
        ),
        items,
        recovery: { type: "undo-structure", content },
      },
    },
  });
};

const rangesOverlap = (
  left: DraftableGroup["ranges"],
  right: DraftableGroup["ranges"],
) =>
  left.some((a) =>
    right.some(
      (b) =>
        Temporal.Instant.compare(
          Temporal.Instant.from(a.start),
          Temporal.Instant.from(b.end),
        ) < 0 &&
        Temporal.Instant.compare(
          Temporal.Instant.from(b.start),
          Temporal.Instant.from(a.end),
        ) < 0,
    ),
  );

const scalarRecovery = (
  content: SingleReviewContent,
  groups: ReadonlyMap<string, DraftableGroup>,
) => {
  const current = currentReviewContent(content, groups);
  if (current.type !== "single") {
    return panic("Scalar recovery became structured content");
  }
  return current;
};

type DetachReviewOptions = {
  state: ReviewState;
  ownerId: string;
  edit: EntryEdit;
  source: DraftableGroup;
  groups: ReadonlyMap<string, DraftableGroup>;
  detached: Set<string>;
};
const detachReview = ({
  state,
  ownerId,
  edit,
  source,
  groups,
  detached,
}: DetachReviewOptions) => {
  const content = edit.content;
  const sources = content.type === "single" ? [source] : content.sources;
  const ranges =
    content.type === "single"
      ? source.ranges
      : content.items.flatMap(({ ranges: itemRanges }) => itemRanges);
  const recipients = [...groups.values()].filter(
    (group) =>
      group.id === ownerId ||
      sources.some(({ id }) => id === group.id) ||
      rangesOverlap(group.ranges, ranges),
  );
  const existingOwner = state.get(ownerId);
  state.delete(ownerId);
  if (recipients.length === 0) {
    state.retained.set(ownerId, { group: source, edit });
    return;
  }
  state.retained.delete(ownerId);
  const fallback = scalarRecovery(
    content.type === "single" ? content : content.recovery.content,
    groups,
  );
  const userOwned =
    content.type === "single"
      ? content.sourceBinding?.type !== "ai"
      : content.ownership === "user";
  for (const group of recipients) {
    const previous = group.id === ownerId ? existingOwner : state.get(group.id);
    const prior = previous?.content;
    const recovery =
      prior === undefined
        ? fallback
        : scalarRecovery(
            prior.type === "single" ? prior : prior.recovery.content,
            groups,
          );
    if (!userOwned) {
      if (group.id !== ownerId && previous !== undefined) {
        continue;
      }
      state.set(group.id, {
        selected: edit.selected,
        revision: edit.revision + 1,
        draft: null,
        content: recovery,
      });
      continue;
    }
    const items =
      content.type === "single"
        ? [
            {
              key: ownerId,
              matter: source.matter,
              durationMinutes: source.roundedTenths * 6,
              narrative: content.narrative,
              billable: content.billable,
              classification: content.classification,
              ranges: source.ranges,
            },
          ]
        : [...content.items];
    const keepPrevious =
      prior !== undefined &&
      (detached.has(group.id) || !sources.some(({ id }) => id === group.id));
    if (keepPrevious) {
      if (prior.type === "single") {
        items.push({
          key: group.id,
          matter: group.matter,
          durationMinutes: group.roundedTenths * 6,
          narrative: prior.narrative,
          billable: prior.billable,
          classification: prior.classification,
          ranges: group.ranges,
        });
      } else {
        items.push(...prior.items);
      }
    }
    state.set(group.id, {
      selected: previous?.selected ?? edit.selected,
      revision: Math.max(previous?.revision ?? 0, edit.revision) + 1,
      draft: null,
      content: {
        type: "blocked",
        ownership: "user",
        notice: "sourceChanged",
        sources: captureReviewSources([group]),
        summary:
          content.type === "single"
            ? { type: "split", parts: items.length }
            : content.summary,
        items: [
          ...new Map(
            items.map((item) => [
              JSON.stringify([
                item.matter.id,
                item.durationMinutes,
                item.narrative,
                item.billable,
                item.classification,
                item.ranges,
              ]),
              item,
            ]),
          ).values(),
        ].map((item, index) => ({
          ...item,
          key: index === 0 ? group.id : `${group.id}:retained:${index}`,
        })),
        recovery: { type: "undo-structure", content: recovery },
      },
    });
    detached.add(group.id);
  }
};

/** Reconcile live ownership before any edit; historical values never own current groups. */
export const reviewStateForGroups = (
  state: ReviewState,
  groups: ReadonlyMap<string, DraftableGroup>,
): ReviewState => {
  const next = new ReviewState(state);
  let changed =
    state.groups.size !== groups.size ||
    !reviewSourcesCurrent([...state.groups.values()], groups);
  next.groups.clear();
  for (const group of captureReviewSources([...groups.values()])) {
    next.groups.set(group.id, group);
  }
  const detached = new Set<string>();
  for (const [ownerId, { group, edit }] of state.retained) {
    detachReview({
      state: next,
      ownerId,
      edit,
      source: group,
      groups,
      detached,
    });
    if (!next.retained.has(ownerId)) {
      changed = true;
    }
  }
  for (const [groupId, edit] of state) {
    const content = edit.content;
    const missing =
      !groups.has(groupId) ||
      (content.type !== "single" &&
        (content.sources.some(({ id }) => !groups.has(id)) ||
          (content.sources.length > 1 &&
            content.sources.some(({ id }) => detached.has(id)))));
    if (!missing) {
      continue;
    }
    const source =
      state.groups.get(groupId) ??
      (content.type === "single"
        ? content.sourceBinding?.sources.find(({ id }) => id === groupId)
        : content.sources.find(({ id }) => id === groupId));
    if (source === undefined) {
      return panic("Review lost its source snapshot", groupId);
    }
    detachReview({
      state: next,
      ownerId: groupId,
      edit,
      source,
      groups,
      detached,
    });
    changed = true;
  }
  for (const [groupId, edit] of next) {
    let content = currentReviewContent(edit.content, groups);
    if (content.type !== "single") {
      const recovery = scalarRecovery(content.recovery.content, groups);
      if (recovery !== content.recovery.content) {
        content = {
          ...content,
          recovery: { type: "undo-structure", content: recovery },
        };
      }
    }
    if (content === edit.content) {
      continue;
    }
    next.set(
      groupId,
      changedEntry(edit, {
        content,
        draft:
          edit.draft === null
            ? null
            : { using: "proposal", result: edit.draft.result },
      }),
    );
    changed = true;
  }
  return changed ? next : state;
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
    case "undo-structure": {
      const recovery = reviewRecovery(current.content);
      return recovery === null
        ? state
        : commitChange({
            state,
            groupId: ownerId,
            current,
            change: { content: recovery.content },
          });
    }
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
        : applyReviewedResult(state, action, own.draft.result);
    case "apply-proposal": {
      const result =
        own.draft?.using === "proposal"
          ? own.draft.result
          : own.draft?.proposal;
      return result ? applyReviewedResult(state, action, result) : state;
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
