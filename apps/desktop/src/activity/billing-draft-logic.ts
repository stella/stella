import { panic } from "better-result";

import { DESKTOP_BILLING_DRAFT_LIMITS } from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopBillingDraft,
  DesktopBillingDraftOperation,
  DesktopBillingDraftRequest,
  DesktopBillingDraftResponse,
  DesktopBillingDraftReview,
} from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopMatter,
  DesktopTimeEntryClassification,
  DesktopTimeEntryMatterCandidate,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import { documentName } from "./activity-logic";
import type {
  ReviewContent,
  SingleReviewContent,
} from "./billing-review-state";
import type { DayReviewGroup } from "./day-review-logic";

type ActivityRange = { start: string; end: string };

export type DraftableGroup = DayReviewGroup & {
  matter: DesktopTimeEntryMatterCandidate;
};

/** The server numbers drafts by position in the request, starting at 1. */
const draftEntryId = (index: number) => `entry_${index + 1}`;

const unique = (values: readonly string[]) => [...new Set(values)];

// The contract bounds each name in UTF-16 units; clipping by code point never
// leaves half a surrogate pair behind.
const clipped = (text: string) => {
  if (text.length <= DESKTOP_BILLING_DRAFT_LIMITS.nameLength) {
    return text;
  }
  let result = "";
  for (const character of text) {
    if (
      result.length + character.length >
      DESKTOP_BILLING_DRAFT_LIMITS.nameLength
    ) {
      break;
    }
    result += character;
  }
  return result;
};

const boundedNames = (names: readonly string[]) =>
  unique(names.map(clipped).filter((name) => name.length > 0)).slice(
    0,
    DESKTOP_BILLING_DRAFT_LIMITS.evidenceItems,
  );

type DraftRequestEntriesOptions = {
  groups: readonly DraftableGroup[];
  date: string;
  timezone: string;
  captureDetails: boolean;
};

/**
 * The only activity a drafting request carries: each selected entry's matter,
 * date, duration and app names, plus the document names and window titles the
 * review already shows, and those only when the user records titles.
 */
export const draftRequestEntries = ({
  groups,
  date,
  timezone,
  captureDetails,
}: DraftRequestEntriesOptions): DesktopBillingDraftRequest["entries"] =>
  groups.map((group) => {
    const entry = {
      matterId: group.matter.id,
      date,
      timezone,
      durationMinutes: group.roundedTenths * 6,
      appNames: boundedNames(group.apps.map(({ name }) => name)),
    };
    if (!captureDetails) {
      return entry;
    }
    const documentNames = boundedNames(
      group.segments.flatMap(({ document }) =>
        document ? [documentName(document)] : [],
      ),
    );
    const windowTitles = boundedNames(
      group.segments.flatMap(({ document, windowTitle }) =>
        windowTitle &&
        (document === null || windowTitle !== documentName(document))
          ? [windowTitle]
          : [],
      ),
    );
    if (documentNames.length === 0 && windowTitles.length === 0) {
      return entry;
    }
    return { ...entry, evidence: { documentNames, windowTitles } };
  });

/** One structural change a draft proposes; scalar changes edit the entry. */
export type DraftStructure = Extract<
  DesktopBillingDraftOperation,
  { type: "split" | "merge" | "move" }
>;

/** What a structural change does, in the terms the review shows. */
export type StructureSummary =
  | { type: "split"; parts: number }
  | { type: "move"; minutes: number; matter: string }
  | { type: "merge"; entries: number };

export const summarizeStructure = (
  structure: DraftStructure,
): StructureSummary => {
  switch (structure.type) {
    case "split":
      return { type: "split", parts: structure.parts.length };
    case "move":
      return {
        type: "move",
        minutes: structure.durationMinutes,
        matter: structure.targetMatterName,
      };
    case "merge":
      return { type: "merge", entries: structure.entryIds.length };
    default:
      return panic(
        "Unknown billing draft structure",
        structure satisfies never,
      );
  }
};

export const draftStructure = (draft: DesktopBillingDraft) =>
  draft.operations.find(
    (operation): operation is DraftStructure =>
      operation.type === "split" ||
      operation.type === "merge" ||
      operation.type === "move",
  ) ?? null;

/** The scalar outcome of a draft: its narrative and classification, with the
 * billable choice it proposes, if any. */
export const draftScalars = (draft: DesktopBillingDraft) => {
  let narrative = draft.narrative;
  let classification = draft.classification;
  let billable: boolean | null = null;
  for (const operation of draft.operations) {
    switch (operation.type) {
      case "rewrite":
        narrative = operation.narrative;
        break;
      case "change_classification":
        classification = operation.classification;
        break;
      case "set_billable":
        billable = operation.billable;
        break;
      case "split":
      case "merge":
      case "move":
        break;
      default:
        return panic(
          "Unknown billing draft operation",
          operation satisfies never,
        );
    }
  }
  return { narrative, classification, billable };
};

/**
 * Cuts the ranges, in time order, into consecutive parts weighted by minutes,
 * so every part of a split or move keeps time it actually covers and no two
 * parts overlap.
 */
export const partitionRanges = (
  ranges: readonly ActivityRange[],
  weights: readonly number[],
): ActivityRange[][] => {
  const spans = ranges
    .map(({ start, end }) => ({
      startMs: Temporal.Instant.from(start).epochMilliseconds,
      endMs: Temporal.Instant.from(end).epochMilliseconds,
    }))
    .sort((left, right) => left.startMs - right.startMs);
  const totalMs = spans.reduce(
    (sum, { startMs, endMs }) => sum + endMs - startMs,
    0,
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalMs < weights.length || totalWeight <= 0) {
    return panic("Ranges are too short to partition", { totalMs, weights });
  }
  const parts: ActivityRange[][] = [];
  let spanIndex = 0;
  let cursorMs = spans.at(0)?.startMs ?? 0;
  let consumedMs = 0;
  let cumulativeWeight = 0;
  for (const [partIndex, weight] of weights.entries()) {
    cumulativeWeight += weight;
    const lastPart = partIndex === weights.length - 1;
    // Each part keeps at least a millisecond, and each later part leaves one
    // for every part after it.
    const targetMs = lastPart
      ? totalMs
      : Math.min(
          Math.max(
            Math.round((totalMs * cumulativeWeight) / totalWeight),
            consumedMs + 1,
          ),
          totalMs - (weights.length - partIndex - 1),
        );
    const part: ActivityRange[] = [];
    while (consumedMs < targetMs) {
      const span =
        spans.at(spanIndex) ?? panic("Partition ran past the ranges");
      const takeMs = Math.min(span.endMs - cursorMs, targetMs - consumedMs);
      part.push({
        start: Temporal.Instant.fromEpochMilliseconds(cursorMs).toString(),
        end: Temporal.Instant.fromEpochMilliseconds(
          cursorMs + takeMs,
        ).toString(),
      });
      cursorMs += takeMs;
      consumedMs += takeMs;
      if (cursorMs === span.endMs) {
        spanIndex += 1;
        cursorMs = spans.at(spanIndex)?.startMs ?? cursorMs;
      }
    }
    parts.push(part);
  }
  return parts;
};

export type ReviewItem = {
  /** Stable key for the row: the source group, plus the part for splits. */
  key: string;
  matter: DesktopMatter;
  durationMinutes: number;
  narrative: string;
  billable: boolean;
  classification: DesktopTimeEntryClassification | null;
  ranges: ActivityRange[];
};

export type ReviewRow = { group: DraftableGroup; content: ReviewContent };

export type ResolvedStructureProposal = { summary: StructureSummary } & (
  | Extract<DraftStructure, { type: "split" }>
  | (Omit<Extract<DraftStructure, { type: "merge" }>, "entryIds"> & {
      groupIds: string[];
    })
  | (Extract<DraftStructure, { type: "move" }> & {
      targetMatter: DesktopMatter;
    })
);

const matterOf = ({ id, name, reference, color }: DesktopMatter) => ({
  id,
  name,
  reference,
  color,
});

/** Accepted units retain their original participants even while deselected. */
export const absorbedGroupIds = (rows: readonly ReviewRow[]) =>
  new Set(
    rows.flatMap(({ group, content }) =>
      content.type === "accepted"
        ? content.sourceGroupIds.filter((id) => id !== group.id)
        : [],
    ),
  );

const singleItem = ({
  group,
  content,
}: {
  group: DraftableGroup;
  content: SingleReviewContent;
}): ReviewItem => ({
  key: group.id,
  matter: matterOf(group.matter),
  durationMinutes: group.roundedTenths * 6,
  narrative: content.narrative,
  billable: content.billable,
  classification: content.classification,
  ranges: group.ranges,
});

/** The same materialized items are displayed, edited, and submitted. */
export const reviewItems = (rows: readonly ReviewRow[]): ReviewItem[] => {
  const absorbed = absorbedGroupIds(rows);
  return rows.flatMap(({ group, content }) => {
    if (absorbed.has(group.id)) {
      return [];
    }
    return content.type === "accepted"
      ? [...content.items]
      : [singleItem({ group, content })];
  });
};

type MaterializeStructureOptions = {
  group: DraftableGroup;
  content: SingleReviewContent;
  proposal: ResolvedStructureProposal;
  groups: readonly DraftableGroup[];
};

/** Resolve geometry once when the person accepts the proposal. */
export const materializeStructure = ({
  group,
  content,
  proposal,
  groups,
}: MaterializeStructureOptions): ReviewItem[] => {
  const base = singleItem({ group, content });
  switch (proposal.type) {
    case "split": {
      const ranges = partitionRanges(
        group.ranges,
        proposal.parts.map(({ durationMinutes }) => durationMinutes),
      );
      return proposal.parts.map((part, index) => ({
        ...part,
        key: `${group.id}:${index}`,
        matter: base.matter,
        ranges: ranges.at(index) ?? panic("Split part has no ranges"),
      }));
    }
    case "move": {
      const moved = {
        key: `${group.id}:moved`,
        matter: matterOf(proposal.targetMatter),
        durationMinutes: proposal.durationMinutes,
        narrative: proposal.narrative,
        billable: proposal.billable,
        classification: proposal.classification,
      };
      const remainder = base.durationMinutes - proposal.durationMinutes;
      if (remainder <= 0) {
        return [{ ...moved, ranges: group.ranges }];
      }
      const [kept, rest] = partitionRanges(group.ranges, [
        remainder,
        proposal.durationMinutes,
      ]);
      return [
        {
          ...base,
          durationMinutes: remainder,
          ranges: kept ?? panic("Move kept no ranges"),
        },
        { ...moved, ranges: rest ?? panic("Move moved no ranges") },
      ];
    }
    case "merge": {
      const merged = proposal.groupIds.map(
        (id) =>
          groups.find((candidate) => candidate.id === id) ??
          panic("Merged group is missing", id),
      );
      return [
        {
          ...base,
          durationMinutes: merged.reduce(
            (sum, item) => sum + item.roundedTenths * 6,
            0,
          ),
          narrative: proposal.narrative,
          billable: proposal.billable,
          classification: proposal.classification,
          ranges: merged.flatMap((item) => item.ranges),
        },
      ];
    }
    default:
      return panic("Unknown structure proposal", proposal satisfies never);
  }
};

type DraftsForGroupsOptions = {
  groupIds: readonly string[];
  review: DesktopBillingDraftReview;
};

/** Each sent group's draft, keyed by group id. */
export const draftsByGroup = ({ groupIds, review }: DraftsForGroupsOptions) =>
  new Map(
    groupIds.map((groupId, index) => [
      groupId,
      review.result.drafts.find(
        ({ entryId }) => entryId === draftEntryId(index),
      ) ?? panic("Billing draft is missing an entry", draftEntryId(index)),
    ]),
  );

type ResolveStructureOptions = {
  structure: DraftStructure;
  groupIds: readonly string[];
  candidates: readonly DesktopTimeEntryMatterCandidate[];
};

/** Resolves a proposal's draft ids to the groups the review shows, and its
 * target to a known matter; null when a merged entry is no longer sent. The
 * server names a move target from authorized context, so an unknown target
 * keeps that name without a colour or reference. */
export const resolveStructure = ({
  structure,
  groupIds,
  candidates,
}: ResolveStructureOptions): ResolvedStructureProposal | null => {
  const summary = summarizeStructure(structure);
  switch (structure.type) {
    case "split":
      return { ...structure, summary };
    case "move": {
      const target = candidates.find(
        ({ id }) => id === structure.targetMatterId,
      );
      return {
        ...structure,
        summary,
        targetMatter: target
          ? matterOf(target)
          : {
              id: structure.targetMatterId,
              name: structure.targetMatterName,
              reference: null,
              color: null,
            },
      };
    }
    case "merge": {
      const resolved = structure.entryIds.map((entryId) =>
        groupIds.find((_, index) => draftEntryId(index) === entryId),
      );
      if (resolved.some((id) => id === undefined)) {
        return null;
      }
      return {
        type: "merge",
        summary,
        groupIds: resolved.filter((id) => id !== undefined),
        narrative: structure.narrative,
        classification: structure.classification,
        billable: structure.billable,
      };
    }
    default:
      return panic(
        "Unknown billing draft structure",
        structure satisfies never,
      );
  }
};

/** One entry's draft and the request it answered, whose positions its
 * entry ids refer to. */
export type DraftResult = {
  draft: DesktopBillingDraft;
  sentGroupIds: readonly string[];
};

type PreviousDraftTarget = { groupId: string; result: DraftResult };

/**
 * The steering request's previous result for these groups, in this order: draft
 * ids renumbered to the new positions, merges dropped once a source falls
 * outside the selection, and only the guideline files the kept flags cite.
 */
export const previousDraftResult = (
  targets: readonly PreviousDraftTarget[],
): DesktopBillingDraftResponse => {
  const positions = new Map(
    targets.map(({ groupId }, index) => [groupId, draftEntryId(index)]),
  );
  const drafts = targets.map(({ groupId, result: { draft, sentGroupIds } }) => {
    const renumbered = (entryId: string) => {
      const sourceGroupId = sentGroupIds.find(
        (_, index) => draftEntryId(index) === entryId,
      );
      return sourceGroupId === undefined
        ? undefined
        : positions.get(sourceGroupId);
    };
    return {
      ...draft,
      entryId: positions.get(groupId) ?? panic("Steered group has no position"),
      operations: draft.operations
        .map((operation) => {
          if (operation.type !== "merge") {
            return operation;
          }
          const entryIds = operation.entryIds.map(renumbered);
          return entryIds.every((id) => id !== undefined)
            ? { ...operation, entryIds }
            : null;
        })
        .filter((operation) => operation !== null),
    };
  });
  const cited = new Map(
    drafts.flatMap(({ flags }) =>
      flags.map(({ ruleRef: { fileId, fileName } }) => [
        fileId,
        { fileId, fileName },
      ]),
    ),
  );
  return { drafts, checkedGuidelines: [...cited.values()] };
};
