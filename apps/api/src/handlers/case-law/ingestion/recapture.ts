/**
 * Upgrade one stored row whose payload predates a response the adapter now
 * keeps, from what the publisher lists for it, and rebuild it.
 *
 * The row is looked up with what its stored payload names (a slice, or a
 * narrower query where the publisher cannot serve the slice whole), through
 * the adapter's own listing reader, matched by the adapter's own rule,
 * upgraded by the adapter's `recapture.recaptureStoredRaw` and rebuilt by its
 * `reparseStoredRaw`. The envelope and the decision keep their single
 * builders, so a recaptured row is the row a crawl would store today.
 *
 * Nothing is written here. The caller writes the result through
 * `processDecision` under the source's ingestion lease, as every writer does,
 * and owns the schedule, budget and politeness of the requests it causes.
 */
import { panic, Result } from "better-result";

import type {
  IngestionResult,
  SourceAdapter,
  SourceRecapture,
  SourceReconciliation,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/lib/legal-search/ingestion-types";

type ReparseRefusal = Exclude<StoredRawReparseOutcome, { type: "parsed" }>;

export type RecaptureDecisionOutcome =
  | {
      type: "recaptured";
      lookup: string;
      result: IngestionResult;
      /** As `StoredRawReparseOutcome`: an older spelling of the row's docket. */
      legacyCaseNumber?: string | undefined;
    }
  /** The adapter declares no recapture, or no stored-raw replay. */
  | { type: "unsupported" }
  /** The stored row names nothing to ask the publisher for. */
  | { type: "no-lookup" }
  | { type: "not-listed"; lookup: string }
  | { type: "listing-unavailable"; lookup: string; error: unknown }
  /** Reported, never written: the listing and the row disagree, or several items match. */
  | { type: "identity-mismatch"; lookup: string; detail: string }
  | { type: "not-recapturable"; lookup: string; detail: string }
  | { type: "reparse-refused"; lookup: string; outcome: ReparseRefusal };

type FindListedPayloadOptions = {
  recapture: SourceRecapture;
  lookup: string;
  stored: StoredRawReparseInput;
  signal?: AbortSignal | undefined;
};

type FindListedPayloadResult =
  | { type: "listed"; payload: unknown }
  | { type: "not-listed" }
  | { type: "ambiguous"; count: number }
  | { type: "unavailable"; error: unknown };

const findListedPayload = async ({
  recapture,
  lookup,
  stored,
  signal,
}: FindListedPayloadOptions): Promise<FindListedPayloadResult> => {
  const matches: unknown[] = [];
  for (let page = 0; ; page += 1) {
    // Pages are read in order; a lookup is a few pages at most.
    const listed = await Result.tryPromise(
      async () => await recapture.listLookup({ slice: lookup, page, signal }),
    );
    if (listed.isErr()) {
      return { type: "unavailable", error: listed.error };
    }
    for (const item of listed.value.items) {
      if (recapture.matchesStored(item, stored)) {
        matches.push(item.payload);
      }
    }
    if (page + 1 >= listed.value.totalPages) {
      break;
    }
  }
  const [only, ...others] = matches;
  if (only === undefined) {
    return { type: "not-listed" };
  }
  return others.length === 0
    ? { type: "listed", payload: only }
    : { type: "ambiguous", count: matches.length };
};

/** The two adapter capabilities a recapture uses. */
type RecaptureAdapter = {
  reconciliation: SourceReconciliation;
  reparseStoredRaw?: SourceAdapter["reparseStoredRaw"] | undefined;
};

type RecaptureDecisionOptions = {
  adapter: RecaptureAdapter;
  stored: StoredRawReparseInput;
  signal?: AbortSignal | undefined;
};

export type LocateListedPayloadOutcome =
  | { type: "listed"; lookup: string; payload: unknown }
  /** The adapter declares no recapture. */
  | { type: "unsupported" }
  /** The stored row names nothing to ask the publisher for. */
  | { type: "no-lookup" }
  | { type: "not-listed"; lookup: string }
  | { type: "listing-unavailable"; lookup: string; error: unknown }
  /** Several listed items match the row; none is chosen. */
  | { type: "identity-mismatch"; lookup: string; detail: string };

type LocateListedPayloadOptions = {
  reconciliation: SourceReconciliation;
  stored: StoredRawReparseInput;
  signal?: AbortSignal | undefined;
};

/**
 * The listing item the publisher serves for a stored row, as the crawl would
 * have read it. What a caller does with it is the caller's: upgrade the held
 * payload where the adapter can (`recaptureDecisionFromListing`), or replay
 * it through `reconciliation.buildDecision` where only a fresh read builds
 * the row.
 */
export const locateListedPayload = async ({
  reconciliation,
  stored,
  signal,
}: LocateListedPayloadOptions): Promise<LocateListedPayloadOutcome> => {
  const { recapture } = reconciliation;
  if (recapture === undefined) {
    return { type: "unsupported" };
  }
  const lookup = recapture.lookupOf(stored);
  if (lookup === null) {
    return { type: "no-lookup" };
  }
  const listed = await findListedPayload({ recapture, lookup, stored, signal });
  switch (listed.type) {
    case "listed":
      return { type: "listed", lookup, payload: listed.payload };
    case "not-listed":
      return { type: "not-listed", lookup };
    case "ambiguous":
      return {
        type: "identity-mismatch",
        lookup,
        detail: `${listed.count} listed items match the row`,
      };
    case "unavailable":
      return { type: "listing-unavailable", lookup, error: listed.error };
    default:
      listed satisfies never;
      return panic("Unhandled listed-payload result");
  }
};

export const recaptureDecisionFromListing = async ({
  adapter,
  stored,
  signal,
}: RecaptureDecisionOptions): Promise<RecaptureDecisionOutcome> => {
  const { reconciliation, reparseStoredRaw } = adapter;
  const recaptureStoredRaw = reconciliation.recapture?.recaptureStoredRaw;
  if (recaptureStoredRaw === undefined || reparseStoredRaw === undefined) {
    return { type: "unsupported" };
  }
  const located = await locateListedPayload({
    reconciliation,
    stored,
    signal,
  });
  if (located.type !== "listed") {
    return located;
  }
  const { lookup } = located;
  const recaptured = recaptureStoredRaw({
    listingPayload: located.payload,
    stored,
  });
  switch (recaptured.type) {
    case "recaptured":
      break;
    case "identity-mismatch":
    case "not-recapturable":
      return { type: recaptured.type, lookup, detail: recaptured.detail };
    default:
      recaptured satisfies never;
      return panic("Unhandled recapture outcome");
  }
  const reparsed = await reparseStoredRaw({
    ...stored,
    raw: new TextEncoder().encode(recaptured.raw),
    contentType: recaptured.contentType,
  });
  return reparsed.type === "parsed"
    ? {
        type: "recaptured",
        lookup,
        result: reparsed.result,
        legacyCaseNumber: reparsed.legacyCaseNumber,
      }
    : { type: "reparse-refused", lookup, outcome: reparsed };
};
