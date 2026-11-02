import * as v from "valibot";

import {
  DESKTOP_BILLING_DRAFT_LIMITS,
  desktopBillingDraftReviewSchema,
  desktopBillingDraftSettingsResponseSchema,
} from "@stll/api-contract/desktop-billing-drafts";
import type {
  DesktopBillingDraftRequest,
  DesktopBillingDraftReview,
  DesktopBillingDraftSettingsResponse,
} from "@stll/api-contract/desktop-billing-drafts";
import type { DesktopTimeEntryClassification } from "@stll/api-contract/desktop-time-entries";

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
 * the file and section it cites. */
type GuidelineFlag = { text: string; fileName: string; section: string };

/** What a card shows from a review: its description, the earlier entries the
 * draft followed and, from a guided draft, the entry's classification and
 * the guideline notes. */
export type CardDraft = {
  narrative: string;
  earlierEntries: DesktopBillingDraftReview["earlierEntries"];
  classification: DesktopTimeEntryClassification | null;
  flags: GuidelineFlag[];
};

/** The card's draft from a server review, or `null` when the answer does not
 * hold the contract or names no draft for the card's entry. */
export const cardDraftFrom = (value: unknown): CardDraft | null => {
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
          flags: [],
        };
  }
  const draft = result.drafts.find(
    ({ entryId }) => entryId === CARD_DRAFT_ENTRY_ID,
  );
  if (draft === undefined) {
    return null;
  }
  return {
    narrative: draft.narrative,
    earlierEntries: followed(draft.matchedEarlierEntryIds),
    classification: draft.classification,
    flags: draft.flags.map(({ text, ruleRef }) => ({
      text,
      fileName: ruleRef.fileName,
      section: ruleRef.section,
    })),
  };
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
