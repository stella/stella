import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { skUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-us";
import {
  locateListedPayload,
  recaptureDecisionFromListing,
} from "@/api/handlers/case-law/ingestion/recapture";
import { readGzipJson } from "@/api/lib/gzip-json";
import type {
  ReconciliationListingItem,
  SourceRecapture,
  StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

const FIXTURES = new URL("__fixtures__/", import.meta.url);
const DOWNLOAD = "https://www.ustavnysud.sk/docDownload";

/** The recorded month's search rows, keyed the way the adapter keys them. */
const listedMonth = async (): Promise<ReconciliationListingItem[]> => {
  const page = await readGzipJson(new URL("sk-us-listing.json.gz", FIXTURES));
  const documents = isRecord(page) ? page["documents"] : undefined;
  if (!Array.isArray(documents)) {
    return panic("the recorded listing carries no documents");
  }
  return documents.map((payload) => {
    const documentId = isRecord(payload) ? payload["documentId"] : undefined;
    return {
      identity:
        typeof documentId === "string"
          ? { type: "document", sourceDocumentId: documentId }
          : { type: "unidentifiable" },
      payload,
    };
  });
};

const documentIdOf = (item: ReconciliationListingItem): string =>
  item.identity.type === "document"
    ? item.identity.sourceDocumentId
    : panic("the recorded row states no document id");

/** A row stored as the document file alone, before rows held an id. */
const legacyRow = (
  overrides: Partial<StoredRawReparseInput>,
): StoredRawReparseInput => ({
  raw: new TextEncoder().encode("%PDF-1.7"),
  contentType: "application/pdf",
  caseNumber: "PL. ÚS 11/2021",
  sourceDocumentId: null,
  language: "sk",
  court: "Ústavný súd SR",
  ecli: null,
  decisionDate: "2021-07-29",
  decisionType: null,
  sourceUrl: null,
  documentUrl: null,
  metadata: {},
  ...overrides,
});

const recapture = skUsAdapter.reconciliation.recapture;

/** The real adapter, with its month listing served from the recording. */
const reconciliationServing = (listLookup: SourceRecapture["listLookup"]) => ({
  ...skUsAdapter.reconciliation,
  recapture: { ...recapture, listLookup },
});

describe("a stored sk-us row is located in its month's listing", () => {
  test("the lookup is the month of the stored decision date", () => {
    expect(recapture.lookupOf(legacyRow({}))).toBe("2021-07");
    expect(recapture.lookupOf(legacyRow({ decisionDate: null }))).toBeNull();
  });

  test("a row without an id is matched by the id its download URL names", async () => {
    const [first, second] = await listedMonth();
    if (first === undefined || second === undefined) {
      return panic("the recorded month lists fewer than two rows");
    }
    const stored = legacyRow({
      documentUrl: `${DOWNLOAD}/${documentIdOf(first)}`,
    });

    expect(recapture.matchesStored(first, stored)).toBe(true);
    expect(recapture.matchesStored(second, stored)).toBe(false);
    expect(
      recapture.matchesStored(first, legacyRow({ documentUrl: null })),
    ).toBe(false);
  });

  test("the located payload is the listed row, read as the crawl reads it", async () => {
    const month = await listedMonth();
    const [first] = month;
    if (first === undefined) {
      return panic("the recorded month lists no rows");
    }

    const located = await locateListedPayload({
      reconciliation: reconciliationServing(async ({ slice }) => ({
        items: slice === "2021-07" ? month : [],
        totalPages: 1,
      })),
      stored: legacyRow({ sourceDocumentId: documentIdOf(first) }),
    });

    expect(located).toEqual({
      type: "listed",
      lookup: "2021-07",
      payload: first.payload,
    });
  });

  test("a row whose document file is all it holds is never upgraded from it", async () => {
    const [first] = await listedMonth();
    if (first === undefined) {
      return panic("the recorded month lists no rows");
    }

    expect(recapture.recaptureStoredRaw).toBeUndefined();
    expect(
      await recaptureDecisionFromListing({
        adapter: skUsAdapter,
        stored: legacyRow({ sourceDocumentId: documentIdOf(first) }),
      }),
    ).toEqual({ type: "unsupported" });
  });
});
