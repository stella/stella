import { expect, test } from "bun:test";

import {
  listReconciliationSlice,
  MAX_SLICE_PAGES,
} from "@/api/handlers/case-law/ingestion/slice-listing";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  ReconciliationListingItem,
  ReconciliationSlicePageOptions,
} from "@/api/lib/legal-search/ingestion-types";

const documentItem = (id: string): ReconciliationListingItem => ({
  identity: { type: "document", sourceDocumentId: id },
  payload: { id },
});

const pagedListing =
  (pages: ReconciliationListingItem[][]) =>
  async ({ page }: ReconciliationSlicePageOptions) =>
    await Promise.resolve({
      items: pages[page] ?? [],
      totalPages: pages.length,
    });

test("keys each identity once and counts what it could not key", async () => {
  const sleeps: number[] = [];
  const listing = await listReconciliationSlice({
    adapterKey: "fake",
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
  });

  expect([...listing.keyed.keys()]).toEqual([
    "document:a",
    "document:b",
    "document:c",
  ]);
  expect(listing.listed).toBe(6);
  expect(listing.duplicate).toBe(1);
  expect(listing.unidentifiable).toBe(2);
  // Paced between pages, never before the first.
  expect(sleeps).toEqual([1000]);
});

test("an empty slice lists nothing after one request", async () => {
  let requests = 0;
  const listing = await listReconciliationSlice({
    adapterKey: "fake",
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
  });
  expect(listing.keyed.size).toBe(0);
  expect(requests).toBe(1);
});

test("a listing past the page ceiling is refused, not truncated", async () => {
  let requests = 0;
  const listed = listReconciliationSlice({
    adapterKey: "fake",
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
  const refusal = await listed.then(
    () => null,
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(AdapterFetchError);
  expect(requests).toBe(MAX_SLICE_PAGES);
});
