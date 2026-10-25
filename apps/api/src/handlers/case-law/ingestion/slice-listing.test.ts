import { panic, Result } from "better-result";
import { expect, spyOn, test } from "bun:test";

import {
  listReconciliationSlice,
  MAX_SLICE_PAGES,
  SLICE_LISTING_PROOF,
} from "@/api/handlers/case-law/ingestion/slice-listing";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  ReconciliationListingItem,
  ReconciliationSlicePageOptions,
  SourceReconciliation,
} from "@/api/lib/legal-search/ingestion-types";

type ReconciliationListSlicePage = SourceReconciliation["listSlicePage"];

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

test("keys each identity once and counts what it could not key", async () => {
  const sleeps: number[] = [];
  const listing = unwrapListing(
    await listReconciliationSlice({
      adapterKey: "fake",
      proof: SLICE_LISTING_PROOF.IDENTITIES,
      listSlicePage: pagedListing([
        [documentItem("a"), documentItem("b")],
        [
          documentItem("a"),
          { identity: { type: "unidentifiable" }, payload: null },
          documentItem(""),
          documentItem("c"),
        ],
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
  expect(listing.listed).toBe(6);
  expect(listing.duplicate).toBe(1);
  expect(listing.unidentifiable).toBe(2);
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
