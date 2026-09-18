/**
 * hu-bhgy against payloads eakta.birosag.hu actually served.
 *
 * The listing fixture is one decision year and one kollégium captured verbatim,
 * with a provenance sidecar, so an edit to it fails the capture suite rather
 * than quietly changing what these assertions are about. Everything the crawl
 * does beyond reading that payload — paging a window, refusing a saturated one,
 * standing still at the tip — is driven through a stubbed transport, because
 * the behaviour under test is the cursor's, not the network's.
 */

import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/handlers/case-law/ingestion/adapter";
import {
  encodeHuBhgyCursor,
  huBhgyAdapter,
  huBhgyCoveredByFrontier,
  huBhgyDocumentOf,
  huBhgyListingIdentity,
  huBhgySearchBody,
  huBhgySlice,
  huKollegiumsOf,
  normalizeHuBhgyRow,
  parseHuBhgyCursor,
  parseHuBhgySlice,
  parseHuStatuteReferences,
  readHuBhgySearch,
} from "@/api/handlers/case-law/ingestion/adapters/hu-bhgy";
import { publisherRequestIntervalMs } from "@/api/handlers/case-law/ingestion/adapters/publisher-policy";
import {
  rejectionOf,
  requireReconciliation,
} from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

const listingFixture = async (): Promise<Record<string, unknown>[]> => {
  const raw = await Bun.file(
    new URL("hu-bhgy-listing-2000-gazdasagi.json", FIXTURES_DIR),
  ).text();
  const parsed: unknown = JSON.parse(raw);
  const read = readHuBhgySearch(parsed);
  if (read === null) {
    throw new TypeError("the captured listing is not a search result");
  }
  return read.rows;
};

const searchResponse = (
  rows: readonly Record<string, unknown>[],
  count: number,
): Response =>
  new Response(
    JSON.stringify({ List: rows, Count: count, Success: true, Message: null }),
    { headers: { "Content-Type": "application/json; charset=utf-8" } },
  );

/** A minimal, valid DOCX package: the zip signature is all the adapter reads. */
const DOCX_BYTES = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

const rowAt = (index: number, published: string): Record<string, unknown> => ({
  Azonosito: `Gfv.3000${index}/2025/4`,
  MeghozoBirosag: "Kúria",
  Kollegium: "gazdasági",
  IndexId: `id-${index}`,
  IndexelesIdeje: published,
  HatarozatEve: 2025,
});

type Call = { url: string; body: string };

/** Stub the transport and record what the adapter asked the publisher for. */
/** The address a fetch was called with, whichever of the three forms it took. */
const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

const stubPublisher = (
  answer: (call: Call) => Response,
): { calls: Call[]; restore: () => void } => {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      const body = typeof init?.body === "string" ? init.body : "";
      calls.push({ url, body });
      return await Promise.resolve(answer({ url, body }));
    },
  );
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

const isSearch = (call: Call): boolean => call.url.includes("/Search");

// ── The search envelope ──────────────────────────────────

describe("reading the search envelope", () => {
  test("the captured page unwraps to its rows", async () => {
    expect(await listingFixture()).toHaveLength(4);
  });

  test("the no-results state is an empty page, not a failure", () => {
    expect(
      readHuBhgySearch({ List: [], Count: 0, Success: true, Message: null }),
    ).toEqual({ rows: [], count: 0 });
    expect(
      readHuBhgySearch({ List: null, Count: 0, Success: true, Message: null }),
    ).toEqual({ rows: [], count: 0 });
  });

  test("an HTTP 200 that is not the no-results state is no page at all", () => {
    // Paging past the window ceiling answers this, at HTTP 200. Read as an
    // empty result it would end a slice with rows still in it (rule 20).
    expect(
      readHuBhgySearch({
        List: null,
        Count: 0,
        Success: false,
        Message: "Hiba történt az adatok betöltése során!",
      }),
    ).toBeNull();
    expect(readHuBhgySearch({ Success: true })).toBeNull();
    expect(readHuBhgySearch("<html>maintenance</html>")).toBeNull();
  });
});

// ── Identity ─────────────────────────────────────────────

describe("identity", () => {
  test("is the publisher's own document key, never the docket alone", async () => {
    const rows = await listingFixture();
    for (const row of rows) {
      const normalized = normalizeHuBhgyRow(row);
      expect(huBhgyListingIdentity(normalized)).toEqual({
        type: "document",
        sourceDocumentId: normalized.IndexId ?? "",
      });
    }
  });

  test("a row with no publisher key falls back to its docket and language", () => {
    expect(
      huBhgyListingIdentity(
        normalizeHuBhgyRow({ Azonosito: "Gfv.30091/2025/4" }),
      ),
    ).toEqual({
      type: "case-number",
      caseNumber: "Gfv.30091/2025/4",
      language: "hu",
    });
  });

  test("a row stating neither is unidentifiable rather than keyed on a guess", () => {
    expect(huBhgyListingIdentity(normalizeHuBhgyRow({}))).toEqual({
      type: "unidentifiable",
    });
  });

  test("the collection also lists editorial series, which are not dockets", async () => {
    // `GK.34` is a kollégiumi állásfoglalás and `EBH.2013.K.15.` an elvi
    // bírósági határozat: both occupy `Azonosito`, and neither is a court file
    // reference, so `DECISION_DOCKET_GRAMMARS.HUN` rejects them. A stated blind
    // spot rather than a silent one — a citation of one resolves by its own
    // series number, not through the docket grammar.
    const rows = await listingFixture();
    const parsed = new Map(
      rows
        .map((row) => normalizeHuBhgyRow(row).Azonosito ?? "")
        .map((docket) => [
          docket,
          DECISION_DOCKET_GRAMMARS.HUN.parse(docket) !== null,
        ]),
    );
    expect(
      [...parsed].filter(([, ok]) => !ok).map(([docket]) => docket),
    ).toEqual(["GK.34", "GK.37", "GK.30"]);
    expect([...parsed.values()].some(Boolean)).toBe(true);
  });
});

// ── Row fields ───────────────────────────────────────────

describe("reading a row's own fields", () => {
  test("a decision filed under two colleges states both", () => {
    expect(huKollegiumsOf("polgári; gazdasági")).toEqual([
      "polgári",
      "gazdasági",
    ]);
    expect(huKollegiumsOf(undefined)).toEqual([]);
  });

  test("the tagged provisions parse into act, section and version date", () => {
    const [first, second] = parseHuStatuteReferences(
      "2013. évi V. törvény a Polgári Törvénykönyvről 3:17. § (6) - 2025-10-01;</br>15/1990. BM rendelet 4. §",
    );
    expect(first).toEqual({
      act: {
        year: 2013,
        number: "V",
        kind: "törvény",
        title: "a Polgári Törvénykönyvről",
      },
      section: "3:17",
      subsection: "6",
      asOf: "2025-10-01",
      raw: "2013. évi V. törvény a Polgári Törvénykönyvről 3:17. § (6) - 2025-10-01",
    });
    expect(second?.act.number).toBe("15/1990");
    expect(second?.section).toBe("4");
  });

  test("an entry the parse does not recognise keeps its verbatim text", () => {
    const [only] = parseHuStatuteReferences("valami egészen más");
    expect(only).toEqual({ act: {}, raw: "valami egészen más" });
  });
});

// ── The served document ──────────────────────────────────

describe("classifying the download", () => {
  test("the bytes decide, not the filename the publisher sends", () => {
    // The legacy half is served as `.docx` and holds RTF.
    expect(
      huBhgyDocumentOf(new TextEncoder().encode("{\\rtf1\\ansi"))?.contentType,
    ).toBe("application/rtf");
    expect(huBhgyDocumentOf(DOCX_BYTES)?.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  test("anything else is no document", () => {
    expect(
      huBhgyDocumentOf(new TextEncoder().encode("<html>error</html>")),
    ).toBeUndefined();
  });
});

// ── The crawl cursor ─────────────────────────────────────

describe("the crawl cursor", () => {
  test("round-trips both phases", () => {
    const sweep = {
      phase: "sweep" as const,
      boundary: "2026-09-19T12:19:50+02:00",
      year: 2012,
      slug: "e-polg" as const,
      offset: 140,
    };
    expect(parseHuBhgyCursor(encodeHuBhgyCursor(sweep))).toEqual(sweep);
    const tip = {
      phase: "tip" as const,
      frontier: "2026-09-19T12:19:50+02:00",
      offset: 0,
    };
    expect(parseHuBhgyCursor(encodeHuBhgyCursor(tip))).toEqual(tip);
  });

  test("a cursor nothing wrote reads as none, so the sweep opens a boundary", () => {
    // Never as the tip: a shape this adapter does not recognise has to resume
    // the sweep, not skip what it has not walked (rule 13).
    for (const cursor of [null, "", "2020-03:0", "sweep|x|1900|e-polg|0"]) {
      expect(parseHuBhgyCursor(cursor)).toBeNull();
    }
  });
});

describe("the tip frontier", () => {
  /**
   * Hungary left summer time at 03:00 local on 2025-10-26. The publisher
   * writes its own offset, so the row published first carries `+02:00` and the
   * one published 35 minutes later carries `+01:00` — and reads as the smaller
   * string, which is the opposite of the order they were published in.
   */
  const BEFORE_THE_SWITCH = "2025-10-26T02:45:00+02:00";
  const AFTER_THE_SWITCH = "2025-10-26T02:20:00+01:00";

  const sortsFirstAsText = (left: string, right: string): boolean =>
    left < right;

  test("a row published after the frontier is new, whichever offset it carries", () => {
    expect(sortsFirstAsText(AFTER_THE_SWITCH, BEFORE_THE_SWITCH)).toBe(true);
    expect(huBhgyCoveredByFrontier(AFTER_THE_SWITCH, BEFORE_THE_SWITCH)).toBe(
      false,
    );
  });

  test("a row published before the frontier is covered", () => {
    expect(huBhgyCoveredByFrontier(BEFORE_THE_SWITCH, AFTER_THE_SWITCH)).toBe(
      true,
    );
    expect(huBhgyCoveredByFrontier(BEFORE_THE_SWITCH, BEFORE_THE_SWITCH)).toBe(
      true,
    );
  });

  test("a timestamp neither side can read leaves the row to be walked again", () => {
    // Re-reading a row costs a request; skipping one loses the decision.
    expect(huBhgyCoveredByFrontier("", BEFORE_THE_SWITCH)).toBe(false);
    expect(huBhgyCoveredByFrontier(BEFORE_THE_SWITCH, "")).toBe(false);
  });
});

// ── Slices ───────────────────────────────────────────────

describe("the reconciliation slice walk", () => {
  const reconciliation = requireReconciliation(huBhgyAdapter);

  test("slices sort in walk order", () => {
    expect(huBhgySlice(2012, "a-buntet") < huBhgySlice(2012, "e-polg")).toBe(
      true,
    );
    expect(huBhgySlice(2012, "e-polg") < huBhgySlice(2013, "a-buntet")).toBe(
      true,
    );
  });

  test("the walk steps college by college, then year by year", () => {
    expect(reconciliation.nextSlice("2012-a-buntet")).toBe("2012-b-gazd");
    expect(reconciliation.nextSlice("2012-e-polg")).toBe("2013-a-buntet");
    expect(reconciliation.previousSlice("2013-a-buntet")).toBe("2012-e-polg");
    expect(reconciliation.previousSlice(reconciliation.firstSlice)).toBeNull();
  });

  test("a slice names a year the publisher filters on and a college", () => {
    expect(parseHuBhgySlice("2012-e-polg")).toEqual({
      year: 2012,
      kollegium: "polgári",
    });
    expect(parseHuBhgySlice("2012-unknown")).toBeNull();
  });

  test("the slice listing asks for the publisher's largest page", async () => {
    const rows = await listingFixture();
    const stub = stubPublisher(() => searchResponse(rows, 4));
    try {
      const page = await reconciliation.listSlicePage({
        slice: "2000-b-gazd",
        page: 0,
      });
      expect(page.items).toHaveLength(4);
      expect(page.totalPages).toBe(1);
      expect(stub.calls[0]?.body).toContain("ResultCount=100");
      expect(stub.calls[0]?.body).toContain("MeghozatalIdejeTol=2000");
    } finally {
      stub.restore();
    }
  });

  test("a slice listing states the pages its own count implies", async () => {
    const rows = await listingFixture();
    const stub = stubPublisher(() => searchResponse(rows, 250));
    try {
      const page = await reconciliation.listSlicePage({
        slice: "2000-b-gazd",
        page: 0,
      });
      expect(page.totalPages).toBe(3);
    } finally {
      stub.restore();
    }
  });

  test("a slice at the window ceiling fails loudly rather than truncating", async () => {
    // The publisher will not page past its ten-thousandth match, and the two
    // finer facets it offers do not partition a slice, so the honest answer is
    // a refusal that holds the ledger row (rule 14).
    const stub = stubPublisher(() => searchResponse([], 10_000));
    try {
      const refusal = await rejectionOf(
        reconciliation.listSlicePage({ slice: "2012-e-polg", page: 0 }),
      );
      expect(refusal).toBeInstanceOf(AdapterFetchError);
      expect(refusal instanceof Error ? refusal.message : "").toContain(
        "window ceiling",
      );
    } finally {
      stub.restore();
    }
  });
});

// ── The crawl ────────────────────────────────────────────

describe("the crawl", () => {
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = async () => {
      // The publisher gate paces against a live court; nothing here is live.
    };
  });

  afterEach(() => {
    Bun.sleep = originalSleep;
  });

  test("a first cycle takes the publisher's boundary before it sweeps", async () => {
    const stub = stubPublisher((call) =>
      call.body.includes("IndexelesIdejeCsokkeno")
        ? searchResponse([rowAt(0, "2026-09-19T12:00:00+02:00")], 10_000)
        : searchResponse([], 0),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(null, {});
      expect(Result.isOk(page)).toBe(true);
      expect(stub.calls[0]?.body).toContain("Rendezes=IndexelesIdejeCsokkeno");
      const cursor = Result.isOk(page) ? (page.value.nextCursor ?? "") : "";
      expect(cursor.startsWith("sweep|2026-09-19T12:00:00+02:00|")).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a window longer than one page is followed to its end", async () => {
    // Rule 14: a full page is never the end of a window; the publisher's own
    // count is what says there is more.
    const first = Array.from({ length: 20 }, (_, index) =>
      rowAt(index, `2025-01-0${(index % 9) + 1}T10:00:00+01:00`),
    );
    const stub = stubPublisher((call) =>
      call.body.includes("ResultStartIndex=0")
        ? searchResponse(first, 45)
        : searchResponse([], 45),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(
        "sweep|2026-09-19T12:00:00+02:00|2025|b-gazd|0",
        {},
      );
      expect(Result.isOk(page)).toBe(true);
      expect(Result.isOk(page) ? page.value.nextCursor : "").toBe(
        "sweep|2026-09-19T12:00:00+02:00|2025|b-gazd|20",
      );
    } finally {
      stub.restore();
    }
  });

  test("a window at the ceiling stops the page instead of skipping its tail", async () => {
    const stub = stubPublisher(() => searchResponse([], 10_000));
    try {
      const page = await huBhgyAdapter.fetchPage(
        "sweep|2026-09-19T12:00:00+02:00|2012|e-polg|0",
        {},
      );
      expect(Result.isError(page)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("an unrecognised HTTP 200 is a failure, not an exhausted window", async () => {
    const stub = stubPublisher(
      () =>
        new Response(
          JSON.stringify({
            List: null,
            Count: 0,
            Success: false,
            Message: "Hiba történt az adatok betöltése során!",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(
        "sweep|2026-09-19T12:00:00+02:00|2025|b-gazd|0",
        {},
      );
      expect(Result.isError(page)).toBe(true);
    } finally {
      stub.restore();
    }
  });

  test("a quiet tip cycle costs one request and returns the cursor it was given", async () => {
    // Rule 19: the steady state is a frontier, so a cycle on which nothing was
    // published writes nothing and asks for nothing more.
    const cursor = "tip|2026-09-19T12:00:00+02:00|0";
    const stub = stubPublisher(() =>
      searchResponse([rowAt(1, "2026-09-19T11:00:00+02:00")], 10_000),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(cursor, {});
      expect(Result.isOk(page) ? page.value.nextCursor : "").toBe(cursor);
      expect(Result.isOk(page) ? page.value.decisions : []).toEqual([]);
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  test("the tip collects what was published past the frontier and advances it", async () => {
    const fresh = rowAt(9, "2026-09-19T13:00:00+02:00");
    const held = rowAt(8, "2026-09-19T11:00:00+02:00");
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? searchResponse([fresh, held], 10_000)
        : new Response(DOCX_BYTES),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(
        "tip|2026-09-19T12:00:00+02:00|0",
        {},
      );
      const value = Result.isOk(page) ? page.value : null;
      expect(
        value?.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
      ).toEqual(["id-9"]);
      expect(value?.nextCursor).toBe("tip|2026-09-19T13:00:00+02:00|0");
    } finally {
      stub.restore();
    }
  });
});

// ── What survives a failure ──────────────────────────────

describe("a listed decision the download will not serve", () => {
  const originalSleep = Bun.sleep;

  beforeEach(() => {
    Bun.sleep = async () => {
      /* no pacing against a stub */
    };
  });

  afterEach(() => {
    Bun.sleep = originalSleep;
  });

  test("keeps its identity as a listing-only row (rule 20)", async () => {
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? searchResponse([rowAt(7, "2026-09-19T13:00:00+02:00")], 10_000)
        : new Response(null, { status: 404 }),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(
        "tip|2026-09-19T12:00:00+02:00|0",
        {},
      );
      const [decision] = Result.isOk(page) ? page.value.decisions : [];
      expect(decision?.sourceDocumentId).toBe("id-7");
      expect(decision?.isListingOnly).toBe(true);
      expect(decision?.sourceRawContentType).toBe(
        SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      );
      // The listing row is archived even with no document, so a later parser
      // can repair the metadata without another historical crawl.
      expect(decision?.sourceRaw).toContain("id-7");
    } finally {
      stub.restore();
    }
  });

  test("a row with no publisher key does not poison the page around it", async () => {
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? searchResponse(
            [
              {
                Azonosito: "Gfv.30000/2025/4",
                IndexelesIdeje: "2026-09-19T13:30:00+02:00",
              },
              rowAt(6, "2026-09-19T13:00:00+02:00"),
            ],
            10_000,
          )
        : new Response(DOCX_BYTES),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(
        "tip|2026-09-19T12:00:00+02:00|0",
        {},
      );
      expect(
        Result.isOk(page)
          ? page.value.decisions.map(({ sourceDocumentId }) => sourceDocumentId)
          : [],
      ).toEqual(["id-6"]);
    } finally {
      stub.restore();
    }
  });
});

// ── Replay ───────────────────────────────────────────────

describe("replaying a stored envelope", () => {
  test("rebuilds the decision the crawl stored, without the publisher", async () => {
    const rows = await listingFixture();
    const [row] = rows;
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? searchResponse([row ?? {}], 10_000)
        : new Response(DOCX_BYTES),
    );
    let stored;
    try {
      const page = await huBhgyAdapter.fetchPage(
        "tip|2000-01-01T00:00:00+01:00|0",
        {},
      );
      [stored] = Result.isOk(page) ? page.value.decisions : [];
    } finally {
      stub.restore();
    }
    expect(stored).toBeDefined();
    if (stored === undefined) {
      return;
    }

    const replayed = await huBhgyAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(stored.sourceRaw ?? ""),
      contentType: stored.sourceRawContentType ?? null,
      caseNumber: stored.caseNumber,
      sourceDocumentId: stored.sourceDocumentId ?? null,
      language: stored.language,
      court: stored.court,
      ecli: null,
      decisionDate: stored.decisionDate ?? null,
      decisionType: stored.decisionType ?? null,
      sourceUrl: stored.sourceUrl ?? null,
      documentUrl: stored.documentUrl ?? null,
      metadata: stored.metadata,
    });
    expect(replayed?.type).toBe("parsed");
    if (replayed?.type === "parsed") {
      expect(replayed.result.rawHash).toBe(stored.rawHash);
      expect(replayed.result.sourceDocumentId).toBe(stored.sourceDocumentId);
    }
  });

  test("a payload stored before the envelope is reported, not guessed at", async () => {
    const replayed = await huBhgyAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode("<html/>"),
      contentType: "text/html",
      caseNumber: "Gfv.30091/2025/4",
      sourceDocumentId: "id-1",
      language: "hu",
      court: "Kúria",
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });
    expect(replayed?.type).toBe("rejected");
  });
});

// ── The publisher's budget ───────────────────────────────

describe("the publisher gate", () => {
  test("the adapter paces at the interval the policy map declares", () => {
    expect(huBhgyAdapter.minRequestIntervalMs).toBe(
      publisherRequestIntervalMs(ADAPTER_KEYS.HU_BHGY),
    );
  });

  test("every listing request names the sort and the page size it costs", () => {
    const body = huBhgySearchBody({
      year: 2012,
      kollegium: "polgári",
      sort: "IndexelesIdejeNovekvo",
      offset: 200,
      pageSize: 100,
    });
    expect(body).toContain("Rendezes=IndexelesIdejeNovekvo");
    expect(body).toContain("ResultCount=100");
    expect(body).toContain("ResultStartIndex=200");
    expect(body).toContain("NemHivatkozhato=igen");
  });
});

// ── Metadata ─────────────────────────────────────────────

describe("what a stored row keeps", () => {
  test("every field the listing states reaches the row", async () => {
    const rows = await listingFixture();
    const row = rows.find((candidate) =>
      isRecord(candidate) ? candidate["Jogszabalyhelyek"] !== null : false,
    );
    expect(row).toBeDefined();
    const stub = stubPublisher((call) =>
      isSearch(call)
        ? searchResponse([row ?? {}], 10_000)
        : new Response(DOCX_BYTES),
    );
    try {
      const page = await huBhgyAdapter.fetchPage(
        "tip|2000-01-01T00:00:00+01:00|0",
        {},
      );
      const [decision] = Result.isOk(page) ? page.value.decisions : [];
      expect(decision?.metadata["bhgyIdentifier"]).toBe(
        normalizeHuBhgyRow(row ?? {}).EgyediAzonosito,
      );
      expect(decision?.metadata["publishedAt"]).toBe(
        normalizeHuBhgyRow(row ?? {}).IndexelesIdeje,
      );
      expect(Array.isArray(decision?.metadata["statutes"])).toBe(true);
      expect(decision?.court).toBe(
        normalizeHuBhgyRow(row ?? {}).MeghozoBirosag,
      );
    } finally {
      stub.restore();
    }
  });
});
