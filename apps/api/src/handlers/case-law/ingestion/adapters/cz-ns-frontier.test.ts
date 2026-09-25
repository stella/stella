/**
 * What the steady-state crawl costs rozhodnuti.nsoud.cz once the Domino view
 * is exhausted.
 *
 * The cursor used to park one page back from the end, so every cycle re-listed
 * the same forty entries and spent two detail requests on each of them: 81
 * requests an hour for decisions already held, writing nothing. The view is
 * ordered by document id, so what the court adds lands after the cursor, and
 * parking behind it bought no coverage either.
 *
 * These tests hold the arithmetic rather than the cursor grammar: a cycle with
 * nothing new costs one listing, and a cycle with new entries costs one listing
 * plus the two detail pages each entry is built from.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

/**
 * Where the crawl parked after walking the view to its end. Far enough past
 * the view's page size that the frontier and the page-back cursor this
 * replaced cannot land on the same number.
 */
const PARKED_START = 12_000;

/** A labelled row of a detail page, in the publisher's own markup. */
const detailRow = (label: string, value: string): string =>
  `<tr valign="top"><td class="left-part" width="17%"><b><font face="Times New Roman">${label}:</font></b></td>` +
  `<td class="right-part" width="83%"><b><font face="Times New Roman">${value}</font></b></td></tr>`;

const detailPage = (caseNumber: string): string =>
  `<!DOCTYPE HTML><html><body><table>${[
    detailRow("Soud", "Nejvyšší soud"),
    detailRow("Datum rozhodnutí", "6. 5. 2026"),
    detailRow("Spisová značka", caseNumber),
    detailRow("Typ rozhodnutí", "ROZSUDEK"),
    detailRow("Zveřejněno na webu", "1. 6. 2026"),
  ].join(
    "",
  )}</table><font face="Times New Roman">Nejvyšší soud rozhodl takto: ` +
  `Dovolání se odmítá. Odůvodnění: Dovolatel napadl rozsudek odvolacího soudu.` +
  `</font></body></html>`;

/** One Domino view entry, as `ReadViewEntries` serialises it. */
const viewEntry = (index: number) => ({
  "@position": String(PARKED_START + index),
  "@unid": `0000000000000000000000000000${String(index).padStart(4, "0")}`,
  entrydata: [
    {
      "@name": "znacka",
      text: { "0": `30 Cdo ${3000 + index}/2026` },
    },
  ],
});

type Recorded = { listings: URL[]; details: URL[] };

/** The view holds `PARKED_START - 1` entries and serves `entries` from there. */
const stubPublisher = (entries: number): Recorded => {
  const recorded: Recorded = { listings: [], details: [] };

  globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    // The listing and the per-decision detail page share a path segment; only
    // the listing carries the view's own query.
    if (url.searchParams.has("ReadViewEntries")) {
      recorded.listings.push(url);
      return await Promise.resolve(
        new Response(
          JSON.stringify({
            "@toplevelentries": String(PARKED_START - 1 + entries),
            viewentry: Array.from({ length: entries }, (_, index) =>
              viewEntry(index),
            ),
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    recorded.details.push(url);
    // The print page is the AST's source and is treated as enrichment; a
    // decision built without one still costs the request that asked for it,
    // which is what this file counts.
    return await Promise.resolve(
      url.pathname.includes("/WebPrint/")
        ? new Response("", { status: 404 })
        : new Response(detailPage("30 Cdo 3000/2026"), {
            headers: { "Content-Type": "text/html" },
          }),
    );
  });

  return recorded;
};

const fetchPageAt = async (cursor: string | null) => {
  const result = await czNsAdapter.fetchPage(cursor, {});
  if (result.isErr()) {
    throw result.error;
  }
  return result.unwrap();
};

/** The page size the adapter asked the view for, read off its own request. */
const requestedCount = (listing: URL | undefined): number =>
  Number.parseInt(listing?.searchParams.get("Count") ?? "", 10);

describe("the cz-ns steady-state frontier", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("a cycle the view added nothing to costs one listing", async () => {
    const recorded = stubPublisher(0);

    const page = await fetchPageAt(String(PARKED_START));

    expect(recorded.listings).toHaveLength(1);
    expect(recorded.listings.at(0)?.searchParams.get("Start")).toBe(
      String(PARKED_START),
    );
    expect(recorded.details).toHaveLength(0);
    expect(page.decisions).toHaveLength(0);
    expect(page.nextCursor).toBe(String(PARKED_START));
  });

  test("a cycle with two new entries costs one listing and two detail pages each", async () => {
    const ENTRIES = 2;
    const recorded = stubPublisher(ENTRIES);

    const page = await fetchPageAt(String(PARKED_START));

    expect(recorded.listings).toHaveLength(1);
    // The web page and the print page are one decision's worth of work.
    expect(recorded.details).toHaveLength(2 * ENTRIES);
    expect(
      recorded.details.filter(({ pathname }) =>
        pathname.includes("/WebPrint/"),
      ),
    ).toHaveLength(ENTRIES);
    expect(page.decisions).toHaveLength(ENTRIES);
    expect(page.nextCursor).toBe(String(PARKED_START + ENTRIES));
  });

  test("the cursor stops where the view stopped, not a page behind it", async () => {
    const ENTRIES = 2;
    const recorded = stubPublisher(ENTRIES);

    const page = await fetchPageAt(String(PARKED_START));

    const pageSize = requestedCount(recorded.listings.at(0));
    // Without this the two candidate cursors coincide and the assertion below
    // holds for a crawl that re-reads its last page every cycle.
    expect(PARKED_START + ENTRIES).toBeGreaterThan(pageSize);
    expect(page.nextCursor).toBe(String(PARKED_START + ENTRIES));
    expect(page.nextCursor).not.toBe(
      String(Math.max(1, PARKED_START + ENTRIES - pageSize)),
    );
  });

  test("the cycle after a collection stands still instead of re-listing it", async () => {
    const collecting = stubPublisher(2);
    const first = await fetchPageAt(String(PARKED_START));
    expect(collecting.details).toHaveLength(4);

    const quiet = stubPublisher(0);
    const second = await fetchPageAt(first.nextCursor);

    // The two decisions are paid for once; the next cycle spends one listing
    // request to learn there is nothing behind them.
    expect(quiet.listings).toHaveLength(1);
    expect(quiet.details).toHaveLength(0);
    expect(second.decisions).toHaveLength(0);
    expect(second.nextCursor).toBe(first.nextCursor);
  });
});

describe("the cz-ns crawl over an entry whose detail read times out", () => {
  const originalFetch = globalThis.fetch;
  let recording: RecordingLogger;

  beforeEach(() => {
    recording = installRecordingLogger();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    recording.restore();
  });

  test("records an entry whose detail read times out", async () => {
    stubPublisher(2);
    const served = globalThis.fetch;
    const timedOut = viewEntry(0)["@unid"];
    globalThis.fetch = asFetchMock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (url.pathname.endsWith(`/WebSearch/${timedOut}`)) {
          return await Promise.reject(
            new DOMException("request timed out", "TimeoutError"),
          );
        }
        return await served(input, init);
      },
    );

    const page = await fetchPageAt(String(PARKED_START));

    // The entry is not stored, so its identity is not held and the
    // reconciliation's walk of its day builds it; the failed read is on record.
    expect(page.decisions).toHaveLength(1);
    expect(
      recording
        .at("WARN")
        .filter(
          (record) =>
            record.message === "case_law.ingestion.detail_fetch_failed",
        )
        .map((record) => record.attributes),
    ).toEqual([
      expect.objectContaining({
        documentId: timedOut,
        "failure.grade": "transient",
      }),
    ]);
  });
});
