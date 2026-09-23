/**
 * pl-kio against pages orzeczenia.uzp.gov.pl actually served.
 *
 * Every listing, record and document fixture is a verbatim capture with a
 * provenance sidecar; the few inline pages below are built in the same markup
 * to isolate one behaviour the captures cannot show together.
 */

import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { buildPlDecision } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  assemblePlKioDecision,
  encodePlKioCursor,
  normalizeProcurementDocket,
  parsePlKioCursor,
  plKioAdapter,
  plKioCaseOf,
  plKioHeaderDate,
  plKioListingIdentity,
  plProcurementRulingKeys,
  readPlKioDetail,
  readPlKioListing,
} from "@/api/handlers/case-law/ingestion/adapters/pl-kio";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

const fixtureText = async (name: string): Promise<string> =>
  await Bun.file(new URL(name, FIXTURES_DIR)).text();

const gzFixtureText = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(
      new Uint8Array(await Bun.file(new URL(name, FIXTURES_DIR)).arrayBuffer()),
    ),
  );

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

/**
 * Every outcome carries a decision: a row that cannot be fully read is kept
 * listing-only under a quarantine reason rather than dropped.
 */
const built = (
  outcome: ReturnType<typeof assemblePlKioDecision>,
): IngestionResult => outcome.decision;

/** One listing row in the page's own markup. */
const listingRow = (id: string, signature: string, date: string): string =>
  `<div class="search-list-item"><div class="search-result-item__rate-wrapper"><div>
  <label>Organ wydający:</label> Krajowa Izba Odwo&#x142;awcza</div></div>
  <p><label>Rodzaj dokumentu:</label> wyrok</p>
  <p><label>Sygnatura:</label> ${signature}</p>
  <p><label>Data wydania:</label> ${date}</p>
  <a class="link-details" href="/Home/Details/${id}">Wyświetl szczegóły</a></div>`;

const listingPage = (total: number, rows: readonly string[]): string =>
  `<input type="hidden" value="${total},${total},0,0,0" id="resultCounts" />${rows.join("")}`;

// ── The listing ──────────────────────────────────────────

describe("reading a listing page", () => {
  test("one decision date lists its count, and its two pages hold that many distinct ids", async () => {
    const first = readPlKioListing(
      await fixtureText("pl-kio-listing-2025-09-01-p1.html"),
    );
    const second = readPlKioListing(
      await fixtureText("pl-kio-listing-2025-09-01-p2.html"),
    );
    expect(first?.counts).toEqual([20, 20, 0, 0, 0]);
    expect(first?.rows).toHaveLength(10);
    expect(second?.rows).toHaveLength(10);

    const ids = [...(first?.rows ?? []), ...(second?.rows ?? [])].map(
      (row) => row.id,
    );
    expect(new Set(ids).size).toBe(20);
    expect(ids.every((id) => id !== undefined && /^\d+$/u.test(id))).toBe(true);
  });

  test("a row states its signature, type and date as printed, entities decoded", async () => {
    const listing = readPlKioListing(
      await fixtureText("pl-kio-listing-2025-09-01-p1.html"),
    );
    expect(listing?.rows.find((row) => row.id === "30308")).toMatchObject({
      id: "30308",
      court: "Krajowa Izba Odwoławcza",
      documentType: "wyrok",
      signature: "KIO 2845/25|KIO 2846/25",
      issueDate: "01-09-2025",
    });
  });

  test("rulings with no issue date head the newest-first listing, printed as a dash", async () => {
    const listing = readPlKioListing(
      await fixtureText("pl-kio-listing-undated-p1.html"),
    );
    expect(listing?.counts[0]).toBeGreaterThan(30_000);
    expect(listing?.rows).toHaveLength(10);
    expect(listing?.rows.every((row) => row.issueDate === undefined)).toBe(
      true,
    );
  });

  test("the unfiltered listing mixes the chamber and the courts, and counts them apart", async () => {
    const listing = readPlKioListing(
      await fixtureText("pl-kio-listing-2010-so.html"),
    );
    expect(listing?.counts).toEqual([2, 1, 1, 0, 0]);
    expect(listing?.rows.map((row) => row.court).toSorted()).toEqual([
      "Krajowa Izba Odwoławcza",
      "Sąd Okręgowy w Szczecinie",
    ]);
  });

  test("a page without a result count is not a listing, however it looks", async () => {
    expect(
      readPlKioListing(await fixtureText("pl-kio-detail-30308.html")),
    ).toBeNull();
    expect(
      readPlKioListing("<html><body>Access denied</body></html>"),
    ).toBeNull();
  });

  test("a row is keyed by the database id, never by its signature", () => {
    expect(
      plKioListingIdentity({ id: "30308", signature: "KIO 2845/25" }),
    ).toEqual({ type: "document", sourceDocumentId: "30308" });
    expect(
      plKioListingIdentity({ signature: "KIO 2845/25" }).type === "document" &&
        plKioListingIdentity({ signature: "KIO 2845/25" }),
    ).toMatchObject({
      sourceDocumentId: expect.stringMatching(/^uzp-quarantine:/u),
    });
  });
});

// ── The record page ──────────────────────────────────────

describe("reading a record page", () => {
  test("a court ruling names the appeal it reviewed between signature and outcome", async () => {
    const detail = readPlKioDetail(
      await fixtureText("pl-kio-detail-8247.html"),
    );
    expect(detail?.kind).toBe("SO");
    expect(detail?.fields.get("Organ wydający")).toBe(
      "Sąd Okręgowy w Szczecinie",
    );
    expect(detail?.cases).toEqual([
      {
        caseNumber: "VIII Ga 248/09",
        reviewedCaseNumber: "1244/09",
        outcome: "oddala skargę",
      },
    ]);
  });

  test("a Supreme Court record has no case list; the heading carries the signature", async () => {
    const detail = readPlKioDetail(
      await fixtureText("pl-kio-detail-9016.html"),
    );
    expect(detail?.kind).toBe("SN");
    expect(detail?.heading).toBe("I CZ 140/10");
    expect(detail?.cases).toEqual([]);
    expect(detail?.fields.get("Izba")).toBe("Izba Cywilna");
  });

  test("an early chamber signature with spaces round its slash stays one signature", () => {
    expect(plKioCaseOf("KIO/UZP 192 / 08 / oddalone", false)).toEqual([
      { caseNumber: "KIO/UZP 192 / 08", outcome: "oddalone" },
    ]);
  });

  test("joined appeals on one line are one case each, sharing the outcome", () => {
    expect(plKioCaseOf("KIO 2845/25|KIO 2846/25 / oddalone", false)).toEqual([
      { caseNumber: "KIO 2845/25", outcome: "oddalone" },
      { caseNumber: "KIO 2846/25", outcome: "oddalone" },
    ]);
  });

  test("every label on the captured records is one the adapter maps", async () => {
    const pages = ["30308", "8247", "13694", "9016", "9019"];
    for (const id of pages) {
      const decision = built(
        assemblePlKioDecision({
          item: { id },
          detailHtml: await fixtureText(`pl-kio-detail-${id}.html`),
          documentHtml: undefined,
        }),
      );
      expect({ id, unmapped: decision.metadata["unmappedFields"] }).toEqual({
        id,
        unmapped: undefined,
      });
    }
  });

  test("a label the adapter has never seen is kept verbatim and reported", async () => {
    const page = (await fixtureText("pl-kio-detail-30308.html")).replace(
      '<label for="Procedure">',
      '<label for="Publisher">Publikator</label><br />Biuletyn Zamówień Publicznych</p></div><div class="col-md-6"><p><label for="Procedure">',
    );
    const decision = built(
      assemblePlKioDecision({
        item: { id: "30308" },
        detailHtml: page,
        documentHtml: undefined,
      }),
    );
    expect(decision.metadata["unmappedFields"]).toEqual({
      Publikator: "Biuletyn Zamówień Publicznych",
    });
  });
});

// ── Building a ruling ────────────────────────────────────

describe("building a ruling from its three pages", () => {
  const joined = async (): Promise<IngestionResult> =>
    built(
      assemblePlKioDecision({
        item: {
          id: "30308",
          signature: "KIO 2845/25|KIO 2846/25",
          issueDate: "01-09-2025",
        },
        detailHtml: await fixtureText("pl-kio-detail-30308.html"),
        documentHtml: await gzFixtureText("pl-kio-content-30308.html.gz"),
      }),
    );

  test("joined appeals: the first is the case number, the rest are identifiers", async () => {
    const decision = await joined();
    expect(decision.caseNumber).toBe("KIO 2845/25");
    expect(decision.identifiers).toEqual([
      { type: "case-number", value: "KIO 2846/25" },
    ]);
    expect(decision.sourceDocumentId).toBe("30308");
    expect(decision.court).toBe("Krajowa Izba Odwoławcza");
    expect(decision.decisionDate).toBe("2025-09-01");
    expect(decision.decisionType).toBe("wyrok");
    expect(decision.judges).toEqual([
      { role: "presiding", nameAsPrinted: "Ewa Sikorska" },
    ]);
    expect(decision.metadata["contractingAuthority"]).toBe(
      "PKP Polskie Linie Kolejowe Spółkę akcyjną w Warszawie",
    );
    expect(decision.metadata["decisionDateSource"]).toBe("publisher");
  });

  test("provisions and index terms are split into items, joined or linked singly", async () => {
    const decision = await joined();
    const bases = decision.metadata["legalBases"];
    expect(Array.isArray(bases) && bases.length > 1).toBe(true);
    expect(
      Array.isArray(bases) &&
        bases.every((item) => typeof item === "string" && !item.includes("|")),
    ).toBe(true);
    const terms = decision.metadata["keywords"];
    expect(Array.isArray(terms) && terms.length > 0).toBe(true);
  });

  test("the document parses to text the ruling states", async () => {
    const decision = await joined();
    expect(decision.fulltext).toContain("Krajowa Izba Odwoławcza");
    expect(decision.fulltext).toContain("KIO 2846/25");
    expect("blocks" in decision.documentAst).toBe(true);
  });

  test("a court ruling on a complaint is stored under the court that issued it", async () => {
    const decision = built(
      assemblePlKioDecision({
        item: { id: "8247" },
        detailHtml: await fixtureText("pl-kio-detail-8247.html"),
        documentHtml: await gzFixtureText("pl-kio-content-8247.html.gz"),
      }),
    );
    expect(decision.caseNumber).toBe("VIII Ga 248/09");
    expect(decision.court).toBe("Sąd Okręgowy w Szczecinie");
    expect(decision.metadata["kind"]).toBe("SO");
    expect(decision.fulltext).toContain("W IMIENIU RZECZYPOSPOLITEJ POLSKIEJ");
    expect(decision.documentUrl).toBe(
      "https://orzeczenia.uzp.gov.pl/Home/ContentHtml/8247?Kind=SO&flection=0",
    );
  });

  test("a ruling listed without a date takes the one its own header states", async () => {
    const decision = built(
      assemblePlKioDecision({
        item: { id: "13694", signature: "KIO 1090/20" },
        detailHtml: await fixtureText("pl-kio-detail-13694.html"),
        documentHtml: await gzFixtureText("pl-kio-content-13694.html.gz"),
      }),
    );
    expect(decision.caseNumber).toBe("KIO 1090/20");
    expect(decision.identifiers).toBeUndefined();
    expect(decision.decisionDate).toBe("2020-07-28");
    expect(decision.metadata["decisionDateSource"]).toBe("document");
    // The record prints "-" for the type: no type is stated, none invented.
    expect(decision.decisionType).toBeUndefined();
  });

  test("the header date is read only from the header", () => {
    expect(
      plKioHeaderDate("Sygn. akt KIO 1/07 WYROK z dnia 07.12.2007 r."),
    ).toBe("2007-12-07");
    expect(
      plKioHeaderDate(`WYROK ${"x ".repeat(400)} w dniu 3 marca 2020 r.`),
    ).toBeUndefined();
    expect(plKioHeaderDate("z dnia 31 lutego 2020 r.")).toBeUndefined();
  });

  test("an empty document is no document, and the record still builds", async () => {
    const outcome = assemblePlKioDecision({
      item: { id: "9019" },
      detailHtml: await fixtureText("pl-kio-detail-9019.html"),
      documentHtml: "",
    });
    expect(outcome.type).toBe("built");
    const decision = built(outcome);
    expect(decision.fulltext).toBeUndefined();
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.caseNumber).toBe("V SA/Wa 3975/15");
    expect(decision.metadata["challengedAuthority"]).toBe(
      "Prezes Urzędu Zamówień Publicznych",
    );
  });

  test("a record the database no longer serves leaves a listing-only row", () => {
    const outcome = assemblePlKioDecision({
      item: {
        id: "30308",
        court: "Krajowa Izba Odwoławcza",
        signature: "KIO 2845/25",
        issueDate: "01-09-2025",
      },
      detailHtml: undefined,
      documentHtml: undefined,
    });
    expect(outcome.type).toBe("detail-unavailable");
    expect(built(outcome).isListingOnly).toBe(true);
  });

  test("the stored listing part keeps the row as the page served it", async () => {
    const listing = readPlKioListing(
      await fixtureText("pl-kio-listing-2025-09-01-p1.html"),
    );
    const row = listing?.rows.find((candidate) => candidate.id === "30308");
    expect(row?.html).toContain('href="/Home/Details/30308"');
    const decision = built(
      assemblePlKioDecision({
        item: row ?? {},
        detailHtml: await fixtureText("pl-kio-detail-30308.html"),
        documentHtml: undefined,
      }),
    );
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    const stored: unknown = JSON.parse(parts?.["listing"] ?? "{}");
    expect(stored).toMatchObject({ html: row?.html });
  });

  test("the stored envelope rebuilds the same ruling without the network", async () => {
    const decision = await joined();
    const outcome = await plKioAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: decision.caseNumber,
      sourceDocumentId: "30308",
      language: "pl",
      court: decision.court,
      ecli: null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });
    expect(outcome?.type).toBe("parsed");
    if (outcome?.type === "parsed") {
      expect(outcome.result.rawHash).toBe(decision.rawHash);
      expect(outcome.result.fulltext).toBe(decision.fulltext);
      expect(outcome.result.metadata).toEqual(decision.metadata);
    }
  });

  test("an envelope naming another record is refused rather than re-keyed", async () => {
    const decision = await joined();
    const outcome = await plKioAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: decision.caseNumber,
      sourceDocumentId: "99999",
      language: "pl",
      court: decision.court,
      ecli: null,
      decisionDate: null,
      decisionType: null,
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    });
    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "identity-mismatch",
    });
  });
});

// ── The relationship to SAOS rows ────────────────────────

describe("the same ruling in both sources", () => {
  const saosRow = (caseNumbers: string[], judgmentType: string) =>
    buildPlDecision({
      listingItem: {
        id: 113_338,
        courtType: "NATIONAL_APPEAL_CHAMBER",
        courtCases: caseNumbers.map((caseNumber) => ({ caseNumber })),
        judgmentType,
        judgmentDate: "2009-12-22",
      },
      detail: null,
      rawParts: { "listing-dump": "{}" },
    });

  test("the chamber's older spellings of one signature meet as one key", () => {
    expect(normalizeProcurementDocket("KIO/UZP 1817//09")).toBe("KIO 1817/09");
    expect(normalizeProcurementDocket("KIO/UZP 192 / 08")).toBe("KIO 192/08");
    expect(normalizeProcurementDocket("KIO/UZP/1/07")).toBe("KIO 1/07");
    expect(normalizeProcurementDocket("KIO/UZP 1320/8")).toBe("KIO 1320/08");
    expect(normalizeProcurementDocket("KIO 2681/25")).toBe("KIO 2681/25");
    expect(normalizeProcurementDocket("VIII Ga 248/09")).toBe("VIII GA 248/09");
  });

  test("a SAOS row and a UZP row of one ruling share a key; a different type does not", () => {
    const uzp = plProcurementRulingKeys({
      caseNumber: "KIO/UZP 1817//09",
      identifiers: undefined,
      court: "Krajowa Izba Odwoławcza",
      decisionDate: "2009-12-22",
      decisionType: "wyrok",
    });
    const saos = saosRow(["KIO/UZP 1817/09"], "SENTENCE");
    const saosOrder = saosRow(["KIO/UZP 1817/09"], "DECISION");
    if (saos === null || saosOrder === null) {
      throw new TypeError("the SAOS row did not build");
    }
    expect(plProcurementRulingKeys(saos)).toEqual(uzp);
    expect(
      plProcurementRulingKeys(saosOrder).some((key) => uzp.includes(key)),
    ).toBe(false);
  });

  test("joined appeals meet on any signature the other side lists", () => {
    const saos = saosRow(["KIO 2846/25", "KIO 2845/25"], "SENTENCE");
    if (saos === null) {
      throw new TypeError("the SAOS row did not build");
    }
    const uzp = plProcurementRulingKeys({
      caseNumber: "KIO 2845/25",
      identifiers: [{ type: "case-number", value: "KIO 2846/25" }],
      court: "Krajowa Izba Odwoławcza",
      decisionDate: "2009-12-22",
      decisionType: "wyrok",
    });
    expect(new Set(plProcurementRulingKeys(saos))).toEqual(new Set(uzp));
  });

  test("a row without its date or type states no key rather than a loose one", () => {
    expect(
      plProcurementRulingKeys({
        caseNumber: "KIO 1090/20",
        identifiers: undefined,
        court: "Krajowa Izba Odwoławcza",
        decisionDate: "2020-07-28",
        decisionType: undefined,
      }),
    ).toEqual([]);
  });
});

// ── The crawl ────────────────────────────────────────────

type Seen = { url: string; body: string };

type StubOverrides = {
  detailStatus?: number;
  contentStatus?: number;
  listingStatus?: number;
  /** Replaces the captured month listing, keyed by page number. */
  monthPages?: Readonly<Record<string, string>>;
};

/**
 * A publisher holding the captured decision date as the whole of September
 * 2025 and nothing in any other month. Records and documents answer with the
 * captured joined ruling whatever id is asked for.
 */
const stubPublisher = async (
  overrides: StubOverrides = {},
): Promise<Seen[]> => {
  const seen: Seen[] = [];
  const pages = overrides.monthPages ?? {
    "1": await fixtureText("pl-kio-listing-2025-09-01-p1.html"),
    "2": await fixtureText("pl-kio-listing-2025-09-01-p2.html"),
  };
  const detail = await fixtureText("pl-kio-detail-30308.html");
  const content = await gzFixtureText("pl-kio-content-30308.html.gz");
  globalThis.fetch = asFetchMock(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    seen.push({ url, body });
    if (url.endsWith("/Home/GetResults")) {
      if (overrides.listingStatus !== undefined) {
        return html("", overrides.listingStatus);
      }
      const form = new URLSearchParams(body);
      if (form.get("Dt") !== "01-09-2025 - 30-09-2025") {
        return html(listingPage(0, []));
      }
      // Past the last page the listing serves the last page again.
      return html(pages[form.get("Pg") ?? ""] ?? pages["2"] ?? "");
    }
    if (url.includes("/Home/Details/")) {
      return overrides.detailStatus === undefined
        ? html(detail)
        : html("<html>Brak strony</html>", overrides.detailStatus);
    }
    return overrides.contentStatus === undefined
      ? html(content)
      : html("<html>Brak strony</html>", overrides.contentStatus);
  });
  return seen;
};

const listingRequests = (seen: readonly Seen[]): URLSearchParams[] =>
  seen
    .filter(({ url }) => url.endsWith("/Home/GetResults"))
    .map(({ body }) => new URLSearchParams(body));

const presentMonth = (): string => new Date().toISOString().slice(0, 7);

describe("the crawl cursor", () => {
  test("round-trips the month, its offset and the tail", () => {
    const cursor = "2025-09:13+7";
    expect(parsePlKioCursor(cursor)).toEqual({
      month: "2025-09",
      offset: 13,
      tail: 7,
    });
    expect(encodePlKioCursor(parsePlKioCursor(cursor))).toBe(cursor);
  });

  test("a cursor nothing wrote starts at the first month the source serves", () => {
    expect(parsePlKioCursor(null)).toEqual({
      month: "2003-04",
      offset: 0,
      tail: 0,
    });
    expect(parsePlKioCursor("2025-13:0+0").month).toBe("2003-04");
  });
});

describe("walking a month", () => {
  test("a full page advances the offset inside the month", async () => {
    const seen = await stubPublisher();
    const page = await plKioAdapter.fetchPage("2025-09:0+4", {});
    expect(Result.isOk(page)).toBe(true);
    if (Result.isOk(page)) {
      expect(page.value.decisions).toHaveLength(10);
      expect(page.value.nextCursor).toBe("2025-09:10+4");
    }
    const [listing] = listingRequests(seen);
    expect(listing?.get("Srt")).toBe("date_asc");
    expect(listing?.get("Pg")).toBe("1");
  });

  test("a cursor inside a page resumes at the row it reached", async () => {
    const seen = await stubPublisher();
    const page = await plKioAdapter.fetchPage("2025-09:13+0", {});
    expect(Result.isOk(page)).toBe(true);
    if (Result.isOk(page)) {
      expect(page.value.decisions).toHaveLength(7);
      expect(page.value.nextCursor).toBe("2025-10:0+0");
    }
    expect(listingRequests(seen)[0]?.get("Pg")).toBe("2");
  });

  test("an offset at the count reads nothing from the page served again", async () => {
    const seen = await stubPublisher();
    const page = await plKioAdapter.fetchPage("2025-09:20+0", {});
    expect(Result.isOk(page)).toBe(true);
    if (Result.isOk(page)) {
      expect(page.value.decisions).toEqual([]);
    }
    expect(seen.some(({ url }) => url.includes("/Home/Details/"))).toBe(false);
  });

  test("a refused listing is the page's error and moves no cursor", async () => {
    await stubPublisher({ listingStatus: 503 });
    const page = await plKioAdapter.fetchPage("2025-09:0+0", {});
    expect(Result.isError(page)).toBe(true);
  });

  test("a page yielding fewer rows than its count promises fails rather than advancing", async () => {
    const full = await fixtureText("pl-kio-listing-2025-09-01-p1.html");
    // The count still says twenty; one row's markup is gone.
    const short = full.replace(
      /<div class="search-list-item"[\s\S]*?Wyświetl szczegóły<\/a>\s*<\/div>/u,
      "",
    );
    expect(readPlKioListing(short)?.rows).toHaveLength(9);
    await stubPublisher({ monthPages: { "1": short } });
    expect(
      Result.isError(await plKioAdapter.fetchPage("2025-09:0+0", {})),
    ).toBe(true);

    // Markup the reader no longer recognises yields no rows at all.
    await stubPublisher({
      monthPages: { "1": listingPage(3, ["<article>KIO 1/25</article>"]) },
    });
    expect(
      Result.isError(await plKioAdapter.fetchPage("2025-09:0+0", {})),
    ).toBe(true);
  });

  test("a record answering 404 is stored listing-only; any other refusal fails the page", async () => {
    await stubPublisher({ detailStatus: 404 });
    const gone = await plKioAdapter.fetchPage("2025-09:10+0", {});
    expect(Result.isOk(gone)).toBe(true);
    if (Result.isOk(gone)) {
      expect(gone.value.decisions.every((d) => d.isListingOnly === true)).toBe(
        true,
      );
    }

    await stubPublisher({ detailStatus: 403 });
    const refused = await plKioAdapter.fetchPage("2025-09:10+0", {});
    expect(Result.isError(refused)).toBe(true);
  });

  test("a document answering 404 keeps the record with no document; a 503 fails the page", async () => {
    await stubPublisher({ contentStatus: 404 });
    const gone = await plKioAdapter.fetchPage("2025-09:10+0", {});
    expect(Result.isOk(gone)).toBe(true);
    if (Result.isOk(gone)) {
      expect(gone.value.decisions).toHaveLength(10);
      for (const decision of gone.value.decisions) {
        expect(decision.isListingOnly).toBeUndefined();
        expect(decision.fulltext).toBeUndefined();
        expect(decision.metadata["presiding"]).toBe("Ewa Sikorska");
      }
    }

    await stubPublisher({ contentStatus: 503 });
    expect(
      Result.isError(await plKioAdapter.fetchPage("2025-09:10+0", {})),
    ).toBe(true);
  });

  test("a counted row without a record link is kept under a quarantine identity", async () => {
    const seen = await stubPublisher({
      monthPages: {
        "1": listingPage(2, [
          listingRow("30306", "KIO 2681/25", "01-09-2025").replace(
            'href="/Home/Details/30306"',
            'href="/Home/Details/"',
          ),
          listingRow("30308", "KIO 2845/25", "01-09-2025"),
        ]),
      },
    });
    const page = await plKioAdapter.fetchPage("2025-09:0+0", {});
    expect(Result.isOk(page)).toBe(true);
    if (!Result.isOk(page)) {
      return;
    }
    const [quarantined, keyed] = page.value.decisions;
    expect(quarantined?.sourceDocumentId).toStartWith("uzp-quarantine:");
    expect(quarantined?.isListingOnly).toBe(true);
    expect(quarantined?.metadata["quarantineReason"]).toBe("no-record-id");
    expect(quarantined?.caseNumber).toBe("KIO 2681/25");
    expect(keyed?.sourceDocumentId).toBe("30308");
    // Only the keyed row is asked for.
    expect(
      seen
        .filter(({ url }) => url.includes("/Home/Details/"))
        .map(({ url }) => url),
    ).toEqual(["https://orzeczenia.uzp.gov.pl/Home/Details/30308"]);
    expect(page.value.nextCursor).toBe("2025-10:0+0");

    // Once the link recovers, the keyed row names the quarantined one to adopt.
    const recovered = built(
      assemblePlKioDecision({
        item: {
          id: "30306",
          court: "Krajowa Izba Odwoławcza",
          documentType: "wyrok",
          signature: "KIO 2681/25",
          issueDate: "01-09-2025",
        },
        detailHtml: await fixtureText("pl-kio-detail-30308.html"),
        documentHtml: undefined,
      }),
    );
    expect(recovered.sourceDocumentIdRepairAliases).toHaveLength(1);
    expect(recovered.sourceDocumentIdRepairAliases?.[0]).toBe(
      quarantined?.sourceDocumentId,
    );
  });

  test("a row whose issuing body nobody states is quarantined unpublished and never blocks later rows", async () => {
    const plain = await fixtureText("pl-kio-detail-30308.html");
    const courtless = plain.replace(
      /<label aria-label="Organ wydający">[\s\S]*?<\/p>/u,
      "</p>",
    );
    const courtlessRow = listingRow(
      "30306",
      "KIO 2681/25",
      "01-09-2025",
    ).replace(/<label>Organ wydający:<\/label>[^<]*/u, "");
    globalThis.fetch = asFetchMock(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.endsWith("/Home/GetResults")) {
        return new URLSearchParams(body).get("Dt") === "01-09-2025 - 30-09-2025"
          ? html(
              listingPage(2, [
                courtlessRow,
                listingRow("30308", "KIO 2845/25", "01-09-2025"),
              ]),
            )
          : html(listingPage(0, []));
      }
      if (url.endsWith("/Home/Details/30306")) {
        return html(courtless);
      }
      return url.includes("/Home/Details/") ? html(plain) : html("");
    });

    const page = await plKioAdapter.fetchPage("2025-09:0+0", {});
    expect(Result.isOk(page)).toBe(true);
    if (!Result.isOk(page)) {
      return;
    }
    const [held, later] = page.value.decisions;
    expect(held?.sourceDocumentId).toBe("30306");
    expect(held?.isListingOnly).toBe(true);
    expect(held?.court).not.toBe("Krajowa Izba Odwoławcza");
    expect(held?.metadata["quarantineReason"]).toBe("court-not-stated");
    expect(later?.sourceDocumentId).toBe("30308");
    expect(later?.court).toBe("Krajowa Izba Odwoławcza");
    expect(later?.isListingOnly).toBeUndefined();
    expect(page.value.nextCursor).toBe("2025-10:0+0");

    // Reconciliation re-reads it and writes nothing until the body is stated.
    expect(
      await plKioAdapter.reconciliation.buildDecision({
        id: "30306",
        signature: "KIO 2681/25",
        issueDate: "01-09-2025",
      }),
    ).toEqual({ type: "detail-unavailable" });
  });
});

describe("walking the tail past the present month", () => {
  /**
   * A publisher whose months list nothing, with `dated` rows up to the
   * present month's end and `tail` rows after them: undated ones, in id order.
   */
  const stubTail = (dated: number, tail: readonly string[]): Seen[] => {
    const seen: Seen[] = [];
    const datedRows = Array.from({ length: dated }, (_, index) =>
      listingRow(String(100 + index), `KIO ${index + 1}/25`, "01-09-2025"),
    );
    const all = [...datedRows, ...tail];
    globalThis.fetch = asFetchMock(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      seen.push({ url, body });
      if (url.endsWith("/Home/GetResults")) {
        const form = new URLSearchParams(body);
        const range = form.get("Dt");
        // Unfiltered: everything; from 1900: the dated rows; a month: none.
        let rows: readonly string[] = [];
        if (range === null) {
          rows = all;
        } else if (range.startsWith("01-01-1900")) {
          rows = datedRows;
        }
        const pageNumber = Number(form.get("Pg"));
        const last = Math.max(1, Math.ceil(rows.length / 10));
        const served = Math.min(pageNumber, last);
        return html(
          listingPage(rows.length, rows.slice((served - 1) * 10, served * 10)),
        );
      }
      return url.includes("/Home/Details/")
        ? html(await fixtureText("pl-kio-detail-13694.html"))
        : html("");
    });
    return seen;
  };

  test("once the months are caught up, each parked cycle reads the tail and keeps its place", async () => {
    const parked = `${presentMonth()}:0+0`;
    stubTail(5, [
      listingRow("13694", "KIO 1090/20", "-"),
      listingRow("20846", "KIO 3766/24", "-"),
    ]);
    const first = await plKioAdapter.fetchPage(parked, {});
    expect(Result.isOk(first)).toBe(true);
    if (!Result.isOk(first)) {
      return;
    }
    expect(first.value.decisions.map((d) => d.sourceDocumentId)).toEqual([
      "13694",
      "20846",
    ]);
    expect(first.value.nextCursor).toBe(`${presentMonth()}:0+2`);

    // Nothing new: the cursor stands still and asks for no record.
    const quiet = stubTail(5, [
      listingRow("13694", "KIO 1090/20", "-"),
      listingRow("20846", "KIO 3766/24", "-"),
    ]);
    const idle = await plKioAdapter.fetchPage(`${presentMonth()}:0+2`, {});
    expect(Result.isOk(idle) && idle.value.nextCursor).toBe(
      `${presentMonth()}:0+2`,
    );
    expect(quiet.some(({ url }) => url.includes("/Home/Details/"))).toBe(false);

    // A dated arrival moves where the tail starts, not the place inside it;
    // an undated arrival appends and is read.
    stubTail(6, [
      listingRow("13694", "KIO 1090/20", "-"),
      listingRow("20846", "KIO 3766/24", "-"),
      listingRow("36100", "KIO 4001/26", "-"),
    ]);
    const next = await plKioAdapter.fetchPage(`${presentMonth()}:0+2`, {});
    expect(Result.isOk(next)).toBe(true);
    if (Result.isOk(next)) {
      expect(next.value.decisions.map((d) => d.sourceDocumentId)).toEqual([
        "36100",
      ]);
      expect(next.value.nextCursor).toBe(`${presentMonth()}:0+3`);
    }
  });
});

// ── Reconciliation and counts ────────────────────────────

describe("listing one issue date for reconciliation", () => {
  test("pages come from the stated count, and a page past it lists nothing", async () => {
    const seen = await stubPublisher();
    // The stub keys its answer on the month; a day slice asks for one day.
    globalThis.fetch = asFetchMock(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = typeof init?.body === "string" ? init.body : "";
      seen.push({ url, body });
      const pageNumber = new URLSearchParams(body).get("Pg");
      return html(
        await fixtureText(
          pageNumber === "1"
            ? "pl-kio-listing-2025-09-01-p1.html"
            : "pl-kio-listing-2025-09-01-p2.html",
        ),
      );
    });

    const walk = plKioAdapter.reconciliation;
    const first = await walk.listSlicePage({ slice: "2025-09-01", page: 0 });
    const past = await walk.listSlicePage({ slice: "2025-09-01", page: 2 });
    expect(first.totalPages).toBe(2);
    expect(first.items).toHaveLength(10);
    expect(first.items[0]?.identity).toEqual({
      type: "document",
      sourceDocumentId: "30306",
    });
    expect(past.items).toEqual([]);
    expect(listingRequests(seen).at(-2)?.get("Dt")).toBe(
      "01-09-2025 - 01-09-2025",
    );
  });

  test("the whole corpus's count is the listing's own", async () => {
    globalThis.fetch = asFetchMock(async () =>
      html(await fixtureText("pl-kio-listing-undated-p1.html")),
    );
    expect(await plKioAdapter.getTotalCount(AbortSignal.timeout(5000))).toEqual(
      { type: "count", total: 35_720 },
    );
  });
});
