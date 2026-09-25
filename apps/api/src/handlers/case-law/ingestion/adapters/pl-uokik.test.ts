/**
 * pl-uokik against rows and pages the register actually served.
 *
 * The view fixtures are three verbatim reads of the flat decision view: its
 * head (the rows stating no date, then the newest decisions), decision year
 * 2011 with one row of each neighbouring year, and five rows of 2009. The
 * model below serves them as one view in the register's own order, renumbered,
 * and answers `Start`, `Count` and `NavigateReverse` the way Domino does. The
 * decision pages and the PDF are the register's own responses.
 */

import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import { plCommonCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-ncourt";
import { plSupremeCourtRulingKeys } from "@/api/handlers/case-law/ingestion/adapters/pl-sn-ruling-keys";
import {
  assemblePlUokikDecision,
  encodePlUokikCursor,
  listPlUokikSourceFields,
  normalizePlUokikRow,
  parsePlUokikCursor,
  parsePlUokikDetail,
  PL_UOKIK_DETAIL_STATUS,
  PL_UOKIK_DOCUMENT_ABSENCE,
  PL_UOKIK_FILE_STATUS,
  PL_UOKIK_UNDATED_SLICE,
  plUokikAdapter,
  plUokikDayOfDetailDate,
  plUokikDayOfPrinted,
  plUokikFileUrl,
  plUokikListingIdentity,
  plUokikNextSlice,
  plUokikPreviousSlice,
  plUokikRawPartsOf,
  plUokikRulingId,
  plUokikSortKey,
  readPlUokikView,
} from "@/api/handlers/case-law/ingestion/adapters/pl-uokik";
import { PL_UOKIK_RULING_UNREAD } from "@/api/handlers/case-law/ingestion/parsers/pl-uokik";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord } from "@/api/lib/type-guards";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const PDF_FIXTURE = new URL(
  "../parsers/__fixtures__/pl-uokik-dok-9-2011.pdf",
  import.meta.url,
);

/** DOK-9/2011: a decision PDF and two court rulings on its appeal. */
const WITH_RULINGS = "2520D55B0F17A317C1257EC6007B9773";
/** DIH-4/2009: filed with no attachment. */
const FILELESS = "9C652284E9A4958DC1257EC6007B8BE1";
/** A record stating no number, date or file. */
const NUMBERLESS = "F4CBED47F0C2CF91C1258CA7001CB570";
/** DOK-2/2024: under appeal. */
const APPEALED = "71C0A3DFE2EB6946C1258BF0003D546A";

const PRESIDENT = "Prezes Urzędu Ochrony Konkurencji i Konsumentów";

type Entry = Record<string, unknown>;

const entriesOf = (view: unknown): Entry[] => {
  const listed = isRecord(view) ? view["viewentry"] : undefined;
  return Array.isArray(listed) ? listed.filter(isRecord) : [];
};

/** The three captured reads, in the register's own order. */
const capturedEntries = async (): Promise<Entry[]> => {
  const head = entriesOf(
    await Bun.file(new URL("pl-uokik-view-head.json", FIXTURES)).json(),
  );
  const year2011 = entriesOf(
    await readGzipJson(new URL("pl-uokik-view-2011.json.gz", FIXTURES)),
  );
  const window2009 = entriesOf(
    await Bun.file(new URL("pl-uokik-view-2009-window.json", FIXTURES)).json(),
  );
  return [...head, ...year2011, ...window2009];
};

const pageOf = async (unid: string): Promise<string> =>
  await Bun.file(
    new URL(`pl-uokik-detail-${unid.toLowerCase()}.html`, FIXTURES),
  ).text();

const pdfBytes = async (): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(PDF_FIXTURE).arrayBuffer());

const unidOf = (entry: Entry): string =>
  typeof entry["@unid"] === "string" ? entry["@unid"] : "";

const entryOf = (entries: readonly Entry[], unid: string): Entry =>
  entries.find((entry) => unidOf(entry) === unid) ??
  panic(`the view fixtures lost ${unid}`);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The first decision file a captured page links, by name. */
const decisionFileOf = async (unid: string): Promise<string> =>
  parsePlUokikDetail(await pageOf(unid))?.fields.find(
    ({ label }) => label === "Decyzja",
  )?.files[0]?.name ?? panic(`${unid} links no decision file`);

// ── A model of the register ──────────────────────────────

type RegisterModel = {
  /** The view's rows, newest decision date first, as the register sorts it. */
  entries: Entry[];
  pages: Map<string, string>;
  files: Map<string, Uint8Array>;
  requests: URL[];
  /** How every decision page is answered, in place of `pages`. */
  pageAnswer?: ((unid: string) => Response) | undefined;
  /** Called before each view read, to change the view under the crawl. */
  beforeViewRead?: ((model: RegisterModel) => void) | undefined;
};

const DETAIL_PATH = /^\/bp\/dec_prez\.nsf\/1\/(?<unid>[0-9A-F]{32})$/u;
const FILE_PATH =
  /^\/bp\/dec_prez\.nsf\/0\/(?<unid>[0-9A-F]{32})\/\$FILE\/(?<name>.+)$/u;

/** A row renumbered to the position it holds in the model's view. */
const atPosition = (entry: Entry, position: number): Entry => ({
  ...entry,
  "@position": String(position),
});

const answerRegister = (model: RegisterModel, url: URL): Response => {
  model.requests.push(url);
  if (url.pathname === "/bp/dec_prez.nsf/decyzje") {
    model.beforeViewRead?.(model);
    const total = model.entries.length;
    const start = Number(url.searchParams.get("Start"));
    const count = Number(url.searchParams.get("Count"));
    const step = url.searchParams.get("NavigateReverse") === "1" ? -1 : 1;
    // Domino answers a start outside the view with no rows at all.
    const positions =
      start < 1 || start > total
        ? []
        : Array.from(
            { length: count },
            (_, index) => start + step * index,
          ).filter((position) => position >= 1 && position <= total);
    return Response.json({
      "@timestamp": "20260924T190000,00Z",
      "@toplevelentries": String(total),
      ...(positions.length === 0
        ? {}
        : {
            viewentry: positions.map((position) =>
              atPosition(model.entries[position - 1] ?? {}, position),
            ),
          }),
    });
  }
  const detail = DETAIL_PATH.exec(url.pathname)?.groups?.["unid"];
  if (detail !== undefined) {
    if (model.pageAnswer !== undefined) {
      return model.pageAnswer(detail);
    }
    const page = model.pages.get(detail);
    return page === undefined
      ? new Response("Not found", { status: 404 })
      : new Response(page, { headers: { "Content-Type": "text/html" } });
  }
  const file = FILE_PATH.exec(url.pathname)?.groups;
  const bytes =
    file === undefined
      ? undefined
      : model.files.get(
          `${file["unid"] ?? ""}/${decodeURIComponent(file["name"] ?? "")}`,
        );
  return bytes === undefined
    ? new Response("Not found", { status: 404 })
    : new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
};

const serveRegister = (model: RegisterModel): void => {
  globalThis.fetch = asFetchMock(
    async (input: string | URL | Request) =>
      await Promise.resolve(
        answerRegister(
          model,
          new URL(
            typeof input === "string" || input instanceof URL
              ? input
              : input.url,
          ),
        ),
      ),
  );
};

const registerOverFixtures = async (
  entries?: Entry[],
): Promise<RegisterModel> => ({
  entries: entries ?? (await capturedEntries()),
  pages: new Map([
    [WITH_RULINGS, await pageOf(WITH_RULINGS)],
    [FILELESS, await pageOf(FILELESS)],
    [NUMBERLESS, await pageOf(NUMBERLESS)],
    [APPEALED, await pageOf(APPEALED)],
  ]),
  files: new Map([
    [`${WITH_RULINGS}/${await decisionFileOf(WITH_RULINGS)}`, await pdfBytes()],
  ]),
  requests: [],
});

const idsOf = (decisions: readonly IngestionResult[]): string[] =>
  decisions.map(({ sourceDocumentId }) => sourceDocumentId ?? "");

type Walk = { decisions: IngestionResult[]; cursor: string };

/** Crawl from `cursor` until the adapter returns the cursor it was given. */
const walkCrawl = async (
  cursor: string | null,
  maxPages = 400,
): Promise<Walk> => {
  const decisions: IngestionResult[] = [];
  let current = cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await plUokikAdapter.fetchPage(current, {});
    if (Result.isError(result)) {
      throw result.error;
    }
    decisions.push(...result.value.decisions);
    const next = result.value.nextCursor ?? panic("the crawl restarted");
    if (next === current) {
      return { decisions, cursor: next };
    }
    current = next;
  }
  return panic("the crawl never parked");
};

/** A parked cursor moved back to a day that has closed. */
const parkedYesterday = (cursor: string): string =>
  encodePlUokikCursor({
    ...parsePlUokikCursor(cursor),
    parkedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  });

/** A made-up dated row, as the view states one, for rows the register adds. */
const syntheticEntry = (unid: string, printed: string): Entry => ({
  "@position": "1",
  "@unid": unid,
  "@noteid": "1",
  "@siblings": "1",
  entrydata: [
    {
      "@columnnumber": "0",
      "@name": "$7",
      text: {
        "0": `[<B>Numer decyzji: </B>DKK-999/2026<BR><b>]Data decyzji:      [</B>${printed}<BR>][<A HREF=/bp/dec_prez.nsf/0/${unid}?OpenDocument   title='opis dokumentu'>Spółka</A>][<BR>]Kontrola koncentracji[<BR>]`,
      },
    },
  ],
});

const buildFrom = async (
  entry: Entry,
  page: string | undefined,
  files: Parameters<typeof assemblePlUokikDecision>[0]["files"] = [],
) =>
  await assemblePlUokikDecision({
    entry,
    rawParts: plUokikRawPartsOf(entry, page),
    files,
  });

const decisionOf = (
  built: Awaited<ReturnType<typeof assemblePlUokikDecision>>,
): IngestionResult =>
  built.type === "unkeyable"
    ? panic("expected a decision, got an unkeyable row")
    : built.decision;

// ── The view ─────────────────────────────────────────────

describe("the flat view", () => {
  test("reads each row's number, date, parties and practice off its column", async () => {
    const entries = await capturedEntries();
    const row = normalizePlUokikRow(entryOf(entries, WITH_RULINGS));
    expect(row.unid).toBe(WITH_RULINGS);
    expect(row.decisionNumber).toBe("DOK-9/2011");
    expect(row.decisionDate).toBe("2011-11-28");
    expect(row.parties).toContain("Inco-Veritas");
    expect(row.practices).toEqual(["Pozostałe"]);
    expect(row.linkedUnid).toBe(WITH_RULINGS);
  });

  test("is sorted by the key the census bisects on", async () => {
    const keys = (await capturedEntries()).map((entry) =>
      plUokikSortKey(normalizePlUokikRow(entry)),
    );
    expect(keys).toEqual(keys.toSorted((a, b) => b - a));
  });

  test("a range past the view's end is empty, and a body without a total is not a view", () => {
    expect(readPlUokikView({ "@toplevelentries": "22253" })).toEqual({
      total: 22_253,
      rows: [],
    });
    expect(readPlUokikView({ viewentry: [] })).toBeNull();
    expect(readPlUokikView("<html></html>")).toBeNull();
    expect(
      readPlUokikView({ "@toplevelentries": "3", viewentry: ["x"] }),
    ).toBeNull();
  });

  test("dates are read in the order each surface prints them", () => {
    expect(plUokikDayOfPrinted("22.09.2026")).toBe("2026-09-22");
    expect(plUokikDayOfPrinted("31.02.2026")).toBeUndefined();
    // The decision page prints month first.
    expect(plUokikDayOfDetailDate("10/12/2009")).toBe("2009-10-12");
    expect(plUokikDayOfDetailDate("")).toBeUndefined();
  });
});

// ── A decision ───────────────────────────────────────────

describe("a decision", () => {
  test("is stored under the President with its PDF read and every response kept", async () => {
    const entry = entryOf(await capturedEntries(), WITH_RULINGS);
    const page = await pageOf(WITH_RULINGS);
    const name =
      parsePlUokikDetail(page)?.fields.find(({ label }) => label === "Decyzja")
        ?.files[0]?.name ?? panic("no file");
    const decision = decisionOf(
      await buildFrom(entry, page, [
        { name, status: PL_UOKIK_FILE_STATUS.READ, bytes: await pdfBytes() },
      ]),
    );
    expect(decision.sourceDocumentId).toBe(WITH_RULINGS);
    expect(decision.caseNumber).toBe("DOK-9/2011");
    expect(decision.court).toBe(PRESIDENT);
    expect(decision.decisionDate).toBe("2011-11-28");
    expect(decision.decisionType).toBe("decyzja");
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.fulltext).toContain("Inco-Veritas");
    expect(decision.documentUrl).toBe(
      plUokikFileUrl(WITH_RULINGS, name) ?? undefined,
    );
    expect(decision.metadata["fileReference"]).toBe("DOK1-430/2/11/AZ");
    expect(decision.metadata["appealed"]).toBe("Tak");
    expect(decision.sourceRawObjects?.["decision-file"]?.contentType).toBe(
      "application/pdf",
    );
    const parts = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(parts?.["listing"]).toBe(JSON.stringify(entry));
    expect(parts?.["detail"]).toBe(page);
    expect(decision.sourceRawContentType).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
  });

  test("links the court rulings on its appeal by name and address, never fetching them", async () => {
    const entry = entryOf(await capturedEntries(), WITH_RULINGS);
    const decision = decisionOf(
      await buildFrom(entry, await pageOf(WITH_RULINGS)),
    );
    const rulings = decision.metadata["appealRulings"];
    expect(Array.isArray(rulings) ? rulings.length : 0).toBe(2);
    expect(JSON.stringify(rulings)).toContain("XVII ama 32-12");
  });

  test("a page filed with no attachment is the decision without a document, its unlabelled rows kept", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const decision = decisionOf(await buildFrom(entry, await pageOf(FILELESS)));
    expect(decision.caseNumber).toBe("DIH-4/2009");
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.fulltext).toBeUndefined();
    expect(decision.metadata["documentAbsence"]).toBe(
      PL_UOKIK_DOCUMENT_ABSENCE.NO_ATTACHMENT,
    );
    expect(decision.metadata["unlabelledFields"]).toBeDefined();
  });

  test("a record the register numbers with a placeholder is keyed by its UNID, marked as a stand-in", async () => {
    const entry = entryOf(await capturedEntries(), NUMBERLESS);
    const decision = decisionOf(
      await buildFrom(entry, await pageOf(NUMBERLESS)),
    );
    expect(decision.caseNumber).toBe(NUMBERLESS);
    expect(decision.caseNumberIsPlaceholder).toBe(true);
    expect(decision.decisionDate).toBeUndefined();
  });

  test("is identified by its number as the register prints it and as prose cites it", async () => {
    const entry = entryOf(await capturedEntries(), WITH_RULINGS);
    const decision = decisionOf(
      await buildFrom(entry, await pageOf(WITH_RULINGS)),
    );
    expect(decision.identifiers).toEqual([
      { type: "case-number", value: "DOK-9/2011" },
      { type: "case-number", value: "DOK 9/2011" },
    ]);
    const numberless = decisionOf(
      await buildFrom(
        entryOf(await capturedEntries(), NUMBERLESS),
        await pageOf(NUMBERLESS),
      ),
    );
    expect(numberless.identifiers).toBeUndefined();
  });

  test("a decision under appeal keeps the court status its page shows", async () => {
    const page = await pageOf(APPEALED);
    const detail = parsePlUokikDetail(page);
    expect(
      detail?.fields.find(({ label }) => label === "Status sprawy w sądzie")
        ?.text,
    ).toBe("Sprawa w toku");
  });

  test("a page naming another register is not filed under a guess", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const page = (await pageOf(FILELESS)).replaceAll(
      "<title>Decyzje Prezesa UOKiK</title>",
      "<title>Inny rejestr</title>",
    );
    expect(decisionOf(await buildFrom(entry, page)).court).toBe("");
  });

  test("a page stating no decision table is kept on its row, never read as an empty record", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const built = await buildFrom(entry, "<html><body>Przerwa</body></html>");
    expect(built.type).toBe("detail-unavailable");
    const decision = decisionOf(built);
    expect(decision.isListingOnly).toBe(true);
    expect(decision.metadata["detailStatus"]).toBe(
      PL_UOKIK_DETAIL_STATUS.UNRECOGNISED,
    );
    // What the row states is still the row's.
    expect(decision.caseNumber).toBe("DIH-4/2009");
    expect(decision.decisionDate).toBe("2009-07-06");
  });

  test("a file address is rebuilt from the UNID and a checked name only", () => {
    expect(plUokikFileUrl(WITH_RULINGS, "a b.pdf")).toBe(
      `https://decyzje.uokik.gov.pl/bp/dec_prez.nsf/0/${WITH_RULINGS}/$FILE/a%20b.pdf`,
    );
    expect(plUokikFileUrl(WITH_RULINGS, "34799249.pdf/decyzja.pdf")).toBe(
      `https://decyzje.uokik.gov.pl/bp/dec_prez.nsf/0/${WITH_RULINGS}/$FILE/34799249.pdf/decyzja.pdf`,
    );
    expect(plUokikFileUrl(WITH_RULINGS, "../x.pdf")).toBeNull();
    expect(plUokikFileUrl(WITH_RULINGS, "x?y.pdf")).toBeNull();
  });
});

// ── Decisions with no text to read ───────────────────────

describe("a decision with no text to read", () => {
  /** A PDF of one blank page: a text layer that states nothing, as a scan's. */
  const blankPdf = async (): Promise<Uint8Array> => {
    const pdf = PDF.create();
    pdf.addPage();
    return await pdf.save();
  };

  /** DOK-9/2011's row and page, with its decision file answered as given. */
  const withFile = async (
    file: Parameters<typeof assemblePlUokikDecision>[0]["files"],
  ) =>
    decisionOf(
      await buildFrom(
        entryOf(await capturedEntries(), WITH_RULINGS),
        await pageOf(WITH_RULINGS),
        file,
      ),
    );

  const fileName = async (): Promise<string> =>
    parsePlUokikDetail(await pageOf(WITH_RULINGS))?.fields.find(
      ({ label }) => label === "Decyzja",
    )?.files[0]?.name ?? panic("no file");

  test("a PDF with no text layer is a scan, held on its page", async () => {
    const decision = await withFile([
      {
        name: await fileName(),
        status: PL_UOKIK_FILE_STATUS.READ,
        bytes: await blankPdf(),
      },
    ]);
    expect(decision.fulltext).toBeUndefined();
    expect(decision.isListingOnly).toBeUndefined();
    expect(decision.metadata["documentAbsence"]).toBe(
      PL_UOKIK_DOCUMENT_ABSENCE.SCANNED,
    );
  });

  test("a decision filed as an image is a scan too", async () => {
    const decision = await withFile([
      { name: await fileName(), status: PL_UOKIK_FILE_STATUS.IMAGE },
    ]);
    expect(decision.metadata["documentAbsence"]).toBe(
      PL_UOKIK_DOCUMENT_ABSENCE.SCANNED,
    );
  });

  test("a file served as a TIFF is recognised as an image, not an unknown format", async () => {
    const entries = await capturedEntries();
    const model = await registerOverFixtures([entryOf(entries, WITH_RULINGS)]);
    model.files.set(
      `${WITH_RULINGS}/${await decisionFileOf(WITH_RULINGS)}`,
      Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
    );
    serveRegister(model);
    const walk = await walkCrawl(null);
    const [decision] = walk.decisions;
    expect(decision?.metadata["documentAbsence"]).toBe(
      PL_UOKIK_DOCUMENT_ABSENCE.SCANNED,
    );
    expect(JSON.stringify(decision?.metadata["decisionFiles"])).toContain(
      PL_UOKIK_FILE_STATUS.IMAGE,
    );
  });

  test("a file that is gone, or of another format, is not a lasting absence", async () => {
    for (const status of [
      PL_UOKIK_FILE_STATUS.NOT_FOUND,
      PL_UOKIK_FILE_STATUS.NOT_PDF,
      PL_UOKIK_FILE_STATUS.TOO_LARGE,
    ]) {
      const decision = await withFile([{ name: await fileName(), status }]);
      expect(decision.metadata["documentAbsence"], status).toBeUndefined();
      expect(decision.metadata["documentStatus"], status).toBe("unreadable");
    }
  });

  test("a row stored without its page states no absence: that page may yet come", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const decision = decisionOf(
      await assemblePlUokikDecision({
        entry,
        rawParts: plUokikRawPartsOf(entry, undefined),
        detailStatus: PL_UOKIK_DETAIL_STATUS.NOT_FOUND,
      }),
    );
    expect(decision.metadata["documentAbsence"]).toBeUndefined();
  });

  test("the census reads exactly those reasons as complete", () => {
    const held = plUokikAdapter.reconciliation.heldWithoutDocument;
    expect(held?.metadataKey).toBe("documentAbsence");
    expect([...(held?.reasons ?? [])].toSorted()).toEqual(
      Object.values(PL_UOKIK_DOCUMENT_ABSENCE).toSorted(),
    );
  });
});

// ── Fetching ─────────────────────────────────────────────

describe("what the register does not serve", () => {
  const onePage = async (
    unid: string,
    answer?: (unid: string) => Response,
  ): Promise<RegisterModel> => {
    const entries = await capturedEntries();
    const model = await registerOverFixtures([entryOf(entries, unid)]);
    model.pageAnswer = answer;
    serveRegister(model);
    return model;
  };

  test("a decision page answering 404 stores the decision on its row", async () => {
    await onePage(FILELESS, () => new Response("", { status: 404 }));
    const walk = await walkCrawl(null);
    expect(idsOf(walk.decisions)).toEqual([FILELESS]);
    expect(walk.decisions[0]?.isListingOnly).toBe(true);
    expect(walk.decisions[0]?.metadata["detailStatus"]).toBe(
      PL_UOKIK_DETAIL_STATUS.NOT_FOUND,
    );
  });

  test.each([500, 503, 429, 403])(
    "a decision page answering %p fails the page and holds the cursor",
    async (status) => {
      await onePage(FILELESS, () => new Response("", { status }));
      const result = await plUokikAdapter.fetchPage(null, {});
      expect(Result.isError(result)).toBe(true);
    },
  );

  test("a decision file answering 404 keeps the decision without its document", async () => {
    const model = await onePage(WITH_RULINGS);
    model.files.clear();
    const walk = await walkCrawl(null);
    const [decision] = walk.decisions;
    expect(decision?.isListingOnly).toBeUndefined();
    expect(decision?.fulltext).toBeUndefined();
    expect(JSON.stringify(decision?.metadata["decisionFiles"])).toContain(
      PL_UOKIK_FILE_STATUS.NOT_FOUND,
    );
  });

  test("a view answer that is not a view fails the page rather than reading as empty", async () => {
    globalThis.fetch = asFetchMock(
      async () => await Promise.resolve(new Response("<html>Error</html>")),
    );
    expect(Result.isError(await plUokikAdapter.fetchPage(null, {}))).toBe(true);
  });
});

// ── The crawl ────────────────────────────────────────────

describe("the crawl over the view", () => {
  test("reads every row once, oldest first, and parks on the day it reached the top", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    const walk = await walkCrawl(null);
    const ids = idsOf(
      walk.decisions.filter(
        ({ metadata }) => metadata["recordClass"] !== "court-ruling",
      ),
    );
    expect(ids.toSorted()).toEqual(model.entries.map(unidOf).toSorted());
    expect(new Set(ids).size).toBe(ids.length);
    // Oldest first: the 2009 rows before any 2011 row.
    expect(ids.indexOf(FILELESS)).toBeLessThan(ids.indexOf(WITH_RULINGS));
    const parked = parsePlUokikCursor(walk.cursor);
    expect(parked.phase).toBe("tip");
    expect(parked.parkedOn).toBe(new Date().toISOString().slice(0, 10));
  });

  test("a cycle on the day it parked asks nothing and returns its cursor", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    const { cursor } = await walkCrawl(null);
    model.requests.length = 0;
    const result = await plUokikAdapter.fetchPage(cursor, {});
    expect(Result.isOk(result) ? result.value.nextCursor : null).toBe(cursor);
    expect(model.requests).toEqual([]);
  });

  test("once its day has closed, a lap reads exactly the decisions published since", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    const { cursor } = await walkCrawl(null);
    const added = syntheticEntry(
      "ABCDEFABCDEFABCDEFABCDEFABCDEF01",
      "23.09.2026",
    );
    // A new decision sorts after the undated rows and before every other one.
    const firstDated = model.entries.findIndex(
      (entry) => plUokikSortKey(normalizePlUokikRow(entry)) < 10_000,
    );
    model.entries.splice(firstDated, 0, added);
    model.requests.length = 0;
    const lap = await walkCrawl(parkedYesterday(cursor));
    expect(idsOf(lap.decisions)).toEqual([unidOf(added)]);
    const lapAgain = await walkCrawl(parkedYesterday(lap.cursor));
    expect(lapAgain.decisions).toEqual([]);
  });

  test("a row withdrawn below the anchor mid-walk moves nothing it reads", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    const expected = model.entries.map(unidOf);
    let withdrawn: string | undefined;
    let reads = 0;
    model.beforeViewRead = (current) => {
      reads += 1;
      if (reads === 40 && withdrawn === undefined) {
        // A row far below where the walk stands.
        const [removed] = current.entries.splice(-3, 1);
        withdrawn = removed === undefined ? undefined : unidOf(removed);
      }
    };
    const walk = await walkCrawl(null);
    const ids = new Set(idsOf(walk.decisions));
    for (const unid of expected) {
      expect(ids.has(unid), unid).toBe(true);
    }
    expect(withdrawn).toBeDefined();
  });

  test("an anchor withdrawn from under the crawl rewinds it, never skips past", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    const first = await plUokikAdapter.fetchPage(null, {});
    const cursor = Result.isOk(first) ? first.value.nextCursor : null;
    const { anchor } = parsePlUokikCursor(cursor);
    model.entries = model.entries.filter((entry) => unidOf(entry) !== anchor);
    const walk = await walkCrawl(cursor);
    const ids = new Set(idsOf(walk.decisions));
    for (const entry of model.entries.slice(0, -10)) {
      expect(ids.has(unidOf(entry)), unidOf(entry)).toBe(true);
    }
  });

  test("an unreadable cursor starts the walk from the oldest row", () => {
    expect(parsePlUokikCursor("2026-01-01")).toEqual({
      phase: "walk",
      read: 0,
      total: 0,
      anchor: undefined,
    });
    const cursor = {
      phase: "tip" as const,
      read: 12,
      total: 40,
      anchor: WITH_RULINGS,
      parkedOn: "2026-09-24",
    };
    expect(parsePlUokikCursor(encodePlUokikCursor(cursor))).toEqual(cursor);
  });
});

// ── The census ───────────────────────────────────────────

describe("the year census", () => {
  const listSlice = async (slice: string) =>
    await plUokikAdapter.reconciliation.listSlicePage({ slice, page: 0 });

  test("lists exactly the rows a decision year holds, under the crawl's identities", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    const listed = await listSlice("2011");
    const expected = model.entries.filter(
      (entry) => plUokikSortKey(normalizePlUokikRow(entry)) === 2011,
    );
    expect(listed.totalPages).toBe(1);
    expect(listed.items.map(({ identity }) => identity)).toEqual(
      expected.map((entry) =>
        plUokikListingIdentity(normalizePlUokikRow(entry)),
      ),
    );
    expect(expected.length).toBe(1135);
  });

  test("the rows stating no date are a slice of their own", async () => {
    serveRegister(await registerOverFixtures());
    const listed = await listSlice(PL_UOKIK_UNDATED_SLICE);
    expect(listed.items.length).toBe(6);
  });

  test("a year the register holds nothing for lists nothing", async () => {
    serveRegister(await registerOverFixtures());
    expect(await listSlice("2015")).toEqual({ items: [], totalPages: 0 });
  });

  test("a view that changes size while it is bisected refuses the slice", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    let reads = 0;
    model.beforeViewRead = (current) => {
      reads += 1;
      if (reads === 3) {
        current.entries.splice(
          10,
          0,
          syntheticEntry("ABCDEFABCDEFABCDEFABCDEFABCDEF02", "01.01.2020"),
        );
      }
    };
    const outcome = await listSlice("2011").then(
      () => "listed",
      () => "refused",
    );
    expect(outcome).toBe("refused");
  });

  test("walks from the undated slice through every year to the present", () => {
    expect(plUokikPreviousSlice("2000")).toBe(PL_UOKIK_UNDATED_SLICE);
    expect(plUokikPreviousSlice(PL_UOKIK_UNDATED_SLICE)).toBeNull();
    expect(plUokikNextSlice(PL_UOKIK_UNDATED_SLICE)).toBe("2000");
    expect(plUokikNextSlice("2011")).toBe("2012");
    expect(plUokikNextSlice(String(new Date().getUTCFullYear()))).toBeNull();
  });

  test("the total is the view's own count", async () => {
    const model = await registerOverFixtures();
    serveRegister(model);
    expect(
      await plUokikAdapter.getTotalCount(new AbortController().signal),
    ).toEqual({ type: "count", total: model.entries.length });
  });

  test("a row whose page failed is not counted held", async () => {
    const entries = await capturedEntries();
    const model = await registerOverFixtures([entryOf(entries, FILELESS)]);
    model.pageAnswer = () => new Response("", { status: 404 });
    serveRegister(model);
    expect(
      await plUokikAdapter.reconciliation.buildDecision(
        entryOf(entries, FILELESS),
      ),
    ).toEqual({ type: "detail-unavailable" });
  });
});

// ── Court rulings ────────────────────────────────────────

/** RLU-17/2007: its appeal went through both courts to the Supreme Court. */
const APPEALED_TO_SUPREME = "E1054A6198F37B72C1257EC6007B8007";

const RULING_FILES = {
  "Wyrok VI ACa 527_08.pdf": "pl-uokik-ruling-vi-aca-527-08.pdf",
  "Postanowienie III SK 17_09.pdf": "pl-uokik-ruling-iii-sk-17-09.pdf",
  "Wyrok XVII AmA 73_07.pdf": "pl-uokik-ruling-xvii-ama-73-07.pdf",
} as const;

const PARSER_FIXTURES = new URL("../parsers/__fixtures__/", import.meta.url);

/** The register serving RLU-17/2007's row, page and the three ruling files. */
const registerWithRulings = async (): Promise<RegisterModel> => {
  const window = entriesOf(
    await Bun.file(new URL("pl-uokik-view-2007-window.json", FIXTURES)).json(),
  );
  const model = await registerOverFixtures([
    entryOf(window, APPEALED_TO_SUPREME),
  ]);
  model.pages.set(APPEALED_TO_SUPREME, await pageOf(APPEALED_TO_SUPREME));
  for (const [name, fixture] of Object.entries(RULING_FILES)) {
    model.files.set(
      `${APPEALED_TO_SUPREME}/${name}`,
      new Uint8Array(
        await Bun.file(new URL(fixture, PARSER_FIXTURES)).arrayBuffer(),
      ),
    );
  }
  return model;
};

const rulingNamed = (
  decisions: readonly IngestionResult[],
  name: string,
): IngestionResult =>
  decisions.find(
    ({ sourceDocumentId }) =>
      sourceDocumentId === plUokikRulingId(APPEALED_TO_SUPREME, name),
  ) ?? panic(`no ruling row for ${name}`);

describe("the court rulings a decision page attaches", () => {
  test("become rows of their own, filed under the court their header names", async () => {
    serveRegister(await registerWithRulings());
    const { decisions } = await walkCrawl(null);
    expect(decisions).toHaveLength(4);
    const appeal = rulingNamed(decisions, "Wyrok VI ACa 527_08.pdf");
    expect(appeal.court).toBe("Sąd Apelacyjny w Warszawie");
    expect(appeal.caseNumber).toBe("VI ACa 527/08");
    expect(appeal.decisionDate).toBe("2008-09-29");
    expect(appeal.decisionType).toBe("wyrok");
    expect(appeal.isListingOnly).toBeUndefined();
    expect(appeal.fulltext).toContain("oddala apelację");
    expect(appeal.metadata["divisionAsPrinted"]).toBe("VI Wydział Cywilny");
    expect(appeal.sourceRawObjects?.["ruling-file"]?.contentType).toBe(
      "application/pdf",
    );
    const supreme = rulingNamed(decisions, "Postanowienie III SK 17_09.pdf");
    expect(supreme.court).toBe("Sąd Najwyższy");
    expect(supreme.caseNumber).toBe("III SK 17/09");
    expect(supreme.decisionType).toBe("postanowienie");
  });

  test("each links the decision it reviewed, and the decision links each back", async () => {
    serveRegister(await registerWithRulings());
    const { decisions } = await walkCrawl(null);
    const decision =
      decisions.find(
        ({ sourceDocumentId }) => sourceDocumentId === APPEALED_TO_SUPREME,
      ) ?? panic("no decision row");
    const linked = decision.metadata["appealRulings"];
    const ids = (Array.isArray(linked) ? linked : []).map((ruling) =>
      isRecord(ruling) ? ruling["sourceDocumentId"] : undefined,
    );
    expect(new Set(ids)).toEqual(
      new Set(
        Object.keys(RULING_FILES).map((name) =>
          plUokikRulingId(APPEALED_TO_SUPREME, name),
        ),
      ),
    );
    for (const name of Object.keys(RULING_FILES)) {
      expect(rulingNamed(decisions, name).metadata["uokikDecision"]).toEqual({
        sourceDocumentId: APPEALED_TO_SUPREME,
        caseNumber: decision.caseNumber,
        decisionDate: decision.decisionDate,
      });
    }
  });

  test("carry the keys the courts' own copies of the same rulings are stored under", async () => {
    serveRegister(await registerWithRulings());
    const { decisions } = await walkCrawl(null);
    const appeal = rulingNamed(decisions, "Wyrok VI ACa 527_08.pdf");
    // The common courts' judgments API and SAOS key a judgment by court,
    // signature, date and kind.
    expect(appeal.metadata["rulingKeys"]).toEqual(
      plCommonCourtRulingKeys({
        caseNumber: "VI ACa 527/08",
        court: "Sąd Apelacyjny w Warszawie",
        decisionDate: "2008-09-29",
        decisionType: "wyrok",
      }),
    );
    // The Supreme Court's own adapter keys it by docket, date and kind.
    expect(
      rulingNamed(decisions, "Postanowienie III SK 17_09.pdf").metadata[
        "rulingKeys"
      ],
    ).toEqual(
      plSupremeCourtRulingKeys({
        caseNumber: "III SK 17/09",
        court: "Sąd Najwyższy",
        decisionDate: "2009-07-02",
        decisionType: "postanowienie",
      }),
    );
  });

  test("a scan is kept on what the register states and not published, never keyed by a guess", async () => {
    serveRegister(await registerWithRulings());
    const { decisions } = await walkCrawl(null);
    const scan = rulingNamed(decisions, "Wyrok XVII AmA 73_07.pdf");
    expect(scan.isListingOnly).toBe(true);
    expect(scan.caseNumberIsPlaceholder).toBe(true);
    expect(scan.court).toBe("");
    expect(scan.metadata["rulingStatus"]).toBe(PL_UOKIK_RULING_UNREAD.NO_TEXT);
    expect(scan.metadata["rulingKeys"]).toBeUndefined();
  });

  test("a ruling file answering 404 is kept with the reason; one answering 500 fails the page", async () => {
    const model = await registerWithRulings();
    model.files.delete(`${APPEALED_TO_SUPREME}/Wyrok VI ACa 527_08.pdf`);
    serveRegister(model);
    const { decisions } = await walkCrawl(null);
    expect(
      rulingNamed(decisions, "Wyrok VI ACa 527_08.pdf").metadata[
        "rulingStatus"
      ],
    ).toBe(PL_UOKIK_FILE_STATUS.NOT_FOUND);

    const failing = await registerWithRulings();
    const answer = answerRegister;
    globalThis.fetch = asFetchMock(async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      return await Promise.resolve(
        url.pathname.includes("VI%20ACa")
          ? new Response("", { status: 500 })
          : answer(failing, url),
      );
    });
    expect(Result.isError(await plUokikAdapter.fetchPage(null, {}))).toBe(true);
  });

  test("the census builds the decision alone, spending no request on its rulings", async () => {
    const model = await registerWithRulings();
    serveRegister(model);
    const window = entriesOf(
      await Bun.file(
        new URL("pl-uokik-view-2007-window.json", FIXTURES),
      ).json(),
    );
    const outcome = await plUokikAdapter.reconciliation.buildDecision(
      entryOf(window, APPEALED_TO_SUPREME),
    );
    expect(outcome.type).toBe("built");
    expect(
      model.requests.filter(({ pathname }) =>
        Object.keys(RULING_FILES).some((name) =>
          decodeURIComponent(pathname).endsWith(name),
        ),
      ),
    ).toEqual([]);
  });

  test("a ruling's stored envelope is not replayed as a decision", async () => {
    serveRegister(await registerWithRulings());
    const { decisions } = await walkCrawl(null);
    const appeal = rulingNamed(decisions, "Wyrok VI ACa 527_08.pdf");
    const replayed = await plUokikAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(appeal.sourceRaw ?? ""),
      contentType: appeal.sourceRawContentType ?? null,
      caseNumber: appeal.caseNumber,
      sourceDocumentId: appeal.sourceDocumentId ?? null,
      language: appeal.language,
      court: appeal.court,
      ecli: null,
      decisionDate: appeal.decisionDate ?? null,
      decisionType: appeal.decisionType ?? null,
      sourceUrl: appeal.sourceUrl ?? null,
      documentUrl: appeal.documentUrl ?? null,
      metadata: appeal.metadata,
    });
    expect(replayed?.type).toBe("rejected");
  });

  test("a file name too long to key on is keyed by its digest", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const id = plUokikRulingId(APPEALED_TO_SUPREME, long);
    expect(id.startsWith(`${APPEALED_TO_SUPREME}/sha256:`)).toBe(true);
    expect(plUokikRulingId(APPEALED_TO_SUPREME, long)).toBe(id);
  });
});

// ── Identity, replay and inventory ───────────────────────

describe("a listed row is never dropped silently", () => {
  test("a row with no UNID is kept verbatim under a quarantine identity", async () => {
    const entry = { ...entryOf(await capturedEntries(), FILELESS) };
    delete entry["@unid"];
    const identity = plUokikListingIdentity(normalizePlUokikRow(entry));
    expect(identity.type).toBe("document");
    const built = await buildFrom(entry, undefined);
    const decision = decisionOf(built);
    expect(decision.sourceDocumentId?.startsWith("pl-uokik-quarantine:")).toBe(
      true,
    );
    expect(decision.isListingOnly).toBe(true);
    expect(decision.metadata["detailStatus"]).toBe(
      PL_UOKIK_DETAIL_STATUS.IDENTITY_UNAVAILABLE,
    );
  });

  test("the same row, once its UNID is back, can adopt the quarantined one", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const withoutUnid = { ...entry };
    delete withoutUnid["@unid"];
    const quarantined = decisionOf(await buildFrom(withoutUnid, undefined));
    const recovered = decisionOf(
      await buildFrom(entry, await pageOf(FILELESS)),
    );
    expect(recovered.sourceDocumentIdRepairAliases).toEqual([
      quarantined.sourceDocumentId ?? "",
    ]);
  });

  test("a row with nothing to key or fingerprint is reported, not stored as a guess", async () => {
    expect((await buildFrom({}, undefined)).type).toBe("unkeyable");
  });
});

describe("replaying a stored envelope", () => {
  const storedOf = (decision: IngestionResult): StoredRawReparseInput => ({
    raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
    contentType: decision.sourceRawContentType ?? null,
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

  test("rebuilds the decision the crawl built from its row and page", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const decision = decisionOf(await buildFrom(entry, await pageOf(FILELESS)));
    const replayed = await plUokikAdapter.reparseStoredRaw?.(
      storedOf(decision),
    );
    expect(replayed?.type).toBe("parsed");
    if (replayed?.type === "parsed") {
      expect(replayed.result.rawHash).toBe(decision.rawHash);
      expect(replayed.result.metadata).toEqual(decision.metadata);
    }
  });

  test("keeps the reason a row was stored without its page", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const decision = decisionOf(
      await assemblePlUokikDecision({
        entry,
        rawParts: plUokikRawPartsOf(entry, undefined),
        detailStatus: PL_UOKIK_DETAIL_STATUS.GONE,
      }),
    );
    const replayed = await plUokikAdapter.reparseStoredRaw?.(
      storedOf(decision),
    );
    expect(
      replayed?.type === "parsed"
        ? replayed.result.metadata["detailStatus"]
        : undefined,
    ).toBe(PL_UOKIK_DETAIL_STATUS.GONE);
  });
});

describe("the field inventory", () => {
  test("names a label the decision page starts printing", async () => {
    const entry = entryOf(await capturedEntries(), FILELESS);
    const page = (await pageOf(FILELESS)).replace(
      "<b>Region:</b>",
      "<b>Nowe pole:</b>",
    );
    const fields = listPlUokikSourceFields(plUokikRawPartsOf(entry, page));
    expect(fields).toContain("detail.Nowe pole");
    const decision = decisionOf(await buildFrom(entry, page));
    expect(JSON.stringify(decision.metadata["otherFields"])).toContain(
      "Nowe pole",
    );
  });

  test("names a key the view starts sending", async () => {
    const entry = {
      ...entryOf(await capturedEntries(), FILELESS),
      "@newkey": "x",
    };
    expect(
      listPlUokikSourceFields(plUokikRawPartsOf(entry, undefined)),
    ).toContain("listing.@newkey");
  });
});
