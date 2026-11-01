import { panic } from "better-result";
import * as v from "valibot";

import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftReviewSchema,
  desktopBillingDraftSettingsResponseSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopBillingDraft,
  DesktopBillingDraftOperation,
  DesktopBillingDraftRequest,
  DesktopBillingDraftResponse,
  DesktopBillingDraftReview,
  DesktopBillingDraftSettingsResponse,
} from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopTimeEntryBatch,
  DesktopTimeEntryClassification,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import { documentName } from "./activity-logic";
import type { DayReviewGroup } from "./day-review-logic";

/** The one entry a card sends; the review names its draft by this id. */
export const CARD_DRAFT_ENTRY_ID = "entry_1";

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

type CardDraftEntryOptions = {
  suggestion: Pick<DayReviewGroup, "apps" | "segments" | "roundedTenths">;
  matterId: string;
  date: string;
  timezone: string;
  captureDetails: boolean;
};

/**
 * The only activity a card's drafting request carries: the entry's matter,
 * date, duration and app names, plus the document names and window titles
 * the card already shows, and those only when the user records titles.
 */
export const cardDraftEntry = ({
  suggestion,
  matterId,
  date,
  timezone,
  captureDetails,
}: CardDraftEntryOptions): DesktopBillingDraftRequest["entries"][number] => {
  const entry = {
    entryId: CARD_DRAFT_ENTRY_ID,
    matterId,
    date,
    timezone,
    durationMinutes: Math.min(
      Math.max(suggestion.roundedTenths * 6, 1),
      DESKTOP_BILLING_DRAFT_LIMITS.durationMinutes,
    ),
    appNames: boundedNames(suggestion.apps.map(({ name }) => name)),
  };
  if (!captureDetails) {
    return entry;
  }
  const documentNames = boundedNames(
    suggestion.segments.flatMap(({ document }) =>
      document ? [documentName(document)] : [],
    ),
  );
  const windowTitles = boundedNames(
    suggestion.segments.flatMap(({ document, windowTitle }) =>
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
};

/** Why a draft could not be written, as the native boundary names it. */
export const DRAFT_FAILURE_KINDS = [
  "off",
  "consentRequired",
  "refused",
  "modeChanged",
  "tooLarge",
  "failed",
] as const;

export type DraftFailureKind = (typeof DRAFT_FAILURE_KINDS)[number];

const isDraftFailureKind = (type: unknown): type is DraftFailureKind =>
  DRAFT_FAILURE_KINDS.some((kind) => kind === type);

/** The failure a rejected drafting invoke stands for; anything the boundary
 * does not name is one generic failure. */
export const draftFailureKind = (cause: unknown): DraftFailureKind => {
  const type =
    typeof cause === "object" && cause !== null && "type" in cause
      ? cause.type
      : undefined;
  return isDraftFailureKind(type) ? type : "failed";
};

/** A note a guided draft raises against the firm's billing guidelines, with
 * the file and section it cites; `split` when splitting the entry fixes it. */
export type GuidelineFlag = {
  text: string;
  fileName: string;
  section: string;
  fix: "split" | null;
};

/** A guided draft's proposal to change the card's one entry into others: a
 * split into parts, or time moved to another matter. A merge needs several
 * entries, which a card never sends. */
export type CardStructure = Extract<
  DesktopBillingDraftOperation,
  { type: "split" | "move" }
>;

/** What a card shows from a review: its description, the earlier entries the
 * draft followed and, from a guided draft, the entry's classification, a
 * billable choice, the guideline notes and a structural proposal. */
export type CardDraft = {
  narrative: string;
  earlierEntries: DesktopBillingDraftReview["earlierEntries"];
  classification: DesktopTimeEntryClassification | null;
  /** The billable choice the draft proposes, or `null` to keep the card's. */
  billable: boolean | null;
  flags: GuidelineFlag[];
  structure: CardStructure | null;
  /** The server's result as it came, which a refining request sends back
   * unchanged. */
  result: DesktopBillingDraftResponse;
};

/** A guided draft's description, classification and billable choice after
 * its operations, in order. */
const draftScalars = (draft: DesktopBillingDraft) => {
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
        operation satisfies never;
        return panic("Unknown billing draft operation");
    }
  }
  return { narrative, classification, billable };
};

/**
 * The draft's split or move, only when it accounts for exactly the time the
 * card recorded: a split's parts add up to the entry, and a move takes part
 * or all of it to another matter. Anything else would bill time that was not
 * recorded, so it is not offered.
 */
const cardStructure = (
  draft: DesktopBillingDraft,
  durationMinutes: number,
  matterId: string,
): CardStructure | null => {
  for (const operation of draft.operations) {
    switch (operation.type) {
      case "split":
        return operation.parts.reduce(
          (sum, part) => sum + part.durationMinutes,
          0,
        ) === durationMinutes
          ? operation
          : null;
      case "move":
        return operation.durationMinutes <= durationMinutes &&
          operation.targetMatterId !== matterId
          ? operation
          : null;
      case "merge":
      case "rewrite":
      case "change_classification":
      case "set_billable":
        break;
      default:
        operation satisfies never;
        return panic("Unknown billing draft operation");
    }
  }
  return null;
};

/** The entry a card drafted: its matter and the minutes it records. */
export type CardDraftTarget = { matterId: string; durationMinutes: number };

/** The card's draft from a server review, or `null` when the answer does not
 * hold the contract or names no draft for the card's entry. */
export const cardDraftFrom = (
  value: unknown,
  target: CardDraftTarget,
): CardDraft | null => {
  const parsed = v.safeParse(desktopBillingDraftReviewSchema, value);
  if (!parsed.success) {
    return null;
  }
  const { result, earlierEntries } = parsed.output;
  const followed = (matched: readonly string[]) => {
    const cited = new Set(matched);
    return earlierEntries.filter(({ id }) => cited.has(id));
  };
  if (result.mode === "plain") {
    const draft = result.drafts.find(
      ({ entryId }) => entryId === CARD_DRAFT_ENTRY_ID,
    );
    return draft === undefined
      ? null
      : {
          narrative: draft.narrative,
          earlierEntries: followed(draft.matchedEarlierEntryIds),
          classification: null,
          billable: null,
          flags: [],
          structure: null,
          result,
        };
  }
  const draft = result.drafts.find(
    ({ entryId }) => entryId === CARD_DRAFT_ENTRY_ID,
  );
  if (draft === undefined) {
    return null;
  }
  return {
    ...draftScalars(draft),
    earlierEntries: followed(draft.matchedEarlierEntryIds),
    flags: draft.flags.map(({ text, ruleRef, fix }) => ({
      text,
      fileName: ruleRef.fileName,
      section: ruleRef.section,
      fix: fix ?? null,
    })),
    structure: cardStructure(draft, target.durationMinutes, target.matterId),
    result,
  };
};

type ActivityRange = { start: string; end: string };

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
    .toSorted((left, right) => left.startMs - right.startMs);
  const totalMs = spans.reduce(
    (sum, { startMs, endMs }) => sum + endMs - startMs,
    0,
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalMs < weights.length || totalWeight <= 0) {
    return panic("Ranges are too short to partition");
  }
  const parts: ActivityRange[][] = [];
  let spanIndex = 0;
  let cursorMs = spans.at(0)?.startMs ?? 0;
  let consumedMs = 0;
  let cumulativeWeight = 0;
  for (const [partIndex, weight] of weights.entries()) {
    cumulativeWeight += weight;
    // Each part keeps at least a millisecond, and leaves one for every part
    // after it.
    const targetMs =
      partIndex === weights.length - 1
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

/** One confirmed entry and the recorded ranges it covers. */
export type StructureBatchItem = {
  entry: DesktopTimeEntryBatch["entries"][number];
  ranges: ActivityRange[];
};

type StructureItemsOptions = {
  structure: CardStructure;
  /** The card as the user left it, which a partial move keeps. */
  card: {
    matterId: string;
    narrative: string;
    billable: boolean;
    classification: DesktopTimeEntryClassification | null;
  };
  durationMinutes: number;
  ranges: readonly ActivityRange[];
  date: string;
  timezoneId: string;
};

/** The entries an accepted split or move creates, each with its own share of
 * the recorded time, in time order. */
export const structureItems = ({
  structure,
  card,
  durationMinutes,
  ranges,
  date,
  timezoneId,
}: StructureItemsOptions): StructureBatchItem[] => {
  type Part = {
    matterId: string;
    durationMinutes: number;
    narrative: string;
    billable: boolean;
    classification: DesktopTimeEntryClassification | null;
  };
  const parts: Part[] = (() => {
    switch (structure.type) {
      case "split":
        return structure.parts.map((part) => ({
          ...part,
          matterId: card.matterId,
        }));
      case "move": {
        const moved = {
          matterId: structure.targetMatterId,
          durationMinutes: structure.durationMinutes,
          narrative: structure.narrative,
          billable: structure.billable,
          classification: structure.classification,
        };
        const kept = durationMinutes - structure.durationMinutes;
        return kept > 0 ? [{ ...card, durationMinutes: kept }, moved] : [moved];
      }
      default:
        structure satisfies never;
        return panic("Unknown card structure");
    }
  })();
  const shares = partitionRanges(
    ranges,
    parts.map((part) => part.durationMinutes),
  );
  return parts.map((part, index) => ({
    entry: {
      matterId: part.matterId,
      dateWorked: date,
      timezoneId,
      durationMinutes: part.durationMinutes,
      narrative: part.narrative,
      billable: part.billable,
      ...(part.classification === null
        ? {}
        : { classification: part.classification }),
    },
    ranges: shares.at(index) ?? panic("A structure part has no ranges"),
  }));
};

const scopedSettingsSchema = v.strictObject({
  scopeKey: v.pipe(v.string(), v.minLength(1)),
  settings: desktopBillingDraftSettingsResponseSchema,
});

/** A settings answer from the native boundary: the server's settings and the
 * account they belong to. */
export type ScopedDraftSettings = {
  scopeKey: string;
  settings: DesktopBillingDraftSettingsResponse;
};

export const scopedDraftSettingsFrom = (
  value: unknown,
): ScopedDraftSettings | null => {
  const parsed = v.safeParse(scopedSettingsSchema, value);
  return parsed.success ? parsed.output : null;
};
