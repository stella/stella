import { panic } from "better-result";

import { DAY_IN_MS } from "@stll/time";

import { splitCaseReference } from "@/api/handlers/case-law/case-number";
import type { CzRegionalApiItem } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { documentIdFromLink } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";

/**
 * Day enumeration, identity derivation and the listing diff for the
 * cz-regional reconciliation (`cz-regional-repair.ts`), kept apart from the
 * runnable script so they can be exercised without a database or the
 * publisher's API.
 *
 * The identity helpers come from the adapter rather than being restated
 * here: what counts as this source's document id is one rule, and a second
 * copy of it would let the reconciliation and the crawl disagree about which
 * rows already exist. The adapter is imported for those functions only —
 * nothing in this module performs I/O.
 */

/** The only language this source publishes; half of the fallback identity. */
export const CZ_REGIONAL_LANGUAGE = "cs";

/** First day of the publisher's open-data feed. */
export const CZ_REGIONAL_FEED_START = "2020-10-01";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Midnight UTC on a `YYYY-MM-DD` day, as epoch milliseconds. */
const utcDayStart = (date: string): number =>
  new Date(`${date}T00:00:00.000Z`).getTime();

/** The UTC calendar day a timestamp falls on, as `YYYY-MM-DD`. */
export const toUtcDateString = (date: Date): string =>
  date.toISOString().slice(0, 10);

/**
 * Whether a string names a real UTC calendar day. The round-trip rejects
 * what the shape alone admits (`2026-02-31`, `2026-13-01`), which would
 * otherwise silently walk a different day than the operator asked for.
 */
export const isUtcDateString = (value: string): boolean => {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = utcDayStart(value);
  return !Number.isNaN(parsed) && toUtcDateString(new Date(parsed)) === value;
};

type UtcDayRange = {
  from: string;
  to: string;
};

/**
 * Every UTC day in `[from, to]`, both bounds included. Empty when the range
 * runs backwards. Every UTC day is exactly 24 hours, so the fixed step cannot
 * drift the way a local-calendar walk does across a DST boundary; the
 * publisher's day endpoint is addressed in UTC too.
 */
export const enumerateUtcDays = ({ from, to }: UtcDayRange): string[] => {
  const end = utcDayStart(to);
  const days: string[] = [];
  for (let cursor = utcDayStart(from); cursor <= end; cursor += DAY_IN_MS) {
    days.push(toUtcDateString(new Date(cursor)));
  }
  return days;
};

/**
 * How a listing item would be keyed once stored, mirroring the two halves of
 * the decision identity index: the publisher's document id where the item
 * carries one, the docket otherwise.
 */
export type CzRegionalListingIdentity =
  | { type: "document"; sourceDocumentId: string }
  | { type: "case-number"; caseNumber: string }
  | { type: "unidentifiable" };

/**
 * The identity the ingest would store for this listing item.
 *
 * `unidentifiable` is the item the crawl also drops: without a docket and a
 * court there is nothing to key the decision on, so it can never be held and
 * must not be counted as missing either.
 */
export const czRegionalListingIdentity = (
  item: CzRegionalApiItem,
): CzRegionalListingIdentity => {
  if (!item.jednaciCislo || !item.soud) {
    return { type: "unidentifiable" };
  }
  const sourceDocumentId = documentIdFromLink(item.odkaz ?? undefined);
  if (sourceDocumentId !== undefined) {
    return { type: "document", sourceDocumentId };
  }
  return {
    type: "case-number",
    caseNumber: splitCaseReference(item.jednaciCislo).caseNumber,
  };
};

export type CzRegionalListingKeys = {
  /** Distinct publisher document ids on the page. */
  documentIds: string[];
  /** Distinct dockets on the page, for the fallback half of the identity. */
  caseNumbers: string[];
};

/**
 * The identity values a page has to ask the database about. Distinct, so the
 * lookups stay bounded by the page rather than by its repetitions.
 */
export const czRegionalListingKeys = (
  items: readonly CzRegionalApiItem[],
): CzRegionalListingKeys => {
  const documentIds = new Set<string>();
  const caseNumbers = new Set<string>();
  for (const item of items) {
    const identity = czRegionalListingIdentity(item);
    switch (identity.type) {
      case "document":
        documentIds.add(identity.sourceDocumentId);
        break;
      case "case-number":
        caseNumbers.add(identity.caseNumber);
        break;
      case "unidentifiable":
        break;
      default: {
        const exhaustive: never = identity;
        panic(`Unhandled listing identity: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  return { documentIds: [...documentIds], caseNumbers: [...caseNumbers] };
};

/** What the database already holds for this source, by identity half. */
export type CzRegionalHeldIdentities = {
  documentIds: ReadonlySet<string>;
  /** Dockets of rows stored without a publisher document id. */
  caseNumbers: ReadonlySet<string>;
};

/**
 * Where every item on a listing page stands. The four buckets partition the
 * page: an item lands in exactly one, and their sizes sum to the page's.
 */
export type CzRegionalListingDiff = {
  missing: CzRegionalApiItem[];
  held: CzRegionalApiItem[];
  unidentifiable: CzRegionalApiItem[];
  /** A repeat of an identity already classified on this page. */
  duplicate: CzRegionalApiItem[];
};

type DiffListingInput = {
  items: readonly CzRegionalApiItem[];
  held: CzRegionalHeldIdentities;
};

/**
 * Diff one listing page against the identities already stored.
 *
 * A repeated identity is separated out rather than repeated in `missing`:
 * the publisher lists a document once per docket it settles, and ingesting
 * the same identity twice in one run would have the second observation
 * refresh the first for nothing.
 */
export const diffCzRegionalListing = ({
  items,
  held,
}: DiffListingInput): CzRegionalListingDiff => {
  const diff: CzRegionalListingDiff = {
    missing: [],
    held: [],
    unidentifiable: [],
    duplicate: [],
  };
  const seen = new Set<string>();
  for (const item of items) {
    const identity = czRegionalListingIdentity(item);
    if (identity.type === "unidentifiable") {
      diff.unidentifiable.push(item);
      continue;
    }
    const key =
      identity.type === "document"
        ? `document:${identity.sourceDocumentId}`
        : `case-number:${identity.caseNumber}`;
    if (seen.has(key)) {
      diff.duplicate.push(item);
      continue;
    }
    seen.add(key);
    const isHeld =
      identity.type === "document"
        ? held.documentIds.has(identity.sourceDocumentId)
        : held.caseNumbers.has(identity.caseNumber);
    if (isHeld) {
      diff.held.push(item);
    } else {
      diff.missing.push(item);
    }
  }
  return diff;
};

export type CzRegionalRepairArgs = {
  from: string;
  to: string;
  /** false = walk and diff only; nothing is fetched in full and nothing written. */
  apply: boolean;
  outPath: string;
  /** Process exactly these items instead of walking the listing. */
  itemsFilePath: string | null;
  /**
   * Work items this run: decisions written when applying, missing items
   * recorded when not. null only for an explicitly unbounded pass.
   */
  limit: number | null;
  /** Resume strictly after this UTC day. */
  after: string | null;
  delayMs: number;
  failedOutPath: string;
};

/** One day's reconciliation, as the report records it. */
export type CzRegionalRepairDay = {
  date: string;
  listed: number;
  held: number;
  missing: number;
};

export type CzRegionalRepairReport = {
  generatedAt: string;
  from: string;
  to: string;
  days: CzRegionalRepairDay[];
  /** Raw listing items, so a later run can be fed them with --items-file. */
  missingItems: CzRegionalApiItem[];
};

export type CzRegionalRangeCheck =
  | { type: "valid" }
  | { type: "invalid"; message: string };

type RangeCheckInput = {
  from: string;
  to: string;
  after: string | null;
};

/**
 * Validate the walk's bounds before anything is contacted or leased. A
 * backwards range walks nothing, which would otherwise read as a source with
 * no gaps at all.
 */
export const checkRepairRange = ({
  from,
  to,
  after,
}: RangeCheckInput): CzRegionalRangeCheck => {
  for (const [name, value] of [
    ["--from", from],
    ["--to", to],
    ...(after === null ? [] : [["--after", after] as const]),
  ] as const) {
    if (!isUtcDateString(value)) {
      return {
        type: "invalid",
        message: `${name} must be a UTC date as YYYY-MM-DD, got: ${value}`,
      };
    }
  }
  if (from > to) {
    return {
      type: "invalid",
      message: `--from (${from}) is after --to (${to}); the range covers no days`,
    };
  }
  return { type: "valid" };
};
