import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  assembleCzRegionalDecision,
  czRegionalAdapter,
  czRegionalListingIdentity,
  isCzRegionalApiItem,
  readCzRegionalDocument,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import { recaptureDecisionFromListing } from "@/api/handlers/case-law/ingestion/recapture";
import type {
  IngestionResult,
  ReconciliationSlicePage,
  ReconciliationSlicePageOptions,
  StoredRawReparseInput,
} from "@/api/lib/legal-search/ingestion-types";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/lib/legal-search/ingestion-types";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const FIXTURES = new URL("adapters/__fixtures__/", import.meta.url);

const readFixture = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

const LISTING = "cz-regional-listing.json.gz";
const DISTRICT_DOCUMENT = "cz-regional-finaldoc-district.json.gz";
const DISTRICT_DOCKET = "18 C 130/2024-27";
const PUBLICATION_DAY = "2025-06-11";

/** The recorded day page's rows, verbatim. */
const listingRows = async (): Promise<readonly unknown[]> => {
  const page = JSON.parse(await readFixture(LISTING));
  const items = isRecord(page) ? page["items"] : undefined;
  return isUnknownArray(items) ? items : panic("the listing holds no rows");
};

/** The recorded day served as two pages, so a lookup has to page. */
const servedDay =
  (rows: readonly unknown[]) =>
  async ({
    slice,
    page,
  }: ReconciliationSlicePageOptions): Promise<ReconciliationSlicePage> => {
    if (slice !== PUBLICATION_DAY) {
      return { items: [], totalPages: 0 };
    }
    const half = Math.ceil(rows.length / 2);
    const pageRows = page === 0 ? rows.slice(0, half) : rows.slice(half);
    return {
      items: pageRows.map((payload) => ({
        identity: czRegionalListingIdentity(payload),
        payload,
      })),
      totalPages: 2,
    };
  };

const crawledDistrict = async (
  rows: readonly unknown[],
): Promise<IngestionResult> => {
  const item =
    rows
      .filter(isCzRegionalApiItem)
      .find((candidate) => candidate.jednaciCislo === DISTRICT_DOCKET) ??
    panic("the listing lists no district row");
  const built = assembleCzRegionalDecision({
    item,
    document: readCzRegionalDocument(await readFixture(DISTRICT_DOCUMENT)),
    chain: null,
  });
  return built.type === "built" ? built.decision : panic(built.type);
};

const documentOnlyRow = async (
  decision: IngestionResult,
): Promise<StoredRawReparseInput> => ({
  raw: new TextEncoder().encode(await readFixture(DISTRICT_DOCUMENT)),
  contentType: "application/json",
  caseNumber: decision.caseNumber,
  sourceDocumentId: decision.sourceDocumentId ?? null,
  language: decision.language,
  court: decision.court,
  ecli: decision.ecli ?? null,
  decisionDate: decision.decisionDate ?? null,
  decisionType: decision.decisionType ?? null,
  sourceUrl: decision.sourceUrl ?? null,
  documentUrl: decision.documentUrl ?? null,
  metadata: {},
});

const adapterServing = (
  listSlicePage: typeof czRegionalAdapter.reconciliation.listSlicePage,
) => ({
  reconciliation: { ...czRegionalAdapter.reconciliation, listSlicePage },
  reparseStoredRaw: czRegionalAdapter.reparseStoredRaw,
});

describe("recaptureDecisionFromListing", () => {
  test("finds the row on its day, upgrades it and rebuilds the crawled decision", async () => {
    const rows = await listingRows();
    const crawled = await crawledDistrict(rows);

    const outcome = await recaptureDecisionFromListing({
      adapter: adapterServing(servedDay(rows)),
      stored: await documentOnlyRow(crawled),
    });

    expect(outcome).toMatchObject({
      type: "recaptured",
      slice: PUBLICATION_DAY,
      result: { sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE },
    });
    const result =
      outcome.type === "recaptured" ? outcome.result : panic(outcome.type);
    expect(result).toEqual(crawled);
  });

  test("a row its day no longer lists is reported as not listed", async () => {
    const rows = await listingRows();
    const crawled = await crawledDistrict(rows);
    const others = rows.filter(
      (row) => !isRecord(row) || row["jednaciCislo"] !== DISTRICT_DOCKET,
    );

    expect(
      await recaptureDecisionFromListing({
        adapter: adapterServing(servedDay(others)),
        stored: await documentOnlyRow(crawled),
      }),
    ).toEqual({ type: "not-listed", slice: PUBLICATION_DAY });
  });

  test("an unreadable listing is reported with the slice, not as absent", async () => {
    const crawled = await crawledDistrict(await listingRows());
    const failure = new Error("listing unavailable");

    const outcome = await recaptureDecisionFromListing({
      adapter: adapterServing(async () => {
        throw failure;
      }),
      stored: await documentOnlyRow(crawled),
    });

    expect(outcome).toMatchObject({
      type: "listing-unavailable",
      slice: PUBLICATION_DAY,
    });
  });

  test("a row that keeps its listing names no slice and makes no request", async () => {
    const crawled = await crawledDistrict(await listingRows());
    let requests = 0;

    const outcome = await recaptureDecisionFromListing({
      adapter: adapterServing(async () => {
        requests += 1;
        return { items: [], totalPages: 0 };
      }),
      stored: {
        ...(await documentOnlyRow(crawled)),
        raw: new TextEncoder().encode(crawled.sourceRaw ?? ""),
        contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      },
    });

    expect(outcome).toEqual({ type: "no-slice" });
    expect(requests).toBe(0);
  });

  test("an adapter that declares no recapture is unsupported", async () => {
    const crawled = await crawledDistrict(await listingRows());
    const { recapture: _declared, ...reconciliation } =
      czRegionalAdapter.reconciliation;

    expect(
      await recaptureDecisionFromListing({
        adapter: {
          reconciliation,
          reparseStoredRaw: czRegionalAdapter.reparseStoredRaw,
        },
        stored: await documentOnlyRow(crawled),
      }),
    ).toEqual({ type: "unsupported" });
  });
});
