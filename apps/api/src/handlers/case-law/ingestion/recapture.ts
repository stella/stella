/**
 * Upgrade one stored row whose payload predates a response the adapter now
 * keeps, from the publisher's own slice listing, and rebuild it.
 *
 * The row is looked up in the slice its stored payload names, through the
 * adapter's `listSlicePage` (the requests, retries and validation the
 * reconciliation walk uses), matched by the identity rule every ingest path
 * keys rows by, upgraded by the adapter's `recapture.recaptureStoredRaw` and
 * rebuilt by its `reparseStoredRaw`. The envelope and the decision keep their
 * single builders, so a recaptured row is the row a crawl would store today.
 *
 * Nothing is written here. The caller writes the result through
 * `processDecision` under the source's ingestion lease, as every writer does,
 * and owns the schedule, budget and politeness of the requests it causes.
 */
import { panic, Result } from "better-result";

import type {
  IngestionResult,
  ListingIdentity,
  SourceAdapter,
  SourceReconciliation,
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/lib/legal-search/ingestion-types";
import { listingIdentityKey } from "@/api/lib/legal-search/ingestion-types";

type ReparseRefusal = Exclude<StoredRawReparseOutcome, { type: "parsed" }>;

export type RecaptureDecisionOutcome =
  | {
      type: "recaptured";
      slice: string;
      result: IngestionResult;
      /** As `StoredRawReparseOutcome`: an older spelling of the row's docket. */
      legacyCaseNumber?: string | undefined;
    }
  /** The adapter declares no recapture, or no stored-raw replay. */
  | { type: "unsupported" }
  /** The stored payload names no slice to look the row up in. */
  | { type: "no-slice" }
  /** The row has no identity a listing could be matched against. */
  | { type: "unkeyable" }
  | { type: "not-listed"; slice: string }
  | { type: "listing-unavailable"; slice: string; error: unknown }
  | { type: "identity-mismatch"; slice: string; detail: string }
  | { type: "not-recapturable"; slice: string; detail: string }
  | { type: "reparse-refused"; slice: string; outcome: ReparseRefusal };

/**
 * How the ingest keyed the stored row: by the publisher's document id where it
 * holds one, by docket otherwise, as `ListingIdentity` defines both.
 */
const storedListingIdentity = (
  stored: StoredRawReparseInput,
): ListingIdentity =>
  stored.sourceDocumentId === null
    ? {
        type: "case-number",
        caseNumber: stored.caseNumber,
        language: stored.language,
      }
    : { type: "document", sourceDocumentId: stored.sourceDocumentId };

type FindListedPayloadOptions = {
  listSlicePage: SourceReconciliation["listSlicePage"];
  slice: string;
  identityKey: string;
  signal?: AbortSignal | undefined;
};

type FindListedPayloadResult =
  | { type: "listed"; payload: unknown }
  | { type: "not-listed" }
  | { type: "unavailable"; error: unknown };

const findListedPayload = async ({
  listSlicePage,
  slice,
  identityKey,
  signal,
}: FindListedPayloadOptions): Promise<FindListedPayloadResult> => {
  for (let page = 0; ; page += 1) {
    // Pages are read in order so the walk stops at the first one listing the
    // row; a slice is at most a few pages.
    const listed = await Result.tryPromise(
      async () => await listSlicePage({ slice, page, signal }),
    );
    if (listed.isErr()) {
      return { type: "unavailable", error: listed.error };
    }
    const item = listed.value.items.find(
      ({ identity }) => listingIdentityKey(identity) === identityKey,
    );
    if (item !== undefined) {
      return { type: "listed", payload: item.payload };
    }
    if (page + 1 >= listed.value.totalPages) {
      return { type: "not-listed" };
    }
  }
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

export const recaptureDecisionFromListing = async ({
  adapter,
  stored,
  signal,
}: RecaptureDecisionOptions): Promise<RecaptureDecisionOutcome> => {
  const { reconciliation, reparseStoredRaw } = adapter;
  const { recapture } = reconciliation;
  if (recapture === undefined || reparseStoredRaw === undefined) {
    return { type: "unsupported" };
  }
  const slice = recapture.sliceOf(stored);
  if (slice === null) {
    return { type: "no-slice" };
  }
  const identityKey = listingIdentityKey(storedListingIdentity(stored));
  if (identityKey === null) {
    return { type: "unkeyable" };
  }
  const listed = await findListedPayload({
    listSlicePage: reconciliation.listSlicePage,
    slice,
    identityKey,
    signal,
  });
  switch (listed.type) {
    case "listed":
      break;
    case "not-listed":
      return { type: "not-listed", slice };
    case "unavailable":
      return { type: "listing-unavailable", slice, error: listed.error };
    default:
      listed satisfies never;
      return panic("Unhandled listed-payload result");
  }
  const recaptured = recapture.recaptureStoredRaw({
    listingPayload: listed.payload,
    stored,
  });
  switch (recaptured.type) {
    case "recaptured":
      break;
    case "identity-mismatch":
    case "not-recapturable":
      return { type: recaptured.type, slice, detail: recaptured.detail };
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
        slice,
        result: reparsed.result,
        legacyCaseNumber: reparsed.legacyCaseNumber,
      }
    : { type: "reparse-refused", slice, outcome: reparsed };
};
