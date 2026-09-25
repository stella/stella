/**
 * pl-tk against pages the Tribunal's portal served.
 *
 * The listing and case pages are captures, gzipped verbatim, each with a
 * provenance sidecar. Where a walk needs a listing larger than a capture, the
 * listing is generated in the print view's own markup, so the walk's
 * arithmetic is checked against rows whose positions are known.
 */

import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  assemblePlTkDecision,
  encodePlTkCursor,
  parsePlTkCursor,
  parsePlTkListingPage,
  PL_TK_PAGE_SIZE,
  PL_TK_QUARANTINE_PREFIX,
  plTkAdapter,
  plTkBatchWindow,
  plTkRawPartsOf,
} from "@/api/handlers/case-law/ingestion/adapters/pl-tk";
import type { PlTkListingRow } from "@/api/handlers/case-law/ingestion/adapters/pl-tk";
import { plConstitutionalTribunalRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-tk-ruling-keys";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const ADAPTER_FIXTURES = new URL("__fixtures__/", import.meta.url);
const PARSER_FIXTURES = new URL("../parsers/__fixtures__/", import.meta.url);

const gunzipText = async (url: URL): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(new Uint8Array(await Bun.file(url).arrayBuffer())),
  );

const listingFixture = async (name: string): Promise<string> =>
  await gunzipText(new URL(name, ADAPTER_FIXTURES));

const caseFixture = async (name: string): Promise<string> =>
  await gunzipText(new URL(name, PARSER_FIXTURES));

const decisionOf = (
  row: PlTkListingRow,
  casePage: string | undefined,
): IngestionResult => {
  const built = assemblePlTkDecision({
    row,
    casePage,
    rawParts: plTkRawPartsOf(row, casePage),
  });
  if (built.type === "unkeyable") {
    throw new Error("the row did not key");
  }
  return built.decision;
};

const rowFor = (overrides: Partial<PlTkListingRow>): PlTkListingRow => ({
  stage: "merits",
  documentId: "25564",
  caseId: "29150",
  caseNumber: "K 2/26",
  decisionForm: "Wyrok",
  decisionDate: "2026-06-25",
  subject: undefined,
  rowHtml: undefined,
  defect: undefined,
  ...overrides,
});

// ── A stubbed portal ─────────────────────────────────────

type SeenRequest = {
  url: URL;
  cookie: string | null;
  protocol: unknown;
  redirect: unknown;
};

type PortalOptions = {
  /** The print view's page for a 0-based index, or undefined past the end. */
  listingPage: (index: number) => string | undefined;
  /** The case page for a request's `dokument`, or the portal's own answer. */
  casePage?: (documentId: string, cookie: string | null) => string | Response;
  /** The filter the search answers with; defaults to echoing the request. */
  appliedFilter?: (requested: string | null) => string[];
};

const html = (body: string, cookies: string[] = []): Response => {
  const headers = new Headers({ "Content-Type": "text/html;charset=UTF-8" });
  for (const cookie of cookies) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(body, { headers });
};

const requestedFilter = (cookie: string | null): string[] =>
  (cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(
      (part) =>
        part.startsWith("Okres=") || part.startsWith("RodzajRozstrzygniecia="),
    );

const requestUrl = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/** The merits listing's first and last page, and nothing between. */
const meritsEnds =
  (first: string, last: string) =>
  (index: number): string | undefined => {
    if (index === 0) {
      return first;
    }
    return index === 149 ? last : undefined;
  };

/** A redirect as the portal sends one, to a path on its own origin. */
const redirectTo = (path: string): Response =>
  new Response("", {
    status: 302,
    headers: { Location: `https://ipo.trybunal.gov.pl${path}` },
  });

const installPortal = (options: PortalOptions): SeenRequest[] => {
  const seen: SeenRequest[] = [];
  let sessions = 0;
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(requestUrl(input));
      const cookie = new Headers(init?.headers).get("Cookie");
      seen.push({
        url,
        cookie,
        protocol:
          init === undefined ? undefined : Reflect.get(init, "protocol"),
        redirect: init?.redirect,
      });
      if (url.pathname === "/ipo/") {
        return await Promise.resolve(
          html("<html></html>", [
            `JSESSIONID="s${(sessions += 1)}.Internet-C:ipo"; Version=1; Path=/ipo; Secure; HttpOnly`,
          ]),
        );
      }
      if (url.pathname === "/ipo/Szukaj") {
        const applied = (options.appliedFilter ?? requestedFilter)(cookie);
        return await Promise.resolve(
          html(
            "<html></html>",
            applied.map((pair) => `${pair}; secure; HttpOnly`),
          ),
        );
      }
      if (url.pathname === "/ipo/SzukajDrukuj") {
        const page = options.listingPage(Number(url.searchParams.get("page")));
        return await Promise.resolve(
          page === undefined ? new Response("", { status: 500 }) : html(page),
        );
      }
      if (url.pathname === "/ipo/Sprawa" && options.casePage !== undefined) {
        const page = options.casePage(
          url.searchParams.get("dokument") ?? "",
          cookie,
        );
        return await Promise.resolve(
          typeof page === "string" ? html(page) : page,
        );
      }
      return await Promise.resolve(new Response("", { status: 404 }));
    },
  );
  return seen;
};

const originalFetch = globalThis.fetch;
const originalSleep = Bun.sleep;

beforeEach(() => {
  Bun.sleep = async () => {
    // Nothing here is live.
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Bun.sleep = originalSleep;
});

// ── The print view ───────────────────────────────────────

describe("the print view's listing", () => {
  test("a full page: ids, dockets, forms, dates and the subject line", async () => {
    const page = parsePlTkListingPage(
      await listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      "merits",
    );

    expect(page?.page).toBe(1);
    expect(page?.totalPages).toBe(150);
    expect(page?.rows).toHaveLength(PL_TK_PAGE_SIZE);
    expect(page?.rows[0]).toMatchObject({
      stage: "merits",
      documentId: "25704",
      caseId: "27575",
      caseNumber: "P 1/24",
      decisionForm: "Wyrok",
      decisionDate: "2026-08-13",
      subject: undefined,
      defect: undefined,
    });
    expect(page?.rows[0]?.rowHtml).toStartWith('<tr data-ri="0"');
    expect(page?.rows[0]?.rowHtml).toContain(
      '<span class="sygnatura">P 1/24</span>',
    );
    expect(page?.rows[1]).toMatchObject({
      stage: "merits",
      documentId: "25657",
      caseId: "27924",
      caseNumber: "K 21/24",
      decisionForm: "Postanowienie - umorzenie",
      decisionDate: "2026-08-12",
      subject: "Tryb uchwalenia ustawy",
    });
  });

  test("every row of the oldest page dates, including a padded day", async () => {
    const page = parsePlTkListingPage(
      await listingFixture("pl-tk-listing-merits-page-149.html.gz"),
      "merits",
    );

    expect(page?.rows.every((row) => row.decisionDate !== undefined)).toBe(
      true,
    );
    expect(
      page?.rows.find((row) => row.caseNumber === "Uw 6/88")?.decisionDate,
    ).toBe("1988-09-20");
    expect(page?.rows.at(-1)?.caseNumber).toBe("U 1/86");
  });

  test("the last page of a stage is short, and says it is the last", async () => {
    const page = parsePlTkListingPage(
      await listingFixture("pl-tk-listing-preliminary-page-414.html.gz"),
      "preliminary",
    );

    expect(page?.page).toBe(415);
    expect(page?.totalPages).toBe(415);
    expect(page?.rows).toHaveLength(18);
    expect(page?.rows[0]?.decisionForm).toBe("Postanowienie o odmowie");
  });

  test("the portal's search shell is not an empty listing", () => {
    expect(
      parsePlTkListingPage("<html><body><form></form></body></html>", "merits"),
    ).toBeNull();
  });
});

// ── Counting from the old end ────────────────────────────

describe("the crawl's window over a newest-first listing", () => {
  /** Ruling ids newest first, as the print view orders them. */
  const idsAt = (
    listing: readonly string[],
    read: number,
    batch: number,
  ): string[] => {
    const window = plTkBatchWindow({ batch, read, total: listing.length });
    if (window === null) {
      return [];
    }
    const ids: string[] = [];
    for (let offset = window.from; offset >= window.to; offset -= 1) {
      ids.push(listing[window.page * PL_TK_PAGE_SIZE + offset] ?? "?");
    }
    return ids;
  };

  const oldestFirst = Array.from({ length: 60 }, (_, index) => `r${index}`);
  const newestFirst = oldestFirst.toReversed();

  test("walks the whole listing oldest first, each ruling once", () => {
    const walked: string[] = [];
    let read = 0;
    for (;;) {
      const ids = idsAt(newestFirst, read, 10);
      if (ids.length === 0) {
        break;
      }
      walked.push(...ids);
      read += ids.length;
    }

    expect(walked).toEqual(oldestFirst);
  });

  test("a batch never leaves the page it starts on", () => {
    // 60 rows: the oldest page holds 10, so the first batch is those 10.
    expect(plTkBatchWindow({ batch: 25, read: 0, total: 60 })).toEqual({
      page: 2,
      from: 9,
      to: 0,
    });
    expect(plTkBatchWindow({ batch: 25, read: 10, total: 60 })).toEqual({
      page: 1,
      from: 24,
      to: 0,
    });
    expect(plTkBatchWindow({ batch: 10, read: 60, total: 60 })).toBeNull();
  });

  test("rulings published between two pages do not move the resume point", () => {
    const before = idsAt(newestFirst, 20, 10);
    const published = ["n2", "n1", ...newestFirst];

    expect(idsAt(published, 20, 10)).toEqual(before);
  });
});

describe("the crawl cursor", () => {
  test("round-trips, and anything else starts at the merits' oldest ruling", () => {
    const cursor = {
      stage: "signalling",
      read: { merits: 3750, signalling: 12, preliminary: 0 },
    } as const;
    expect(parsePlTkCursor(encodePlTkCursor(cursor))).toEqual(cursor);
    expect(encodePlTkCursor(parsePlTkCursor(null))).toBe("merits:0,0,0");
    expect(encodePlTkCursor(parsePlTkCursor("verdicts:1,2,3"))).toBe(
      "merits:0,0,0",
    );
  });
});

describe("a crawl page against the portal", () => {
  test("reads the stage's oldest rulings first, over HTTP/2, one case page per case", async () => {
    const [first, last, oldestCase] = await Promise.all([
      listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      listingFixture("pl-tk-listing-merits-page-149.html.gz"),
      caseFixture("pl-tk-case-u-1-86.html.gz"),
    ]);
    const seen = installPortal({
      listingPage: meritsEnds(first, last),
      casePage: () => oldestCase,
    });

    const result = await plTkAdapter.fetchPage(null, {});
    if (Result.isError(result)) {
      throw result.error;
    }
    const { decisions, nextCursor } = result.value;

    expect(nextCursor).toBe("merits:10,0,0");
    expect(decisions.map((decision) => decision.sourceDocumentId)).toEqual([
      "4980",
      "5024",
      "131",
      "842",
      "5005",
      "5064",
      "5043",
      "843",
      "5739",
      "132",
    ]);
    // The oldest ruling is on the served case page; the others are not, and
    // stay listing-only rows the reconciliation will fetch again.
    expect(decisions[0]?.isListingOnly).toBeUndefined();
    expect(decisions[0]?.decisionType).toBe("orzeczenie");
    expect(decisions[1]?.isListingOnly).toBe(true);

    // K 1/87 has two rulings on this page; its case page is read once.
    const casePages = seen.filter(
      (request) => request.url.pathname === "/ipo/Sprawa",
    );
    expect(casePages).toHaveLength(9);
    expect(
      seen.every(
        (request) => request.url.origin === "https://ipo.trybunal.gov.pl",
      ),
    ).toBe(true);
    expect(seen.every((request) => request.protocol === "http2")).toBe(true);
    expect(seen.every((request) => request.redirect === "error")).toBe(true);
    const listing = seen.find(
      (request) => request.url.pathname === "/ipo/SzukajDrukuj",
    );
    expect(listing?.cookie).toContain("Okres=Since1986");
    expect(listing?.cookie).toContain("RodzajRozstrzygniecia=300");
  });

  test("a case the portal sends to its error page is kept listing-only and passed", async () => {
    const [first, last, oldestCase] = await Promise.all([
      listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      listingFixture("pl-tk-listing-merits-page-149.html.gz"),
      caseFixture("pl-tk-case-u-1-86.html.gz"),
    ]);
    installPortal({
      listingPage: meritsEnds(first, last),
      casePage: (documentId) =>
        documentId === "5024"
          ? redirectTo("/ipo/exception/exception.xhtml")
          : oldestCase,
    });

    const result = await plTkAdapter.fetchPage(null, {});
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value.nextCursor).toBe("merits:10,0,0");
    const unrendered = result.value.decisions.find(
      (decision) => decision.sourceDocumentId === "5024",
    );
    expect(unrendered?.isListingOnly).toBe(true);
    expect(unrendered?.caseNumber).toBe("U 3/86");
    expect(
      decodeSourceRawEnvelope(unrendered?.sourceRaw ?? "")?.["case-page"],
    ).toBeUndefined();
  });

  test("a transport failure on a case page holds the cursor", async () => {
    const [first, last] = await Promise.all([
      listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      listingFixture("pl-tk-listing-merits-page-149.html.gz"),
    ]);
    installPortal({
      listingPage: meritsEnds(first, last),
      casePage: () => {
        throw new TypeError("connection reset");
      },
    });

    const result = await plTkAdapter.fetchPage(null, {});

    expect(Result.isError(result)).toBe(true);
  });

  test("a caught-up stage hands over to the next without reading a case", async () => {
    const [first, last] = await Promise.all([
      listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      listingFixture("pl-tk-listing-merits-page-149.html.gz"),
    ]);
    const seen = installPortal({
      listingPage: meritsEnds(first, last),
    });

    const result = await plTkAdapter.fetchPage("merits:3750,4,7", {});

    expect(Result.isOk(result) && result.value.decisions).toEqual([]);
    expect(Result.isOk(result) && result.value.nextCursor).toBe(
      "signalling:3750,4,7",
    );
    expect(seen.some((request) => request.url.pathname === "/ipo/Sprawa")).toBe(
      false,
    );
  });

  test("a search the portal answered with another filter is refused", async () => {
    const first = await listingFixture("pl-tk-listing-merits-page-0.html.gz");
    installPortal({
      listingPage: () => first,
      appliedFilter: () => ["Okres=Since10_1997"],
    });

    const result = await plTkAdapter.fetchPage(null, {});

    expect(Result.isError(result)).toBe(true);
  });

  test("a lapsed session's shell is a failure, not the end of the listing", async () => {
    installPortal({ listingPage: () => "<html><body></body></html>" });

    const result = await plTkAdapter.fetchPage("preliminary:0,0,0", {});

    expect(Result.isError(result)).toBe(true);
  });
});

// ── Reconciliation by year ───────────────────────────────

/** A print-view page in the portal's markup, from rows newest first. */
const printViewPage = (
  rows: readonly { id: string; date: string }[],
  page: number,
  totalPages: number,
): string => {
  const months = [
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
  ];
  const body = rows
    .map(({ date, id }, index) => {
      const [year = "", month = "", day = ""] = date.split("-");
      const printed = `${Number(day)} ${months[Number(month) - 1] ?? ""} ${year}`;
      return `<tr data-ri="${index}"><td><div id="wyszukiwanie:dataTable:${index}:dokument_:dokument"><a href="/ipo/Sprawa?cid=1&amp;dokument=${id}&amp;sprawa=${id}"><span class="sygnatura">Ts ${id}/00</span></a>
<br />Postanowienie o odmowie z dnia ${printed} r.
<br /></div></td></tr>`;
    })
    .join("");
  return `<html><body><span>Strona wyników: ${page} z ${totalPages}</span><table><tbody id="wyszukiwanie:dataTable_data">${body}</tbody></table></body></html>`;
};

describe("a year slice", () => {
  // Three rulings a month from 1994 to 2026, newest first, so years straddle
  // page breaks at every alignment.
  const rulings = Array.from({ length: 33 * 12 * 3 }, (_, index) => {
    const month = Math.floor(index / 3);
    const year = 1994 + Math.floor(month / 12);
    const date = `${year}-${String((month % 12) + 1).padStart(2, "0")}-${String(1 + (index % 3) * 9).padStart(2, "0")}`;
    return { id: String(index + 1), date };
  }).toReversed();
  const totalPages = Math.ceil(rulings.length / PL_TK_PAGE_SIZE);
  const pageAt = (index: number): string | undefined =>
    index < totalPages
      ? printViewPage(
          rulings.slice(index * PL_TK_PAGE_SIZE, (index + 1) * PL_TK_PAGE_SIZE),
          index + 1,
          totalPages,
        )
      : undefined;

  test("lists every ruling of the year and nothing else, found by bisection", async () => {
    const seen = installPortal({ listingPage: pageAt });

    const listed = await plTkAdapter.reconciliation.listSlicePage({
      slice: "2005",
      page: 2,
    });

    const expected = rulings
      .filter(({ date }) => date.startsWith("2005-"))
      .map(({ id }) => id);
    expect(expected).toHaveLength(36);
    expect(
      listed.items.map((item) =>
        item.identity.type === "document" ? item.identity.sourceDocumentId : "",
      ),
    ).toEqual(expected);
    expect(listed.totalPages).toBe(3);
    const listingReads = seen.filter(
      (request) => request.url.pathname === "/ipo/SzukajDrukuj",
    ).length;
    expect(listingReads).toBeLessThan(totalPages / 4);
  });

  test("the slice's pages are the three stages", async () => {
    const seen = installPortal({ listingPage: pageAt });

    await plTkAdapter.reconciliation.listSlicePage({ slice: "2005", page: 1 });

    const search = seen.find(
      (request) => request.url.pathname === "/ipo/Szukaj",
    );
    expect(search?.cookie).toContain("RodzajRozstrzygniecia=700");
  });
});

// ── Building a ruling ────────────────────────────────────

describe("a ruling built from its case page", () => {
  test("the bench by function, and the dissenter the text names", async () => {
    const decision = decisionOf(
      rowFor({}),
      await caseFixture("pl-tk-case-k-2-26.html.gz"),
    );

    expect(decision.judges).toEqual([
      { role: "presiding", nameAsPrinted: "Bartłomiej Sochański" },
      { role: "panel-member", nameAsPrinted: "Stanisław Piotrowicz" },
      { role: "panel-member", nameAsPrinted: "Bogdan Święczkowski" },
      { role: "rapporteur", nameAsPrinted: "Wojciech Sych" },
      { role: "panel-member", nameAsPrinted: "Andrzej Zielonacki" },
      { role: "dissenting", nameAsPrinted: "Andrzej Zielonacki" },
    ]);
    expect(decision.metadata["dissentingOpinions"]).toEqual([
      "sędziego TK Andrzeja Zielonackiego",
    ]);
    expect(decision.court).toBe("Trybunał Konstytucyjny");
    expect(decision.decisionType).toBe("wyrok");
    expect(decision.metadata["publications"]).toEqual([
      {
        text: "OTK ZU A/2026, poz. 83",
        links: [
          {
            text: "OTK ZU A/2026, poz. 83",
            url: "https://otkzu.trybunal.gov.pl/2026/A/83",
          },
        ],
      },
    ]);
    expect(decision.fulltext).toContain(
      "Z powyższych przyczyn zdecydowałem się na zgłoszenie zdania odrębnego.",
    );
  });

  test("keyed by the portal's document id: two rulings of one case are two rows", async () => {
    const page = await caseFixture("pl-tk-case-sk-14-11.html.gz");
    const judgment = decisionOf(
      rowFor({ documentId: "9897", caseId: undefined, caseNumber: "SK 14/11" }),
      page,
    );
    const costs = decisionOf(
      rowFor({ documentId: "9895", caseId: undefined, caseNumber: "SK 14/11" }),
      page,
    );

    expect(judgment.sourceDocumentId).toBe("9897");
    expect(costs.sourceDocumentId).toBe("9895");
    expect(judgment.caseNumber).toBe(costs.caseNumber);
    expect(judgment.metadata["decisionForm"]).toBe("Wyrok");
    expect(costs.metadata["decisionForm"]).toBe("Postanowienie dot. kosztów");
    expect(judgment.metadata["joinedCases"]).toEqual(["SK 42/12"]);
    expect(costs.metadata["joinedCases"]).toEqual(["SK 42/12"]);
  });

  test("the same payloads build the same row, and a replay of its envelope builds it again", async () => {
    const page = await caseFixture("pl-tk-case-k-44-16.html.gz");
    const row = rowFor({
      documentId: "16940",
      caseId: "17892",
      caseNumber: "K 44/16",
      decisionForm: "Rozstrzygnięcie",
      decisionDate: "2016-11-07",
    });
    const decision = decisionOf(row, page);

    expect(decisionOf(row, page).rawHash).toBe(decision.rawHash);
    expect(decodeSourceRawEnvelope(decision.sourceRaw ?? "")).toEqual({
      listing: JSON.stringify(row),
      "case-page": page,
    });

    const replayed = await plTkAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: decision.caseNumber,
      sourceDocumentId: "16940",
      language: "pl",
      court: decision.court,
      ecli: null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });
    expect(replayed).toEqual({ type: "parsed", result: decision });
    expect(decision.metadata["footnotes"]).toEqual([
      expect.stringContaining("Rozstrzygnięcie wydane z naruszeniem przepisów"),
      expect.stringContaining("Powołane orzeczenia TK"),
    ]);
  });

  test("a case page without the listed ruling leaves a listing-only row", async () => {
    const built = assemblePlTkDecision({
      row: rowFor({ documentId: "1" }),
      casePage: await caseFixture("pl-tk-case-k-2-26.html.gz"),
      rawParts: {},
    });

    expect(built.type).toBe("detail-unavailable");
  });
});

// ── Inventory ────────────────────────────────────────────

describe("the fields a case page states", () => {
  const undeclared = (page: string): string[] => {
    const stated = plTkAdapter.sourceFields.listSourceFields({
      "case-page": page,
    });
    if (!Array.isArray(stated)) {
      throw new TypeError("the inventory reads synchronously");
    }
    return stated.filter(
      (field: string) => plTkAdapter.sourceFields.fields[field] === undefined,
    );
  };

  test("every label on every captured case page is declared", async () => {
    for (const name of [
      "pl-tk-case-k-2-26.html.gz",
      "pl-tk-case-k-44-16.html.gz",
      "pl-tk-case-sk-14-11.html.gz",
      "pl-tk-case-ts-70-24.html.gz",
      "pl-tk-case-u-1-86.html.gz",
      "pl-tk-case-w-3-94.html.gz",
    ]) {
      expect(undeclared(await caseFixture(name))).toEqual([]);
    }
  });

  test("a label the portal adds is reported, not dropped", async () => {
    const page = (await caseFixture("pl-tk-case-k-2-26.html.gz")).replace(
      '<div class="prop">',
      '<div class="prop"><span class="name">Sygnatura ECLI</span><span class="value">ECLI:PL:TK:2026:K.2.26</span></div><div class="prop">',
    );

    expect(undeclared(page)).toEqual(["Sygnatura ECLI"]);
  });
});

// ── The same ruling in SAOS ──────────────────────────────

/** The one key a Tribunal row with this docket, date and kind carries. */
const tkKey = ({
  caseNumber,
  decisionDate,
  decisionType,
}: {
  caseNumber: string;
  decisionDate: string;
  decisionType: string;
}): string | undefined =>
  plConstitutionalTribunalRulingKeys({
    caseNumber,
    court: "Trybunał Konstytucyjny",
    decisionDate,
    decisionType,
  }).at(0);

describe("the key a SAOS row and a portal row share", () => {
  test("docket spelling and the pre-1997 name of a judgment do not split it", () => {
    expect(
      tkKey({
        caseNumber: "U. 4/86",
        decisionDate: "1986-12-03",
        decisionType: "postanowienie",
      }),
    ).toBe(
      tkKey({
        caseNumber: "U 4/86",
        decisionDate: "1986-12-03",
        decisionType: "postanowienie",
      }),
    );
    expect(
      tkKey({
        caseNumber: "K 1/86",
        decisionDate: "1986-07-14",
        decisionType: "wyrok",
      }),
    ).toBe(
      tkKey({
        caseNumber: "K 1/86",
        decisionDate: "1986-07-14",
        decisionType: "orzeczenie",
      }),
    );
  });

  test("another day or another kind of ruling in the same case is another key", () => {
    const judgment = tkKey({
      caseNumber: "K 1/87",
      decisionDate: "1987-04-22",
      decisionType: "orzeczenie",
    });

    expect(
      tkKey({
        caseNumber: "K 1/87",
        decisionDate: "1987-04-01",
        decisionType: "postanowienie",
      }),
    ).not.toBe(judgment);
    expect(
      tkKey({
        caseNumber: "K 1/87",
        decisionDate: "1987-04-22",
        decisionType: "postanowienie",
      }),
    ).not.toBe(judgment);
  });

  test("is stored on the portal's row", async () => {
    const decision = decisionOf(
      rowFor({}),
      await caseFixture("pl-tk-case-k-2-26.html.gz"),
    );

    expect(decision.metadata["rulingKeys"]).toEqual([
      "tk|k 2/26|2026-06-25|wyrok",
    ]);
  });
});

// ── Rows the listing cannot read ─────────────────────────

describe("a listed row the parser cannot read", () => {
  /** The captured last page with one row's link to its case removed. */
  const brokenLastPage = async (): Promise<string> =>
    (
      await listingFixture("pl-tk-listing-preliminary-page-414.html.gz")
    ).replace(
      'href="/ipo/Sprawa?cid=1&amp;dokument=1669&amp;sprawa=633"',
      'href="#"',
    );

  test("is kept, counted and addressed by its own markup", async () => {
    const listingHtml = await brokenLastPage();
    const page = parsePlTkListingPage(listingHtml, "preliminary");
    const broken = page?.rows[3];

    // The short last page still states every row it holds, so the stage's
    // total is not read one short.
    expect(page?.rows).toHaveLength(18);
    expect(broken?.defect).toBe("unparseable-row");
    expect(broken?.documentId).toStartWith(PL_TK_QUARANTINE_PREFIX);
    expect(broken?.caseNumber).toBe("Ts 10/97");
    expect(broken?.rowHtml).toContain('href="#"');
    // The same markup is the same identity on every walk.
    expect(
      parsePlTkListingPage(listingHtml, "preliminary")?.rows[3]?.documentId,
    ).toBe(broken?.documentId);
  });

  test("is stored listing-only with its verbatim row, without a case page request", async () => {
    const page = parsePlTkListingPage(await brokenLastPage(), "preliminary");
    const row = page?.rows[3];
    if (row === undefined) {
      throw new Error("the page lost its fourth row");
    }
    const seen = installPortal({ listingPage: () => undefined });

    const built = await plTkAdapter.reconciliation.buildDecision(row);
    const stored = assemblePlTkDecision({
      row,
      casePage: undefined,
      rawParts: plTkRawPartsOf(row, undefined),
    });

    // Held back rather than built: the engine refuses a detail-less row.
    expect(built.type).toBe("detail-unavailable");
    expect(seen.some((request) => request.url.pathname === "/ipo/Sprawa")).toBe(
      false,
    );
    if (stored.type === "unkeyable") {
      throw new Error("the quarantined row did not key");
    }
    expect(stored.type).toBe("detail-unavailable");
    expect(stored.decision.isListingOnly).toBe(true);
    expect(stored.decision.metadata["listingDefect"]).toBe("unparseable-row");
    expect(stored.decision.sourceRaw).toContain(
      JSON.stringify(JSON.stringify(row.rowHtml)).slice(3, -3),
    );
  });

  test("a row stating no docket is stored under a placeholder docket", () => {
    const built = assemblePlTkDecision({
      row: rowFor({
        documentId: `${PL_TK_QUARANTINE_PREFIX}abc`,
        caseNumber: undefined,
        decisionForm: undefined,
        defect: "unparseable-row",
        rowHtml: "<tr><td>?</td></tr>",
      }),
      casePage: undefined,
      rawParts: {},
    });

    expect(
      built.type !== "unkeyable" && built.decision.caseNumberIsPlaceholder,
    ).toBe(true);
  });
});

// ── The listing row in the envelope ──────────────────────

describe("the stored envelope", () => {
  test("keeps the print view's markup of the row beside the case page", async () => {
    const page = parsePlTkListingPage(
      await listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      "merits",
    );
    const row = page?.rows[2];
    if (row?.rowHtml === undefined) {
      throw new Error("the row kept no markup");
    }
    const decision = decisionOf(
      row,
      await caseFixture("pl-tk-case-k-2-26.html.gz"),
    );
    const listing: unknown = JSON.parse(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.["listing"] ?? "null",
    );

    expect(listing).toMatchObject({ rowHtml: row.rowHtml });
    expect(row.rowHtml).toContain("Wyrok z dnia 25 czerwca 2026 r.");
  });
});

// ── The deciding court ───────────────────────────────────

describe("the deciding court", () => {
  test("is the one the ruling's bench line names", async () => {
    const decision = decisionOf(
      rowFor({}),
      await caseFixture("pl-tk-case-k-2-26.html.gz"),
    );

    expect(decision.court).toBe("Trybunał Konstytucyjny");
    expect(decision.metadata["quarantineReason"]).toBeUndefined();
  });

  test("a ruling naming another court is quarantined, not filed as the Tribunal's", async () => {
    const page = (await caseFixture("pl-tk-case-k-2-26.html.gz")).replace(
      "Trybunał  Konstytucyjny w składzie:",
      "Sąd Najwyższy w składzie:",
    );
    const built = assemblePlTkDecision({
      row: rowFor({}),
      casePage: page,
      rawParts: plTkRawPartsOf(rowFor({}), page),
    });

    expect(built.type).toBe("detail-unavailable");
    expect(
      built.type === "unkeyable" ? undefined : built.decision.metadata,
    ).toMatchObject({
      quarantineReason: "court-not-stated",
      courtAsPrinted: "Sąd Najwyższy",
    });
  });

  test("without a served text, the docket's register names it, or nothing does", () => {
    const reasonFor = (caseNumber: string): unknown => {
      const built = assemblePlTkDecision({
        row: rowFor({ caseNumber }),
        casePage: undefined,
        rawParts: {},
      });
      return built.type === "unkeyable"
        ? "unkeyable"
        : built.decision.metadata["quarantineReason"];
    };

    expect(reasonFor("Ts 70/24")).toBeUndefined();
    expect(reasonFor("II CSK 1/20")).toBe("court-not-stated");
  });
});

// ── Redirects from a case page ───────────────────────────

describe("a case page that redirects", () => {
  const listingEnds = async (): Promise<
    (index: number) => string | undefined
  > => {
    const [first, last] = await Promise.all([
      listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      listingFixture("pl-tk-listing-merits-page-149.html.gz"),
    ]);
    return meritsEnds(first, last);
  };

  test("anywhere but the error page: a fresh session, and the ruling is read", async () => {
    const oldestCase = await caseFixture("pl-tk-case-u-1-86.html.gz");
    const seen = installPortal({
      listingPage: await listingEnds(),
      // The first session lapses before the case pages are asked for.
      casePage: (_, cookie) =>
        cookie?.includes('"s1.') === true
          ? redirectTo("/ipo/Szukaj?cid=1")
          : oldestCase,
    });

    const result = await plTkAdapter.fetchPage(null, {});
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value.decisions[0]?.sourceDocumentId).toBe("4980");
    expect(result.value.decisions[0]?.isListingOnly).toBeUndefined();
    expect(
      seen.filter((request) => request.url.pathname === "/ipo/").length,
    ).toBe(2);
  });

  test("a redirect with a fresh session too is the case's own: listing-only", async () => {
    const seen = installPortal({
      listingPage: await listingEnds(),
      casePage: () => redirectTo("/ipo/exception/exception.xhtml"),
    });

    const result = await plTkAdapter.fetchPage(null, {});
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value.nextCursor).toBe("merits:10,0,0");
    expect(
      result.value.decisions.every((decision) => decision.isListingOnly),
    ).toBe(true);
    // One reopened session per ruling that redirected.
    expect(
      seen.filter((request) => request.url.pathname === "/ipo/").length,
    ).toBe(11);
  });

  test("a redirect on the listing itself fails the page", async () => {
    installPortal({ listingPage: () => undefined });
    globalThis.fetch = asFetchMock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(requestUrl(input));
        if (url.pathname === "/ipo/SzukajDrukuj") {
          return await Promise.resolve(redirectTo("/ipo/Szukaj?cid=1"));
        }
        const cookie = new Headers(init?.headers).get("Cookie");
        return await Promise.resolve(
          html(
            "<html></html>",
            [
              url.pathname === "/ipo/"
                ? 'JSESSIONID="s1.Internet-C:ipo"; Path=/ipo'
                : "",
              ...requestedFilter(cookie),
            ].filter((header) => header.length > 0),
          ),
        );
      },
    );

    const result = await plTkAdapter.fetchPage(null, {});

    expect(Result.isError(result)).toBe(true);
  });
});

describe("an unreadable row pushed down the listing", () => {
  test("keeps its audit id, and its verbatim markup in the envelope", async () => {
    const atThree = (
      await listingFixture("pl-tk-listing-preliminary-page-414.html.gz")
    ).replace(
      'href="/ipo/Sprawa?cid=1&amp;dokument=1669&amp;sprawa=633"',
      'href="#"',
    );
    // Seven rulings published since: the same row, seven places further on,
    // with its row index, the ids numbered by it and the striping moved.
    const atTen = atThree
      .replaceAll("10353", "10360")
      .replace(
        '<tr data-ri="10360" class="ui-widget-content ui-datatable-odd"',
        '<tr data-ri="10360" class="ui-widget-content ui-datatable-even"',
      );

    const before = parsePlTkListingPage(atThree, "preliminary")?.rows[3];
    const after = parsePlTkListingPage(atTen, "preliminary")?.rows[3];

    expect(before?.documentId).toStartWith(PL_TK_QUARANTINE_PREFIX);
    expect(after?.documentId).toBe(before?.documentId);
    expect(after?.rowHtml).not.toBe(before?.rowHtml);
    expect(after?.rowHtml).toContain('data-ri="10360"');
  });
});

describe("a redirect the fetch refuses to follow", () => {
  test("reads as a redirect, not a transport failure", async () => {
    const [first, last] = await Promise.all([
      listingFixture("pl-tk-listing-merits-page-0.html.gz"),
      listingFixture("pl-tk-listing-merits-page-149.html.gz"),
    ]);
    installPortal({
      listingPage: meritsEnds(first, last),
      casePage: () => {
        // What Bun raises for a redirect under `redirect: "error"`.
        throw Object.assign(new TypeError("unexpected redirect"), {
          code: "UnexpectedRedirect",
        });
      },
    });

    const result = await plTkAdapter.fetchPage(null, {});
    if (Result.isError(result)) {
      throw result.error;
    }

    expect(result.value.decisions).toHaveLength(10);
    expect(
      result.value.decisions.every((decision) => decision.isListingOnly),
    ).toBe(true);
  });
});

describe("the cross-source key and the shared docket grammar", () => {
  test("a docket the grammar does not read as the Tribunal's has no key", () => {
    expect(
      tkKey({
        caseNumber: "II CSK 1/20",
        decisionDate: "2020-01-01",
        decisionType: "wyrok",
      }),
    ).toBeUndefined();
  });
});
