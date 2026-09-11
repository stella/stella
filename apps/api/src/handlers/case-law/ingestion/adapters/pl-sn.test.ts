/**
 * pl-sn against payloads sn.pl actually served.
 *
 * The listing fixture is one decision date captured verbatim; the page
 * fixture is a first `fetchPage` recorded end to end, envelope and all. Both
 * carry a provenance sidecar, so an edit to either fails the capture suite
 * rather than quietly changing what these assertions are about.
 */

import { panic, Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";

import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  encodePlSnCursor,
  normalizePlSnListingItem,
  parsePlSnCursor,
  plSnAdapter,
  plSnDecidingCourt,
  plSnDecisionType,
  plSnListingIdentity,
  readPlSnEnvelope,
} from "@/api/handlers/case-law/ingestion/adapters/pl-sn";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

type PlSnListingRow = Record<string, unknown>;

const listingRows = async (): Promise<PlSnListingRow[]> => {
  const raw = await Bun.file(
    new URL("pl-sn-listing-2025-06-11.json", FIXTURES_DIR),
  ).text();
  const parsed: unknown = JSON.parse(raw);
  const payload = readPlSnEnvelope(parsed);
  if (!Array.isArray(payload)) {
    throw new TypeError("the captured listing holds no rows");
  }
  const rows: unknown[] = payload;
  return rows.filter(isRecord);
};

type RecordedPage = {
  page: { decisions: IngestionResult[]; nextCursor: string | null };
};

const recordedDecision = async (): Promise<IngestionResult> => {
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- committed fixture JSON, recorded by update-fixtures.ts from this adapter's own SyncPage
  const record = (await readGzipJson(
    new URL("pl-sn-page.json.gz", FIXTURES_DIR),
  )) as RecordedPage;
  const [decision] = record.page.decisions;
  if (decision === undefined) {
    throw new TypeError("the recorded page holds no decision");
  }
  return decision;
};

const envelope = (payload: unknown): string =>
  JSON.stringify({ success: true, data: [{ success: true, data: payload }] });

const jsonResponse = (body: string): Response =>
  new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

// ── The proxy's envelope ─────────────────────────────────

describe("reading the proxy's two envelopes", () => {
  test("a listing answer unwraps to its rows", async () => {
    const rows = await listingRows();
    expect(rows).toHaveLength(83);
  });

  test("the rate-limit answer is not a payload", () => {
    // The proxy dresses the upstream's 429 as a token error, at HTTP 200 and
    // with `data` an object rather than the usual array. Read as a payload it
    // would be a slice with nothing in it.
    expect(
      readPlSnEnvelope({
        success: true,
        message: 401,
        data: { error: "Brak tokenu", debug: { json_status: 429 } },
      }),
    ).toBeNull();
  });

  test("an answer with no inner envelope is not a payload", () => {
    expect(
      readPlSnEnvelope({ success: true, data: [{ success: false }] }),
    ).toBeNull();
    expect(readPlSnEnvelope("nothing of the kind")).toBeNull();
  });
});

// ── Identity and dockets ─────────────────────────────────

describe("Supreme Court dockets", () => {
  test("every docket the publisher listed parses as a Polish case number", async () => {
    const rows = await listingRows();
    const unparsed = rows
      .map((row) => normalizePlSnListingItem(row).sygnatura_sprawy ?? "")
      .filter((docket) => DECISION_DOCKET_GRAMMARS.POL.parse(docket) === null);

    expect(unparsed).toEqual([]);
  });

  test("the 2021 re-lettering leaves both spellings resolvable and distinct", async () => {
    // The court re-lettered its chambers in 2021 (CSK→CSKP, PK→PSK, UK→USK),
    // so both forms are in circulation and a citation of either has to reach
    // its own decision. The captured date holds both.
    const rows = await listingRows();
    const letters = new Set(
      rows.map(
        (row) =>
          normalizePlSnListingItem(row).sygnatura_sprawy?.split(" ")[1] ?? "",
      ),
    );
    expect(letters).toContain("CSK");
    expect(letters).toContain("CSKP");

    const canonical = (docket: string): string | undefined =>
      DECISION_DOCKET_GRAMMARS.POL.parse(docket)?.canonical;

    expect(canonical("I CSK 3071/24")).toBeDefined();
    expect(canonical("I CSKP 3071/24")).toBeDefined();
    expect(canonical("I CSK 3071/24")).not.toBe(canonical("I CSKP 3071/24"));
    expect(canonical("II PK 40/21")).not.toBe(canonical("II PSK 40/21"));
    expect(canonical("II UK 40/21")).not.toBe(canonical("II USK 40/21"));
  });

  test("a row is keyed by the publisher's document id, not by its docket", async () => {
    const rows = await listingRows();
    const identities = rows.map((row) =>
      plSnListingIdentity(normalizePlSnListingItem(row)),
    );

    expect(identities.every(({ type }) => type === "document")).toBe(true);
  });

  test("a row with no id falls back to its docket, and one with neither is unidentifiable", () => {
    expect(plSnListingIdentity({ sygnatura_sprawy: "I CSK 1/26" })).toEqual({
      type: "case-number",
      caseNumber: "I CSK 1/26",
      language: "pl",
    });
    expect(plSnListingIdentity({})).toEqual({ type: "unidentifiable" });
  });
});

// ── Decision form ────────────────────────────────────────

describe("reading the decision form", () => {
  test("the type is the form's own leading word, in Polish", () => {
    expect(plSnDecisionType("wyrok SN")).toBe("wyrok");
    expect(plSnDecisionType("uchwała siedmiu sędziów SN zasada prawna")).toBe(
      "uchwała",
    );
    expect(plSnDecisionType("postanowienie całej Izby SN")).toBe(
      "postanowienie",
    );
    expect(plSnDecisionType("wyciąg z protokołu")).toBe("wyciąg z protokołu");
  });

  test("a form outside the publisher's vocabulary yields no type", () => {
    expect(plSnDecisionType("komunikat prasowy")).toBeUndefined();
  });

  test("the court comes off the bench the form names", () => {
    expect(plSnDecidingCourt("wyrok SN")).toBe("Sąd Najwyższy");
    // The disciplinary bench is a composition of the same court.
    expect(plSnDecidingCourt("postanowienie SN SD")).toBe("Sąd Najwyższy");
  });
});

// ── Cursor ───────────────────────────────────────────────

describe("the crawl cursor", () => {
  test("round-trips a month and an offset", () => {
    expect(parsePlSnCursor("2020-03:140")).toEqual({
      month: "2020-03",
      offset: 140,
    });
    expect(encodePlSnCursor({ month: "2020-03", offset: 140 })).toBe(
      "2020-03:140",
    );
  });

  test("a cursor nothing wrote restarts at the first month the source serves", () => {
    // Never at null and never at the tip: a shape this adapter does not
    // recognise has to resume the sweep, not skip what it has not walked.
    for (const cursor of [null, "", "offset:900", "2020-13:0", "2020-03:-1"]) {
      expect(parsePlSnCursor(cursor)).toEqual({ month: "1993-06", offset: 0 });
    }
  });
});

// ── Slice listing ────────────────────────────────────────

describe("listing one decision date", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = async () => {
      // The publisher gate paces against a live court; nothing here is live.
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  const answerWith = (body: (url: URL) => Response): void => {
    globalThis.fetch = asFetchMock(
      async (input: string | URL | Request) =>
        await Promise.resolve(
          body(new URL(input instanceof Request ? input.url : String(input))),
        ),
    );
  };

  test("the captured date lists every row it holds, and ends there", async () => {
    const raw = await Bun.file(
      new URL("pl-sn-listing-2025-06-11.json", FIXTURES_DIR),
    ).text();
    answerWith(() => jsonResponse(raw));

    const page = await plSnAdapter.reconciliation.listSlicePage({
      slice: "2025-06-11",
      page: 0,
    });

    expect(page.items).toHaveLength(83);
    // 83 is short of the 100 asked for, which is the publisher's own
    // statement that the date is done: it reports no total to check against.
    expect(page.totalPages).toBe(1);
  });

  test("the date filter is the slice, on both ends", async () => {
    const asked: string[] = [];
    answerWith((url) => {
      asked.push(
        `${url.searchParams.get("data_wydania_od")}..${url.searchParams.get("data_wydania_do")}`,
      );
      return jsonResponse(envelope([]));
    });

    await plSnAdapter.reconciliation.listSlicePage({
      slice: "2025-06-11",
      page: 0,
    });

    expect(asked).toEqual(["2025-06-11..2025-06-11"]);
  });

  test("a full page reports there is more, so the walk cannot stop on it", async () => {
    // Rule 14: a full page with nothing saying "and that is all" is not the
    // end of a slice. Only a short page is.
    const rows = Array.from({ length: 100 }, (_unused, index) => ({
      id: `id-${index}`,
      sygnatura_sprawy: `I CSK ${index}/25`,
      forma_orzeczenia: "wyrok SN",
    }));
    answerWith(() => jsonResponse(envelope(rows)));

    const page = await plSnAdapter.reconciliation.listSlicePage({
      slice: "2025-06-11",
      page: 3,
    });

    expect(page.totalPages).toBeGreaterThan(4);
  });

  test("a date the publisher lists nothing for has no pages", async () => {
    answerWith(() => jsonResponse(envelope([])));

    const page = await plSnAdapter.reconciliation.listSlicePage({
      slice: "2025-06-14",
      page: 0,
    });

    expect(page).toEqual({ items: [], totalPages: 0 });
  });

  test("the window error the proxy wraps in a 200 fails the slice", async () => {
    // Past 10,000 matches the upstream answers an Elasticsearch window error
    // with `status: 500` inside a 200. Read as an empty page it would settle
    // the slice over records nobody listed.
    answerWith(() =>
      jsonResponse(
        envelope({
          type: "https://tools.ietf.org/html/rfc9110#section-15.6.1",
          title: "An error occurred while processing your request.",
          status: 500,
        }),
      ),
    );

    // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
    // type-aware lint; capture the rejection explicitly instead.
    const rejection: unknown = await plSnAdapter.reconciliation
      .listSlicePage({ slice: "2025-06-11", page: 0 })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toBeInstanceOf(Error);
    expect(
      rejection instanceof Error ? rejection.message : String(rejection),
    ).toMatch(/answered/u);
  });
});

// ── Crawl walk ───────────────────────────────────────────

describe("walking decision-date months oldest first", () => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = async () => {
      // no-op
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Bun.sleep = originalSleep;
  });

  /** A source holding `rows` in `month` and nothing anywhere else. */
  // Rows are `unknown`, not listing shapes: the publisher can serve an entry
  // the adapter's own shape filter drops, and how the walk sizes a page that
  // holds one is exactly what a test below asserts.
  const sourceHolding = (month: string, rows: readonly unknown[]): string[] => {
    const asked: string[] = [];
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const task = url.searchParams.get("task");
      if (task !== "searchOrzeczenia") {
        // Detail and document alike: nothing served, so the row is stored
        // from its listing and the walk keeps going.
        return await Promise.resolve(jsonResponse(envelope([])));
      }
      const from = url.searchParams.get("data_wydania_od") ?? "";
      asked.push(from);
      const page = Number(url.searchParams.get("strona"));
      const size = Number(url.searchParams.get("rozmiar_strony"));
      const matched = from.startsWith(month) ? rows : [];
      return await Promise.resolve(
        jsonResponse(envelope(matched.slice((page - 1) * size, page * size))),
      );
    });
    return asked;
  };

  const walk = async (cursor: string | null) => {
    const result = await plSnAdapter.fetchPage(cursor, {});
    return Result.isOk(result)
      ? result.value
      : panic(`the walk was refused: ${result.error.message}`);
  };

  test("empty months are stepped over inside one page rather than one per cycle", async () => {
    const asked = sourceHolding("1994-03", [
      { id: "x", sygnatura_sprawy: "I CSK 1/94", forma_orzeczenia: "wyrok SN" },
    ]);
    const page = await walk(null);

    expect(asked.at(0)).toBe("1993-06-01");
    expect(page.decisions).toHaveLength(1);
    expect(page.nextCursor).toBe("1994-04:0");
  });

  test("a full page advances the offset inside the same month", async () => {
    const rows = Array.from({ length: 40 }, (_unused, index) => ({
      id: `id-${index}`,
      sygnatura_sprawy: `I CSK ${index}/94`,
      forma_orzeczenia: "wyrok SN",
    }));
    sourceHolding("1994-03", rows);

    const page = await walk("1994-03:0");

    expect(page.decisions).toHaveLength(20);
    expect(page.nextCursor).toBe("1994-03:20");
  });

  test("a full page holding an unreadable row still continues the month", async () => {
    // The shape filter drops the bad row, but the page the publisher served
    // was full. Measured by what survived the filter, the month would look
    // finished here and every later page of it would go unvisited.
    const rows: unknown[] = Array.from({ length: 19 }, (_unused, index) => ({
      id: `id-${index}`,
      sygnatura_sprawy: `I CSK ${index}/94`,
      forma_orzeczenia: "wyrok SN",
    }));
    rows.push("not an object at all");
    sourceHolding("1994-03", rows);

    const page = await walk("1994-03:0");

    expect(page.decisions).toHaveLength(19);
    expect(page.nextCursor).toBe("1994-03:20");
  });

  test("a cycle aborted mid-page replays it rather than checkpointing past it", async () => {
    const rows = Array.from({ length: 20 }, (_unused, index) => ({
      id: `id-${index}`,
      sygnatura_sprawy: `I CSK ${index}/94`,
      forma_orzeczenia: "wyrok SN",
    }));
    // The cycle ends once the listing is in hand, so the page's rows are
    // listed and none of them is built. A cursor advanced by the page size
    // here would checkpoint past twenty decisions nothing ever looked at.
    const controller = new AbortController();
    globalThis.fetch = asFetchMock(async () => {
      controller.abort();
      return await Promise.resolve(jsonResponse(envelope(rows)));
    });

    const result = await plSnAdapter.fetchPage(
      "1994-03:0",
      {},
      controller.signal,
    );

    expect(Result.isOk(result)).toBe(true);
    if (!Result.isOk(result)) {
      return;
    }
    expect(result.value.decisions).toEqual([]);
    expect(result.value.nextCursor).toBe("1994-03:0");
  });

  test("a short page hands over to the next month at its beginning", async () => {
    sourceHolding("1994-03", [
      { id: "x", sygnatura_sprawy: "I CSK 1/94", forma_orzeczenia: "wyrok SN" },
    ]);

    const page = await walk("1994-03:0");

    expect(page.nextCursor).toBe("1994-04:0");
  });

  test("a refused listing is the page's error, and moves no cursor", async () => {
    // The whole walk reports the publisher through its `Result`: a page that
    // answered with an error object must not read as a month with nothing in
    // it, or the cursor would step past records nobody listed.
    globalThis.fetch = asFetchMock(
      async () =>
        await Promise.resolve(jsonResponse(envelope({ status: 500 }))),
    );

    const result = await plSnAdapter.fetchPage("1994-03:0", {});

    expect(Result.isError(result)).toBe(true);
  });

  test("a listed row whose document the proxy withholds is still stored", async () => {
    sourceHolding("1994-03", [
      { id: "x", sygnatura_sprawy: "I CSK 1/94", forma_orzeczenia: "wyrok SN" },
    ]);

    const [decision] = (await walk("1994-03:0")).decisions;

    expect(decision?.isListingOnly).toBe(true);
    expect(decision?.sourceDocumentId).toBe("x");
  });
});

// ── Replay ───────────────────────────────────────────────

describe("replaying a stored envelope", () => {
  test("the recorded decision rebuilds from its own raw, without the network", async () => {
    const decision = await recordedDecision();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = asFetchMock(async () => {
      throw new Error("a replay must not contact the publisher");
    });

    try {
      const outcome = await plSnAdapter.reparseStoredRaw?.({
        raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
        contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
        caseNumber: decision.caseNumber,
        sourceDocumentId: decision.sourceDocumentId ?? null,
        language: decision.language,
        court: decision.court,
        ecli: null,
        decisionDate: decision.decisionDate ?? null,
        decisionType: decision.decisionType ?? null,
        sourceUrl: decision.sourceUrl ?? null,
        documentUrl: decision.documentUrl ?? null,
        metadata: decision.metadata,
      });

      expect(outcome?.type).toBe("parsed");
      if (outcome?.type !== "parsed") {
        return;
      }
      // A fixed point: the same envelope through the same parser is the same
      // row, hash included, so a replay converges rather than churning.
      expect(outcome.result.rawHash).toBe(decision.rawHash);
      expect(outcome.result.fulltext).toBe(decision.fulltext);
      expect(outcome.result.metadata).toEqual(decision.metadata);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an envelope naming another document is refused rather than re-keyed", async () => {
    const decision = await recordedDecision();

    const outcome = await plSnAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: decision.caseNumber,
      sourceDocumentId: "some-other-document",
      language: decision.language,
      court: decision.court,
      ecli: null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });

    expect(outcome).toEqual({
      type: "rejected",
      rejection: "identity-mismatch",
      detail: expect.stringContaining("some-other-document"),
    });
  });

  test("a row stored before the adapter wrote an envelope is reported, not guessed at", async () => {
    const outcome = await plSnAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode("{}"),
      contentType: "application/json",
      caseNumber: "I CSK 1/26",
      sourceDocumentId: "x",
      language: "pl",
      court: "Sąd Najwyższy",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });

    expect(outcome?.type).toBe("rejected");
  });
});
