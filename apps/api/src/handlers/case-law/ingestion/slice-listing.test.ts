import { panic, Result } from "better-result";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import {
  listReconciliationSlice,
  MAX_SLICE_PAGES,
  SLICE_LISTING_PROOF,
  unstoredRecordCount,
} from "@/api/handlers/case-law/ingestion/slice-listing";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  ReconciliationListingItem,
  ReconciliationSlicePageOptions,
  SourceReconciliation,
} from "@/api/lib/legal-search/ingestion-types";
import {
  LISTING_OBSERVATION_REASON,
  QUARANTINE_NAMESPACE,
  quarantinedListingObservation,
  quarantineIdentity,
} from "@/api/lib/legal-search/quarantine-identity";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

type ReconciliationListSlicePage = SourceReconciliation["listSlicePage"];

const payloadRevision = (payload: unknown): unknown => payload;

const documentItem = (id: string): ReconciliationListingItem => ({
  identity: { type: "document", sourceDocumentId: id },
  payload: { id },
});

const unwrapListing = <T, E>(result: Result<T, E>): T =>
  Result.isError(result)
    ? panic(`expected a listing, got ${String(result.error)}`)
    : result.value;

const pagedListing =
  (pages: ReconciliationListingItem[][]) =>
  async ({ page }: ReconciliationSlicePageOptions) =>
    await Promise.resolve({
      items: pages[page] ?? [],
      totalPages: pages.length,
    });

test("keys each identity once and counts its repeats", async () => {
  const sleeps: number[] = [];
  const listing = unwrapListing(
    await listReconciliationSlice({
      adapterKey: "fake",
      proof: SLICE_LISTING_PROOF.IDENTITIES,
      revisionOf: payloadRevision,
      listSlicePage: pagedListing([
        [documentItem("a"), documentItem("b")],
        [documentItem("a"), documentItem("c")],
      ]),
      pageDelayMs: 1000,
      pageTimeoutMs: 5000,
      slice: "2026-01-01",
      sleep: async (ms) => {
        sleeps.push(ms);
        await Promise.resolve();
      },
    }),
  );

  expect([...listing.keyed.keys()]).toEqual([
    "document:a",
    "document:b",
    "document:c",
  ]);
  expect(listing.listed).toBe(4);
  expect(listing.duplicate).toBe(1);
  // Paced between pages, never before the first; the verification pass is
  // paced the same way, after a pause of its own.
  expect(sleeps).toEqual([1000, 1000, 1000]);
});

test("completed page delays remove their aborted-signal listeners", async () => {
  const controller = new AbortController();
  const addListener = spyOn(controller.signal, "addEventListener");
  const removeListener = spyOn(controller.signal, "removeEventListener");

  unwrapListing(
    await listReconciliationSlice({
      adapterKey: "fake",
      proof: SLICE_LISTING_PROOF.IDENTITIES,
      revisionOf: payloadRevision,
      listSlicePage: pagedListing([[], [], [], []]),
      pageDelayMs: 0,
      pageTimeoutMs: 5000,
      slice: "2026-01-01",
      sleep: async () => {
        await Promise.resolve();
      },
      signal: controller.signal,
    }),
  );

  // Four pages read twice (an empty slice read across several requests is
  // verified): three pauses per pass and one between the passes.
  expect(addListener).toHaveBeenCalledTimes(7);
  expect(removeListener).toHaveBeenCalledTimes(7);
});

test("an empty slice lists nothing after one request", async () => {
  let requests = 0;
  const listing = unwrapListing(
    await listReconciliationSlice({
      adapterKey: "fake",
      proof: SLICE_LISTING_PROOF.IDENTITIES,
      revisionOf: payloadRevision,
      listSlicePage: async () => {
        requests += 1;
        return await Promise.resolve({ items: [], totalPages: 0 });
      },
      pageDelayMs: 0,
      pageTimeoutMs: 5000,
      slice: "2026-01-01",
      sleep: async () => {
        await Promise.resolve();
      },
    }),
  );
  expect(listing.keyed.size).toBe(0);
  expect(requests).toBe(1);
});

test("a listing past the page ceiling is refused, not truncated", async () => {
  let requests = 0;
  const listed = await listReconciliationSlice({
    adapterKey: "fake",
    proof: SLICE_LISTING_PROOF.IDENTITIES,
    revisionOf: payloadRevision,
    listSlicePage: async ({ page }) => {
      requests += 1;
      return await Promise.resolve({
        items: [documentItem(String(page))],
        totalPages: Number.MAX_SAFE_INTEGER,
      });
    },
    pageDelayMs: 0,
    pageTimeoutMs: 5000,
    slice: "2026-01-01",
    sleep: async () => {
      await Promise.resolve();
    },
  });
  expect(Result.isError(listed) ? listed.error : null).toBeInstanceOf(
    AdapterFetchError,
  );
  expect(requests).toBe(MAX_SLICE_PAGES);
});

/**
 * A slice whose listing reads `pages` on the first walk and `after` on every
 * later one: the publisher's state changing between the two.
 */
const changingListing = (
  pages: ReconciliationListingItem[][],
  after: ReconciliationListingItem[][],
) => {
  const requests: number[] = [];
  let walks = 0;
  const listSlicePage = async ({ page }: ReconciliationSlicePageOptions) => {
    requests.push(page);
    const current = walks === 0 ? pages : after;
    if (page + 1 >= current.length) {
      walks += 1;
    }
    return await Promise.resolve({
      items: current[page] ?? [],
      totalPages: current.length,
    });
  };
  return { listSlicePage, requests };
};

const listWith = async (listSlicePage: ReconciliationListSlicePage) =>
  await listReconciliationSlice({
    adapterKey: "fake",
    proof: SLICE_LISTING_PROOF.IDENTITIES,
    revisionOf: payloadRevision,
    listSlicePage,
    pageDelayMs: 0,
    pageTimeoutMs: 5000,
    slice: "2026-01-01",
    sleep: async () => {
      await Promise.resolve();
    },
  });

test("an unchanged slice is listed twice and accepted", async () => {
  const pages = [[documentItem("a"), documentItem("b")], [documentItem("c")]];
  const { listSlicePage, requests } = changingListing(pages, pages);
  const listing = unwrapListing(await listWith(listSlicePage));
  expect([...listing.keyed.keys()]).toEqual([
    "document:a",
    "document:b",
    "document:c",
  ]);
  expect(requests).toEqual([0, 1, 0, 1]);
});

test("a record placed behind a page already read is not certified missing", async () => {
  // The first walk reads a and b, the publisher replaces b with x on the
  // first page, and page two still reads c: three distinct identities, three
  // listed, and x never seen. Only the second walk sees x.
  const { listSlicePage } = changingListing(
    [[documentItem("a"), documentItem("b")], [documentItem("c")]],
    [[documentItem("a"), documentItem("x")], [documentItem("c")]],
  );
  const listed = await listWith(listSlicePage);
  expect(Result.isError(listed) ? listed.error.message : null).toBe(
    "Slice 2026-01-01 changed while it was listed: 3 identities, then 3",
  );
});

test("a record withdrawn between the walks refuses the listing", async () => {
  const { listSlicePage } = changingListing(
    [[documentItem("a"), documentItem("b")]],
    [[documentItem("a")]],
  );
  const listed = await listWith(listSlicePage);
  expect(Result.isError(listed) ? listed.error : null).toBeInstanceOf(
    AdapterFetchError,
  );
});

test("a verification walk that fails fails the listing", async () => {
  let calls = 0;
  const listed = await listWith(async () => {
    calls += 1;
    return await Promise.resolve({
      items: [documentItem("a")],
      totalPages: calls === 1 ? 1 : Number.MAX_SAFE_INTEGER,
    });
  });
  expect(Result.isError(listed) ? listed.error.message : null).toBe(
    `Slice listing exceeded ${String(MAX_SLICE_PAGES)} pages`,
  );
});

test("a count needs no second walk, even of a changed slice", async () => {
  const { listSlicePage, requests } = changingListing(
    [[documentItem("a"), documentItem("b")], [documentItem("c")]],
    [[documentItem("a"), documentItem("x")], [documentItem("c")]],
  );
  const listing = unwrapListing(
    await listReconciliationSlice({
      adapterKey: "fake",
      proof: SLICE_LISTING_PROOF.COUNT,
      revisionOf: payloadRevision,
      listSlicePage,
      pageDelayMs: 0,
      pageTimeoutMs: 5000,
      slice: "2026-01-01",
      sleep: async () => {
        await Promise.resolve();
      },
    }),
  );
  expect(listing.keyed.size).toBe(3);
  expect(requests).toEqual([0, 1]);
});

test("a slice read empty across several requests is verified", async () => {
  // A source that pages a slice by month answers January empty, a January
  // record lands while later months are read, and every later month is
  // empty too: one pass reads nothing, a second pass reads the record.
  const { listSlicePage, requests } = changingListing(
    [[], []],
    [[documentItem("x")], []],
  );
  const listed = await listWith(listSlicePage);
  expect(Result.isError(listed) ? listed.error.message : null).toBe(
    "Slice 2026-01-01 changed while it was listed: 0 identities, then 1",
  );
  expect(requests).toEqual([0, 1, 0, 1]);
});

test("a slice read empty in one request is not walked twice", async () => {
  const { listSlicePage, requests } = changingListing([[]], [[]]);
  const listing = unwrapListing(await listWith(listSlicePage));
  expect(listing.keyed.size).toBe(0);
  expect(requests).toEqual([0]);
});

test("a quarantine id listed for two different records is a counted collision, not a duplicate", async () => {
  // A content-addressed id is only as distinct as the fields it hashes: two
  // records whose stable fields agree share it, and only one row can hold
  // them. Folding the second into `duplicate` would lose it without a trace.
  const { sourceDocumentId } = quarantineIdentity({
    namespace: QUARANTINE_NAMESPACE.CZ_NS,
    stableFields: { docket: "21 Cdo 288/2026" },
  });
  const quarantined = (payload: unknown): ReconciliationListingItem => ({
    identity: { type: "document", sourceDocumentId },
    payload,
  });
  const logs = installRecordingLogger();
  try {
    const listing = unwrapListing(
      await listReconciliationSlice({
        adapterKey: "fake",
        proof: SLICE_LISTING_PROOF.IDENTITIES,
        revisionOf: payloadRevision,
        listSlicePage: async () =>
          await Promise.resolve({
            items: [
              quarantined({ row: "first" }),
              // The same record listed again: a duplicate.
              quarantined({ row: "first" }),
              quarantined({ row: "second" }),
              // A publisher id repeated with another payload is still one
              // document.
              documentItem("a"),
              { ...documentItem("a"), payload: { id: "a", corrected: true } },
            ],
            withoutStableFields: 2,
            totalPages: 1,
          }),
        pageDelayMs: 0,
        pageTimeoutMs: 5000,
        slice: "2026-01-01",
        sleep: async () => {
          await Promise.resolve();
        },
      }),
    );

    expect([...listing.keyed.keys()]).toEqual([
      `document:${sourceDocumentId}`,
      "document:a",
    ]);
    expect(listing.duplicate).toBe(2);
    expect([...listing.quarantineCollisions]).toEqual([[sourceDocumentId, 1]]);
    expect(listing.withoutStableFields).toBe(2);
    expect(listing.listed).toBe(7);
    expect(unstoredRecordCount(listing)).toBe(3);
    // Reported once per verified slice, from the first pass alone.
    const warnings = logs.at("WARN").map(({ message, attributes }) => ({
      message,
      sourceDocumentId: attributes?.["sourceDocumentId"],
      records: attributes?.["collidingRecords"] ?? attributes?.["records"],
    }));
    expect(warnings).toEqual([
      {
        message: "case_law.reconciliation.quarantine_collision",
        sourceDocumentId,
        records: 1,
      },
      {
        message: "case_law.reconciliation.records_without_stable_fields",
        sourceDocumentId: undefined,
        records: 2,
      },
    ]);
  } finally {
    logs.restore();
  }
});

test("a keyed record whose quarantine peer is also listed quarantined is a reported pair", async () => {
  // Two records whose stable fields agree, one keyed and one id-less: a
  // repair alias from the keyed one would merge them, so the walker names
  // the pair. A peer nothing else lists is no collision.
  const peerOf = (docket: string): string =>
    quarantineIdentity({
      namespace: QUARANTINE_NAMESPACE.CZ_NS,
      stableFields: { docket },
    }).sourceDocumentId;
  const shared = peerOf("21 Cdo 288/2026");
  const logs = installRecordingLogger();
  try {
    const listing = unwrapListing(
      await listReconciliationSlice({
        adapterKey: "fake",
        proof: SLICE_LISTING_PROOF.COUNT,
        revisionOf: payloadRevision,
        listSlicePage: async () =>
          await Promise.resolve({
            items: [
              { ...documentItem("a"), quarantinePeers: [shared] },
              {
                ...documentItem("b"),
                quarantinePeers: [peerOf("22 Cdo 1/2026")],
              },
              {
                identity: { type: "document", sourceDocumentId: shared },
                payload: { row: "id-less" },
              },
            ],
            totalPages: 1,
          }),
        pageDelayMs: 0,
        pageTimeoutMs: 5000,
        slice: "2026-01-01",
        sleep: async () => {
          await Promise.resolve();
        },
      }),
    );

    expect(listing.quarantinePeerCollisions).toEqual([shared]);
    expect(listing.keyed.size).toBe(3);
    expect(
      logs
        .at("WARN")
        .filter(
          ({ message }) =>
            message === "case_law.reconciliation.quarantine_peer_collision",
        )
        .map(({ attributes }) => attributes?.["sourceDocumentId"]),
    ).toEqual([shared]);
  } finally {
    logs.restore();
  }
});

test("identity proofs retain noncanonical observations and count only exact repeats", async () => {
  const observation = (payload: unknown) =>
    quarantinedListingObservation({
      source: QUARANTINE_NAMESPACE.SK_US,
      payload,
      reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
    });
  const a = observation({ note: "A" });
  const b = observation({ note: "B" });
  const listing = unwrapListing(
    await listReconciliationSlice({
      adapterKey: "sk-us",
      proof: SLICE_LISTING_PROOF.IDENTITIES,
      revisionOf: payloadRevision,
      listSlicePage: async () => ({
        items: [],
        observations: [a, b, a],
        totalPages: 1,
      }),
      pageDelayMs: 0,
      pageTimeoutMs: 5000,
      slice: "2026-01-01",
      sleep: async () => undefined,
    }),
  );
  expect(listing.keyed.size).toBe(0);
  expect([...listing.observations.values()]).toEqual([a, b]);
  expect(listing.listed).toBe(3);
  expect(listing.duplicate).toBe(1);
  expect(unstoredRecordCount(listing)).toBe(0);
});

test("a changed noncanonical observation invalidates a two-pass identity proof", async () => {
  let pass = 0;
  const listing = await listReconciliationSlice({
    adapterKey: "sk-us",
    proof: SLICE_LISTING_PROOF.IDENTITIES,
    revisionOf: payloadRevision,
    listSlicePage: async () => ({
      items: [],
      observations: [
        quarantinedListingObservation({
          source: QUARANTINE_NAMESPACE.SK_US,
          payload: { revision: ++pass },
          reason: LISTING_OBSERVATION_REASON.NO_USABLE_ID,
        }),
      ],
      totalPages: 1,
    }),
    pageDelayMs: 0,
    pageTimeoutMs: 5000,
    slice: "2026-01-01",
    sleep: async () => undefined,
  });
  expect(listing.isErr()).toBe(true);
});
