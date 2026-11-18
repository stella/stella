/**
 * cz-ns-sbirka against the pages sbirka.nsoud.cz served, and its walk against
 * scripted sitemaps.
 *
 * Every detail page, sitemap and archive page here is a recording beside a
 * provenance sidecar, so a changed byte fails the capture suite rather than
 * quietly changing what these assertions are about. The walk's behaviour
 * beyond reading one response (moving through the sitemaps, standing still at
 * the newest entry, meeting an edited entry again, stopping on an unread page)
 * runs through a stubbed transport.
 */
import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { hasUsableAst } from "@stll/legal-ast/document-ast";
import { INGESTION_STOP_KIND } from "@stll/legal-atlas/ingestion-cycle";

import {
  buildCzNsSbirkaDecision,
  CZ_NS_SBIRKA_PAGE_SIZE,
  czNsSbirkaAdapter,
  czNsSbirkaDockets,
  czNsSbirkaEntryUrl,
  czNsSbirkaFetchPage,
  czNsSbirkaLanguageOf,
  czNsSbirkaSliceUrl,
  encodeCzNsSbirkaCursor,
  readCzNsSbirkaArchivePage,
  readCzNsSbirkaSitemap,
  readCzNsSbirkaSitemapIndex,
} from "@/api/handlers/case-law/ingestion/adapters/cz-ns-sbirka";
import { czCourtFromEcli } from "@/api/lib/case-law/cz-ecli-courts";
import { decisionTypeKind } from "@/api/lib/case-law/decision-type-kind";
import {
  CZ_NS_COLLECTION_METADATA_KEY,
  readStoredCzNsCollectionEntry,
} from "@/api/lib/legal-search/cz-ns-collection-entry";
import { CZ_NS_SBIRKA_VAZNY_SLICE } from "@/api/lib/legal-search/ingestion-constants";
import {
  decodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";
import {
  czNsSbirkaRecordedPage,
  type CzNsSbirkaRecording,
} from "@/api/tests/helpers/case-law-enrolled-fixtures";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const testFetchState = createTestFetch();
afterEach(() => {
  testFetchState.restore();
});

const FIXTURES = new URL("__fixtures__/", import.meta.url);

const recorded = async (name: string): Promise<string> =>
  new TextDecoder().decode(
    Bun.gunzipSync(await Bun.file(new URL(name, FIXTURES)).bytes()),
  );

/** A branded row value, compared as the plain value it holds. */
const observed = (value: unknown): unknown => value;

const built = (postId: CzNsSbirkaRecording): IngestionResult =>
  buildCzNsSbirkaDecision({
    postId,
    detailHtml: czNsSbirkaRecordedPage(postId),
  }) ?? panic(`${postId} built nothing`);

/** The collection entry a built decision carries, read back as stored. */
const entryOf = (decision: IngestionResult) =>
  readStoredCzNsCollectionEntry(structuredClone(decision.metadata)) ??
  panic("the decision carries no collection entry");

const reporterCitations = (decision: IngestionResult): string[] =>
  (decision.identifiers ?? []).flatMap((identifier) =>
    identifier.type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION
      ? [identifier.value]
      : [],
  );

const headings = (decision: IngestionResult): string[] =>
  hasUsableAst(decision.documentAst)
    ? decision.documentAst.blocks.flatMap((block) =>
        block.type === "heading" ? [block.plainText] : [],
      )
    : [];

describe("an entry's detail page as a decision", () => {
  test("a pre-1993 Slovak decision: R 9/1971, the case that names this source", () => {
    const decision = built("9586");
    expect(observed(decision.sourceDocumentId)).toBe("9586");
    expect(observed(decision.caseNumber)).toBe("6 Cz 90/70");
    expect(observed(decision.ecli)).toBe("ECLI:CZ:NS:1970:6.CZ.90.1970.1");
    expect(observed(decision.decisionDate)).toBe("1970-10-14");
    expect(observed(decision.decisionType)).toBe("rozsudek");
    expect(observed(decision.language)).toBe("sk");
    expect(observed(decision.sourceUrl)).toBe(
      "https://sbirka.nsoud.cz/sbirka/9586/",
    );
    expect(reporterCitations(decision)).toEqual(["Rc 9/1971", "R 9/1971"]);
    const entry = entryOf(decision);
    expect(entry).toMatchObject({
      postId: "9586",
      part: "civil",
      kind: "Rozhodnutí ve věcech občanskoprávních, obchodních a správních",
      number: "9",
      year: 1971,
      issue: "1",
      statedCourt: "Nejvyšší soud SSR",
      exports: {
        pdf: "https://sbirka.nsoud.cz/export/sbirky?collectionIds=9586",
        epub: "https://sbirka.nsoud.cz/export/epub-sbirky?epubCollectionIds=9586",
      },
    });
    expect(entry.title).toContain("sp. zn. 6 Cz 90/70");
    expect(entry.keywords).toContain("Výrobní prostředky");
    expect(entry.citedProvisions.length).toBeGreaterThan(1);
    expect(decision.textFields.legalSentence).toMatchObject({
      type: "present",
    });
    // The row's court is the one the ECLI names; the page's stays in the entry.
    const fromEcli = czCourtFromEcli(decision.ecli);
    expect(fromEcli.type === "named" && fromEcli.court).toBe(decision.court);
    // The editors' summary of the history is set apart from the reasons.
    expect(headings(decision)).toEqual([
      "Sbírkový text rozhodnutí",
      "Z odôvodnenia:",
    ]);
    const roles = hasUsableAst(decision.documentAst)
      ? decision.documentAst.blocks
          .slice(0, 4)
          .map((block) => ("role" in block ? block.role : undefined))
      : [];
    expect(roles).toEqual([
      "publisher-heading",
      "apparatus",
      "apparatus",
      "apparatus",
    ]);
  });

  test("a Supreme Court decision the court's database also holds", () => {
    const decision = built("5819");
    expect(observed(decision.caseNumber)).toBe("26 Cdo 4795/2017");
    // Stored as the collection states it, whatever the database spells.
    expect(observed(decision.ecli)).toBe("ECLI:CZ:NS:2019:26.CDO.4795.2017.1");
    expect(observed(decision.court)).toBe("Nejvyšší soud");
    expect(observed(decision.language)).toBe("cs");
    const entry = entryOf(decision);
    expect(entry.part).toBe("civil");
    expect(reporterCitations(decision)).toEqual([
      `Rc ${entry.number ?? ""}/${String(entry.year)}`,
      `R ${entry.number ?? ""}/${String(entry.year)}`,
    ]);
    expect(observed(decision.metadata["caseNumberReading"])).toBe("grammar");
  });

  test("a pre-1993 decision in Czech", () => {
    const decision = built("10001");
    expect(observed(decision.caseNumber)).toBe("1 Cz 34/72");
    expect(observed(decision.language)).toBe("cs");
    expect(observed(decision.decisionDate)).toBe("1972-06-29");
    expect(entryOf(decision).statedCourt).not.toBeNull();
  });

  test("a stanovisko is an opinion, and names no part of the collection", () => {
    const decision = built("19679");
    expect(observed(decision.caseNumber)).toBe("Cpjn 201/2021");
    expect(observed(decision.decisionType)).toBe("stanovisko");
    expect(decisionTypeKind(decision.decisionType)).toBe("opinion");
    const entry = entryOf(decision);
    expect(entry.kind).toBe("Stanoviska");
    expect(entry.part).toBeNull();
    // A citation that leaves the part out is the only one this entry answers.
    expect(reporterCitations(decision)).toEqual(["R 1/2022"]);
    expect(decision.textFields.abstract).toMatchObject({ type: "present" });
  });

  test("a page stating only keywords and provisions reads its heading and breadcrumb", () => {
    const decision = built("13914");
    expect(observed(decision.caseNumber)).toBe("6 Tdo 1314/2003");
    expect(observed(decision.decisionDate)).toBe("2003-12-10");
    expect(observed(decision.decisionType)).toBe("usnesení");
    expect(observed(decision.ecli)).toBeUndefined();
    expect(observed(decision.court)).toBe("Nejvyšší soud");
    const entry = entryOf(decision);
    expect(entry).toMatchObject({
      year: 2004,
      issue: "7",
      number: null,
      kind: null,
      statedCourt: null,
    });
    expect(reporterCitations(decision)).toEqual([]);
  });

  test("the row's decision date is stored; the heading that disagrees is kept", () => {
    const decision = built("4320");
    expect(observed(decision.decisionDate)).toBe("2022-01-14");
    expect(entryOf(decision).title).toContain("ze dne 14.01.2020");
    expect(observed(decision.caseNumber)).toBe("14 To 158/2019");
  });

  test("the rows only some entries state are kept in the entry", () => {
    expect(entryOf(built("15158")).affectedDecisions.at(0)).toContain(
      "Cpjn 206/2010",
    );
    expect(entryOf(built("18598")).constitutionalComplaint).toContain(
      "III. ÚS 1995/21",
    );
    expect(entryOf(built("9586"))).toMatchObject({
      affectedDecisions: [],
      constitutionalComplaint: null,
    });
  });

  test("the raw is the detail page verbatim, keyed by the post id", () => {
    const decision = built("9586");
    expect(observed(decision.sourceRawContentType)).toBe(
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(decodeSourceRawEnvelope(decision.sourceRaw ?? "")).toEqual({
      listing: '{"postId":"9586"}',
      detail: czNsSbirkaRecordedPage("9586"),
    });
  });

  test("a stored entry replays to the decision the crawl built", async () => {
    const decision = built("19679");
    const replayed = await czNsSbirkaAdapter.reparseStoredRaw?.({
      raw: new TextEncoder().encode(decision.sourceRaw ?? ""),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      caseNumber: decision.caseNumber,
      sourceDocumentId: "19679",
      language: decision.language,
      court: decision.court,
      ecli: decision.ecli ?? null,
      decisionDate: decision.decisionDate ?? null,
      decisionType: decision.decisionType ?? null,
      sourceUrl: decision.sourceUrl ?? null,
      documentUrl: decision.documentUrl ?? null,
      metadata: decision.metadata,
    });
    const parsed =
      replayed?.type === "parsed"
        ? replayed.result
        : panic("the stored entry did not replay");
    expect(parsed.rawHash).toBe(decision.rawHash);
    expect(parsed.caseNumber).toBe(decision.caseNumber);
  });

  test("an entry with no docket anywhere is labelled by its post id", () => {
    const decision = buildCzNsSbirkaDecision({
      postId: "1",
      detailHtml:
        "<h1>Rozhodnutí Nejvyššího soudu ze dne 23. 11. 1967</h1><table class='content-table'></table>",
    });
    expect(observed(decision?.caseNumber)).toBe("1");
    expect(observed(decision?.caseNumberIsPlaceholder)).toBe(true);
    expect(observed(decision?.metadata["caseNumberReading"])).toBe(
      "placeholder",
    );
    expect(
      buildCzNsSbirkaDecision({ postId: "1", detailHtml: "<p></p>" }),
    ).toBeNull();
  });
});

describe("dockets and language", () => {
  test.each([
    ["6 Cz 90/70", "6 Cz 90/70", [], "grammar"],
    ["Cpjn 38/98", "Cpjn 38/98", [], "grammar"],
    ["Tpjn 300/2000", "Tpjn 300/2000", [], "grammar"],
    ["S 296/99", "S 296/99", [], "grammar"],
    [
      "29 NSCR 55/2019, 29 NSCR 111/2019",
      "29 NSCR 55/2019",
      ["29 NSCR 111/2019"],
      "grammar",
    ],
    ["25 Co 498, 499/97", "25 Co 498, 499/97", [], "as-stated"],
    ["Kr I 4/19", "Kr I 4/19", [], "as-stated"],
  ] as const)("%s", (stated, caseNumber, additional, reading) => {
    expect(czNsSbirkaDockets(stated)).toMatchObject({
      caseNumber,
      additionalCaseNumbers: additional,
      reading,
    });
  });

  test("a sheet number is split off the docket", () => {
    expect(czNsSbirkaDockets("Pls 7/66-1")).toMatchObject({
      caseNumber: "Pls 7/66",
      sheetNumber: "1",
    });
  });

  test("the language is the text's, Czech where the text does not say", () => {
    expect(
      czNsSbirkaLanguageOf(["Podľa názoru súdu, ktorý je podľa zákona"]),
    ).toBe("sk");
    expect(
      czNsSbirkaLanguageOf(["Podle názoru soudu, který je podle zákona"]),
    ).toBe("cs");
    expect(czNsSbirkaLanguageOf(["Č. 32"])).toBe("cs");
  });
});

// ── The walk ─────────────────────────────────────────────

type Served = { url: string };

const sitemapXml = (entries: readonly { id: string; lastmod: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset>${entries
    .map(
      ({ id, lastmod }) =>
        `<url><loc>${czNsSbirkaEntryUrl(id)}</loc><lastmod>${lastmod}</lastmod></url>`,
    )
    .join("")}</urlset>`;

const indexXml = (count: number) => {
  const collections = Array.from(
    { length: count },
    (_, index) =>
      `<sitemap><loc>https://sbirka.nsoud.cz/collection-sitemap${index === 0 ? "" : String(index + 1)}.xml</loc></sitemap>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex><sitemap><loc>https://sbirka.nsoud.cz/post-sitemap.xml</loc></sitemap>${collections}</sitemapindex>`;
};

type Script = {
  sitemaps: readonly string[];
  detail?: (postId: string) => Response;
};

const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
};

/** Script the site and record every request the walk sent. */
const stubSite = ({ sitemaps, detail }: Script): Served[] => {
  const served: Served[] = [];
  const page = czNsSbirkaRecordedPage("9586");
  testFetchState.set(
    asFetchMock(async (input: string | URL | Request) => {
      const url = urlOf(input);
      served.push({ url });
      const sitemap = /collection-sitemap(\d*)\.xml$/u.exec(url);
      if (url.endsWith("/sitemap_index.xml")) {
        return await Promise.resolve(new Response(indexXml(sitemaps.length)));
      }
      if (sitemap !== null) {
        const position = sitemap[1] === "" ? 0 : Number(sitemap[1]) - 1;
        const body = sitemaps[position];
        return await Promise.resolve(
          body === undefined
            ? new Response("", { status: 404 })
            : new Response(body),
        );
      }
      const postId = /\/sbirka\/(\d+)\/$/u.exec(url)?.[1];
      if (postId !== undefined) {
        return await Promise.resolve(
          detail?.(postId) ??
            new Response(page, {
              headers: { "Content-Type": "text/html; charset=UTF-8" },
            }),
        );
      }
      return await Promise.resolve(new Response("", { status: 404 }));
    }),
  );
  return served;
};

const entries = (from: number, count: number, day = "2026-11-05") =>
  Array.from({ length: count }, (_, index) => ({
    id: String(from + index),
    lastmod: `${day}T07:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}+00:00`,
  }));

const cursorOf = (page: Result<{ nextCursor: string | null }, unknown>) => {
  if (!Result.isOk(page) || page.value.nextCursor === null) {
    return panic("the page did not advance");
  }
  const parsed: unknown = JSON.parse(page.value.nextCursor);
  return isRecord(parsed) ? parsed : panic("the cursor is not an object");
};

const detailRequests = (served: readonly Served[]) =>
  served.filter(({ url }) => url.includes("/sbirka/"));

describe("the sitemap walk", () => {
  test("reads the recorded index and newest sitemap", async () => {
    const index = readCzNsSbirkaSitemapIndex(
      await recorded("cz-ns-sbirka-sitemap-index.xml.gz"),
    );
    expect(index).toHaveLength(10);
    expect(index.at(0)).toBe("https://sbirka.nsoud.cz/collection-sitemap.xml");
    expect(index.at(1)).toBe("https://sbirka.nsoud.cz/collection-sitemap2.xml");
    expect(index.at(-1)).toBe(
      "https://sbirka.nsoud.cz/collection-sitemap10.xml",
    );
    const read = readCzNsSbirkaSitemap(
      await recorded("cz-ns-sbirka-collection-sitemap10.xml.gz"),
      "https://sbirka.nsoud.cz/collection-sitemap10.xml",
    );
    const sitemap = Result.isOk(read) ? read.value : panic("unreadable");
    expect(sitemap).toHaveLength(832);
    const times = sitemap.map(({ lastmod }) => Date.parse(lastmod));
    expect(times).toEqual(times.toSorted((left, right) => left - right));
  });

  test("a first page reads the first entries and stops after them", async () => {
    const served = stubSite({ sitemaps: [sitemapXml(entries(100, 25))] });
    const page = await czNsSbirkaFetchPage(null);
    expect(Result.isOk(page) && page.value.decisions).toHaveLength(
      CZ_NS_SBIRKA_PAGE_SIZE,
    );
    expect(detailRequests(served)).toHaveLength(CZ_NS_SBIRKA_PAGE_SIZE);
    const last = entries(100, 25).at(CZ_NS_SBIRKA_PAGE_SIZE - 1);
    expect(cursorOf(page)).toEqual({
      version: 1,
      sitemap: 0,
      after: { postId: last?.id, lastmod: last?.lastmod },
    });
  });

  test("at the newest entry a page reads the index and the last sitemap only", async () => {
    const listed = entries(100, 3);
    const served = stubSite({ sitemaps: [sitemapXml(listed)] });
    const tip = listed.at(-1) ?? panic("no entries");
    const cursor = encodeCzNsSbirkaCursor({
      version: 1,
      sitemap: 0,
      after: { postId: tip.id, lastmod: tip.lastmod },
    });
    const page = await czNsSbirkaFetchPage(cursor);
    expect(Result.isOk(page) && page.value.decisions).toEqual([]);
    expect(Result.isOk(page) && page.value.nextCursor).toBe(cursor);
    expect(served.map(({ url }) => url)).toEqual([
      "https://sbirka.nsoud.cz/sitemap_index.xml",
      "https://sbirka.nsoud.cz/collection-sitemap.xml",
    ]);
  });

  test("an entry the publisher edits moves past the cursor and is read again", async () => {
    const listed = entries(100, 3);
    const tip = listed.at(-1) ?? panic("no entries");
    const edited = { id: "7", lastmod: "2026-11-06T08:00:00+00:00" };
    const served = stubSite({ sitemaps: [sitemapXml([...listed, edited])] });
    const page = await czNsSbirkaFetchPage(
      encodeCzNsSbirkaCursor({
        version: 1,
        sitemap: 0,
        after: { postId: tip.id, lastmod: tip.lastmod },
      }),
    );
    expect(detailRequests(served).map(({ url }) => url)).toEqual([
      czNsSbirkaEntryUrl("7"),
    ]);
    expect(cursorOf(page)["after"]).toEqual({
      postId: "7",
      lastmod: edited.lastmod,
    });
  });

  test("a sitemap read to its end gives way to the next", async () => {
    const first = entries(100, 2, "2026-01-01");
    const second = entries(200, 2, "2026-02-01");
    const served = stubSite({
      sitemaps: [sitemapXml(first), sitemapXml(second)],
    });
    const end = first.at(-1) ?? panic("no entries");
    const page = await czNsSbirkaFetchPage(
      encodeCzNsSbirkaCursor({
        version: 1,
        sitemap: 0,
        after: { postId: end.id, lastmod: end.lastmod },
      }),
    );
    expect(detailRequests(served).map(({ url }) => url)).toEqual(
      second.map(({ id }) => czNsSbirkaEntryUrl(id)),
    );
    expect(cursorOf(page)["sitemap"]).toBe(1);
  });

  test("an entry the publisher withdrew is skipped", async () => {
    stubSite({
      sitemaps: [sitemapXml(entries(100, 2))],
      detail: (postId) =>
        postId === "100"
          ? new Response("", { status: 404 })
          : new Response(czNsSbirkaRecordedPage("9586")),
    });
    const page = await czNsSbirkaFetchPage(null);
    expect(
      Result.isOk(page) &&
        page.value.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual(["101"]);
  });

  test("a page that could not be read fails the cycle, cursor untouched", async () => {
    const served = stubSite({
      sitemaps: [sitemapXml(entries(100, 3))],
      detail: () => new Response("", { status: 503 }),
    });
    const page = await czNsSbirkaFetchPage(null);
    expect(Result.isError(page)).toBe(true);
    expect(detailRequests(served)).toHaveLength(1);
  });

  test("a rate-limit refusal stops the source after one request", async () => {
    const served = stubSite({
      sitemaps: [sitemapXml(entries(100, 3))],
      detail: () => new Response("", { status: 429 }),
    });
    const page = await czNsSbirkaAdapter.fetchPage(null, {});
    expect(detailRequests(served)).toHaveLength(1);
    expect(Result.isError(page) && page.error.stopKind).toBe(
      INGESTION_STOP_KIND.PUBLISHER_REFUSAL,
    );
  });

  test("a cursor this adapter does not write is refused", async () => {
    stubSite({ sitemaps: [sitemapXml(entries(100, 1))] });
    const page = await czNsSbirkaFetchPage('{"version":2}');
    expect(Result.isError(page)).toBe(true);
  });

  test("the total is every entry the sitemaps list", async () => {
    stubSite({
      sitemaps: [sitemapXml(entries(100, 3)), sitemapXml(entries(200, 2))],
    });
    expect(
      await czNsSbirkaAdapter.getTotalCount(new AbortController().signal),
    ).toEqual({ type: "count", total: 5 });
  });
});

describe("reconciliation by collection year", () => {
  test("slices walk from the Vážný volumes through every year", () => {
    const { firstSlice, nextSlice, previousSlice, sliceOf } =
      czNsSbirkaAdapter.reconciliation;
    expect(firstSlice).toBe(CZ_NS_SBIRKA_VAZNY_SLICE);
    expect(nextSlice(CZ_NS_SBIRKA_VAZNY_SLICE)).toBe("1956");
    expect(nextSlice("1970")).toBe("1971");
    expect(previousSlice("1956")).toBe(CZ_NS_SBIRKA_VAZNY_SLICE);
    expect(previousSlice(CZ_NS_SBIRKA_VAZNY_SLICE)).toBeNull();
    expect(sliceOf(new Date("2026-11-18T09:00:00Z"))).toBe("2026");
    expect([CZ_NS_SBIRKA_VAZNY_SLICE, "1956"].toSorted()).toEqual([
      CZ_NS_SBIRKA_VAZNY_SLICE,
      "1956",
    ]);
  });

  test("a slice is the archive's own year term, page by page", () => {
    expect(czNsSbirkaSliceUrl("1971", 0)).toBe(
      "https://sbirka.nsoud.cz/year-collection/rok-1971/",
    );
    expect(czNsSbirkaSliceUrl("1971", 4)).toBe(
      "https://sbirka.nsoud.cz/year-collection/rok-1971/strana/5/",
    );
    expect(czNsSbirkaSliceUrl(CZ_NS_SBIRKA_VAZNY_SLICE, 0)).toBe(
      "https://sbirka.nsoud.cz/year-collection/vazny/",
    );
  });

  test("the recorded archive page lists its entries and its page count", async () => {
    const page = readCzNsSbirkaArchivePage(
      await recorded("cz-ns-sbirka-archive-rok-1971.html.gz"),
    );
    expect(page.postIds).toEqual([
      "9733",
      "9735",
      "9736",
      "9729",
      "9603",
      "9732",
      "9596",
    ]);
    expect(page.lastPage).toBe(22);
  });

  test("a listed page keys its entries by post id; a year with no term lists nothing", async () => {
    const archive = await recorded("cz-ns-sbirka-archive-rok-1971.html.gz");
    testFetchState.set(
      asFetchMock(
        async (input: string | URL | Request) =>
          await Promise.resolve(
            urlOf(input).includes("rok-1971")
              ? new Response(archive)
              : new Response("", { status: 404 }),
          ),
      ),
    );
    const { listSlicePage, revisionOf } = czNsSbirkaAdapter.reconciliation;
    const listed = await listSlicePage({ slice: "1971", page: 0 });
    expect(listed.totalPages).toBe(22);
    expect(listed.items.at(0)).toEqual({
      identity: { type: "document", sourceDocumentId: "9733" },
      payload: { postId: "9733" },
    });
    expect(revisionOf({ postId: "9733" })).toEqual({ postId: "9733" });
    expect(await listSlicePage({ slice: "1958", page: 0 })).toEqual({
      items: [],
      totalPages: 0,
    });
  });
});

describe("the stored collection entry", () => {
  test("reads back from the row's metadata as the adapter wrote it", () => {
    const decision = built("9586");
    const cloned: unknown = structuredClone(decision.metadata);
    const stored = isRecord(cloned)
      ? cloned
      : panic("metadata is not an object");
    expect(Object.keys(stored)).toContain(CZ_NS_COLLECTION_METADATA_KEY);
    expect(readStoredCzNsCollectionEntry(stored)?.number).toBe("9");
    expect(readStoredCzNsCollectionEntry({})).toBeNull();
    expect(
      readStoredCzNsCollectionEntry({
        [CZ_NS_COLLECTION_METADATA_KEY]: { postId: 1 },
      }),
    ).toBeNull();
  });
});
