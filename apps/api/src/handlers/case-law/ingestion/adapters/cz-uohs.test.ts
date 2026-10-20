import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import {
  CZ_UOHS_SYNTHETIC_LISTING,
  czUohsSyntheticPdf,
} from "@/api/handlers/case-law/ingestion/adapters/__fixtures__/cz-uohs.synthetic";
import {
  buildCzUohsDecision,
  czUohsAdapter,
  czUohsCollectionOf,
  czUohsDecisionIdentifiers,
  czUohsLetterheadDate,
  encodeCzUohsCursor,
  parseCzUohsDocumentPdf,
  parseCzUohsListing,
} from "@/api/handlers/case-law/ingestion/adapters/cz-uohs";
import { publishedCaseLawDecisionIndexPredicateSql } from "@/api/lib/case-law/published-decisions-sql";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const records = async () => parseCzUohsListing(CZ_UOHS_SYNTHETIC_LISTING);

describe("ÚOHS JSON-LD", () => {
  test("maps every stated field and discriminates collections without a default", async () => {
    const listed = await records();
    const first = listed[0]!;
    expect(czUohsCollectionOf(first)).toBe("verejne-zakazky");
    expect(czUohsCollectionOf(listed[1]!)).toBe("hospodarska-soutez");
    expect(czUohsCollectionOf(listed[2]!)).toBe("verejna-podpora");
    expect(first).toEqual(
      expect.objectContaining({
        číslo_jednací: "90001/2026/163",
        spisová_značka: "R0901/2026/VZ",
        věc: { cs: "Fiktivní veřejná zakázka na dodávku techniky" },
        instance: ["https://uohs.gov.cz/cs/ciselniky/instance/2.html"],
      }),
    );
    expect(listed[1]!.datum_právní_moci).toBeUndefined();
    expect(czUohsCollectionOf(listed[3]!)).toBeUndefined();
  });

  test("keeps a decision from an unknown department with no collection", async () => {
    globalThis.fetch = asFetchMock(
      async () => new Response("unavailable", { status: 500 }),
    );
    const unknown = (await records())[3]!;
    const decision = await buildCzUohsDecision(unknown);
    expect(decision.sourceDocumentId).toBe(unknown.iri);
    expect(decision.metadata["collection"]).toBeNull();
    expect(JSON.stringify(decision.metadata["department"])).toBe(
      JSON.stringify(unknown.odbor),
    );
  });

  test("an unchanged decision keeps its fingerprint across reads", async () => {
    const bytes = czUohsSyntheticPdf();
    globalThis.fetch = asFetchMock(async () => new Response(bytes));
    const record = (await records())[0]!;
    const first = await buildCzUohsDecision(record);
    const second = await buildCzUohsDecision(record);
    expect(second.rawHash).toBe(first.rawHash);
    expect(second.sourceRaw).toBe(first.sourceRaw);
  });

  test.each([
    ["cz-uohs-2026-R0137.pdf", "2026-10-12"],
    ["cz-uohs-2026-S0383.pdf", "2026-08-13"],
  ])(
    "reads the issue date from the letterhead of the captured %s",
    async (fixture, issued) => {
      const bytes = new Uint8Array(
        await Bun.file(
          new URL(`__fixtures__/${fixture}`, import.meta.url),
        ).arrayBuffer(),
      );
      globalThis.fetch = asFetchMock(async () => new Response(bytes));
      const decision = await buildCzUohsDecision((await records())[0]!);
      expect(decision.decisionDate).toBe(issued);
      expect(String(decision.metadata["decisionDateSource"])).toBe("document");
      expect(decision.metadata["decisionDateAvailability"]).toBeUndefined();
    },
  );

  test("a document without a letterhead date marks the date as not published", async () => {
    globalThis.fetch = asFetchMock(
      async () => new Response(czUohsSyntheticPdf()),
    );
    const decision = await buildCzUohsDecision((await records())[0]!);
    expect(decision.fulltext).toContain("Fiktivni rozhodnuti");
    expect(decision.decisionDate).toBeUndefined();
    expect(JSON.stringify(decision.metadata["decisionDateAvailability"])).toBe(
      JSON.stringify({ status: "not-published-by-source" }),
    );
  });

  test.each(["cz-uohs-2026-R0137.pdf", "cz-uohs-2026-S0383.pdf"])(
    "reads %s as paragraphs and emits no paragraph number it cannot vouch for",
    async (fixture) => {
      const bytes = new Uint8Array(
        await Bun.file(
          new URL(`__fixtures__/${fixture}`, import.meta.url),
        ).arrayBuffer(),
      );
      const ast = await parseCzUohsDocumentPdf(bytes, {
        caseNumber: fixture,
        sourceUrl: fixture,
      });
      expect(ast.blocks.length).toBeGreaterThan(10);
      // Footnotes and the running footer interleave the numbered reasoning in
      // the text layer, so the shared reader rejects the numbering: no number
      // is emitted until the page-furniture layer separates them.
      expect(
        ast.blocks.some(
          (block) => block.type === "paragraph" && block.number !== undefined,
        ),
      ).toBe(false);
    },
  );

  test("a document without numbered paragraphs gets no paragraph numbers", async () => {
    const ast = await parseCzUohsDocumentPdf(czUohsSyntheticPdf(), {
      caseNumber: "synthetic",
      sourceUrl: "synthetic",
    });
    expect(ast.blocks.length).toBeGreaterThan(0);
    expect(
      ast.blocks.some(
        (block) => block.type === "paragraph" && block.number !== undefined,
      ),
    ).toBe(false);
  });

  test("only the labelled letterhead date is the issue date", () => {
    const letterhead =
      "Č. j. ÚOHS-1/2026/163\nDatum, místo 12. 10. 2026, Brno\n";
    expect(czUohsLetterheadDate(letterhead)).toBe("2026-10-12");
    // A body date carries no place, and a date needs the letterhead label.
    expect(
      czUohsLetterheadDate("Datum, místo\nÚřad obdržel dne 5. 3. 2026 podnět"),
    ).toBeUndefined();
    expect(
      czUohsLetterheadDate("Rozhodnutí 12. 10. 2026, Brno"),
    ).toBeUndefined();
    expect(
      czUohsLetterheadDate("Datum, místo 31. 2. 2026, Brno"),
    ).toBeUndefined();
    expect(
      czUohsLetterheadDate(
        `${"x".repeat(2000)}Datum, místo 12. 10. 2026, Brno`,
      ),
    ).toBeUndefined();
  });

  test("the date of legal force is not the decision date", async () => {
    globalThis.fetch = asFetchMock(
      async () => new Response("unavailable", { status: 500 }),
    );
    const record = (await records())[0]!;
    const decision = await buildCzUohsDecision(record);
    expect(decision.decisionDate).toBeUndefined();
    expect(JSON.stringify(decision.metadata["legalForceDate"])).toBe(
      JSON.stringify(record.datum_právní_moci),
    );
  });

  test("emits citation-shaped authority identifiers", async () => {
    expect(czUohsDecisionIdentifiers((await records())[0]!)).toEqual([
      { type: "authority-decision-number", value: "úohs-r0901/2026/vz" },
      { type: "authority-decision-number", value: "úohs-90001/2026/163" },
    ]);
  });

  test("fetches the PDF and retains both raw responses with provenance", async () => {
    const bytes = czUohsSyntheticPdf();
    globalThis.fetch = asFetchMock(
      async () =>
        new Response(bytes, { headers: { "Content-Type": "application/pdf" } }),
    );
    const decision = await buildCzUohsDecision((await records())[0]!);
    expect(decision.fulltext).toContain("Fiktivni rozhodnuti");
    expect(decision.sourceRawObjects?.["document"]?.bytes).toEqual(bytes);
    const raw = decodeSourceRawEnvelope(decision.sourceRaw ?? "");
    expect(JSON.parse(raw?.["listing"] ?? "null")).toEqual(
      (await records())[0],
    );
    expect(JSON.parse(raw?.["provenance"] ?? "null")).toEqual(
      expect.objectContaining({
        listing: expect.objectContaining({
          url: "https://uohs.gov.cz/opendata/rozhodnuti.jsonld",
          sha256: expect.any(String),
        }),
        documents: {
          document: expect.objectContaining({ sha256: expect.any(String) }),
        },
      }),
    );
    expect(JSON.stringify(decision.metadata["participants"])).toBe(
      JSON.stringify([{ typ: "Osoba", jméno: { cs: "obec Fiktivní Lhota" } }]),
    );
    expect(String(decision.decisionType)).toBe(
      "https://uohs.gov.cz/cs/ciselniky/typy-rozhodnuti/36.html",
    );
  });

  test("keeps PDF bytes when text extraction fails", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    globalThis.fetch = asFetchMock(async () => new Response(bytes));
    const decision = await buildCzUohsDecision((await records())[0]!);
    expect(decision.sourceRawObjects?.["document"]?.bytes).toEqual(bytes);
    expect(decision.metadata["documentExtraction"]).toEqual(
      expect.objectContaining({ type: "failed" }),
    );
  });

  test("keeps an unreadable PDF as typed text absence and continues", async () => {
    globalThis.fetch = asFetchMock(
      async () => new Response("unavailable", { status: 500 }),
    );
    const decision = await buildCzUohsDecision((await records())[0]!);
    expect(decision.textFields.summary).toEqual({
      type: "absent",
      reason: "parse_failed",
    });
    expect(decision.isListingOnly).toBe(true);
    expect(decision.metadata["readOutcome"]).toEqual(
      expect.objectContaining({ type: "unavailable", scope: "document" }),
    );
    expect(decision.metadata["documentExtraction"]).toEqual(
      expect.objectContaining({
        type: "failed",
        failures: [expect.objectContaining({ type: "fetch-failed" })],
      }),
    );
  });

  test("stores every document and chooses the first parseable one as fulltext", async () => {
    const listed = await records();
    const record = {
      ...listed[0]!,
      dokument: [
        { typ: "Digitální objekt", url: "https://uohs.gov.cz/first.pdf" },
        { typ: "Digitální objekt", url: "https://uohs.gov.cz/second.pdf" },
      ],
    };
    const invalid = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const valid = czUohsSyntheticPdf();
    let request = 0;
    globalThis.fetch = asFetchMock(
      async () => new Response(request++ === 0 ? invalid : valid),
    );
    const decision = await buildCzUohsDecision(record);
    expect(decision.fulltext).toContain("Fiktivni rozhodnuti");
    expect(Object.keys(decision.sourceRawObjects ?? {})).toEqual([
      "document",
      "document-1",
    ]);
    const provenance = JSON.parse(
      decodeSourceRawEnvelope(decision.sourceRaw ?? "")?.["provenance"] ??
        "null",
    );
    expect(Object.keys(provenance.documents)).toEqual([
      "document",
      "document-1",
    ]);
  });

  test("reads a multi-page listing once and uses a stable cursor", async () => {
    const [template] = await records();
    const listing = {
      rozhodnutí: Array.from({ length: 21 }, (_, index) => ({
        ...template!,
        iri: `https://uohs.gov.cz/cs/verejne-zakazky/detail-${String(index).padStart(2, "0")}.html`,
        číslo_jednací: `${index}/2026/163`,
        spisová_značka: `R${index}/2026/VZ`,
        dokument: [],
      })),
    };
    let listingRequests = 0;
    globalThis.fetch = asFetchMock(async () => {
      listingRequests += 1;
      return Response.json(listing);
    });
    const first = (await czUohsAdapter.fetchPage(null, {}, undefined)).unwrap();
    const second = (
      await czUohsAdapter.fetchPage(first.nextCursor, {}, undefined)
    ).unwrap();
    expect(first.decisions).toHaveLength(20);
    expect(second.decisions).toHaveLength(1);
    expect(listingRequests).toBe(1);
    expect(second.nextCursor).not.toBe(first.nextCursor);
  });

  test("a parked walk resumes after its frontier, not from the start", async () => {
    const [template] = await records();
    const make = (id: string) => ({
      ...template!,
      iri: `https://uohs.gov.cz/cs/verejne-zakazky/detail-${id}.html`,
      číslo_jednací: `${id}/2026/163`,
      spisová_značka: `R${id}/2026/VZ`,
      dokument: [],
    });
    globalThis.fetch = asFetchMock(async () =>
      Response.json({ rozhodnutí: [make("01"), make("02"), make("03")] }),
    );
    const parked = encodeCzUohsCursor({
      version: 1,
      afterId: make("02").iri,
      parkedOn: "2000-01-01",
    });
    const page = (
      await czUohsAdapter.fetchPage(parked, {}, undefined)
    ).unwrap();
    expect(
      page.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual([make("03").iri]);
  });

  test("refuses a cursor it did not write instead of restarting the walk", async () => {
    let requests = 0;
    globalThis.fetch = asFetchMock(async () => {
      requests += 1;
      return Response.json({ rozhodnutí: [] });
    });
    const page = await czUohsAdapter.fetchPage("40", {}, undefined);
    expect(Result.isError(page)).toBe(true);
    expect(requests).toBe(0);
  });

  test("a stable key cursor does not skip an insertion between pages", async () => {
    const [template] = await records();
    const make = (id: string) => ({
      ...template!,
      iri: `https://uohs.gov.cz/cs/verejne-zakazky/detail-${id}.html`,
      číslo_jednací: `${id}/2026/163`,
      spisová_značka: `R${id}/2026/VZ`,
      dokument: [],
    });
    let listing = {
      rozhodnutí: Array.from({ length: 21 }, (_, index) =>
        make(String(index * 2).padStart(2, "0")),
      ),
    };
    globalThis.fetch = asFetchMock(async () => Response.json(listing));
    const first = (await czUohsAdapter.fetchPage(null, {}, undefined)).unwrap();
    listing = { rozhodnutí: [...listing.rozhodnutí, make("39")] };
    // A process restart drops the bulk snapshot; the durable key still resumes
    // after the last identity instead of applying a shifted integer offset.
    expect(first.nextCursor).not.toBeNull();
    if (first.nextCursor === null) {
      return;
    }
    const cursor = JSON.parse(first.nextCursor);
    cursor.snapshotId = "not-cached";
    const second = (
      await czUohsAdapter.fetchPage(JSON.stringify(cursor), {}, undefined)
    ).unwrap();
    expect(
      second.decisions.map(({ sourceDocumentId }) => sourceDocumentId),
    ).toEqual([
      "https://uohs.gov.cz/cs/verejne-zakazky/detail-39.html",
      "https://uohs.gov.cz/cs/verejne-zakazky/detail-40.html",
    ]);
  });

  test("the whole-listing tip slice reconciles every collection", async () => {
    const [template] = await records();
    const rozhodnutí = CZ_COLLECTION_URLS.map(([collection, url], index) => ({
      ...template!,
      iri: `https://uohs.gov.cz/cs/${collection}/detail-${index}.html`,
      odbor: [url],
      dokument: [],
    }));
    globalThis.fetch = asFetchMock(async () => Response.json({ rozhodnutí }));
    const page = await czUohsAdapter.reconciliation.listSlicePage({
      slice: "all",
      page: 0,
      signal: undefined,
    });
    expect(
      page.items.map(({ identity }) =>
        identity.type === "document" ? identity.sourceDocumentId : null,
      ),
    ).toEqual(rozhodnutí.map(({ iri }) => iri).toSorted());
    expect(
      rozhodnutí.map(() => czUohsAdapter.reconciliation.sliceOf(new Date())),
    ).toEqual(["all", "all", "all", "all", "all"]);
  });

  test("returns a tagged listing error instead of throwing", async () => {
    globalThis.fetch = asFetchMock(
      async () => new Response("unavailable", { status: 503 }),
    );
    const outcome = await czUohsAdapter.fetchPage(null, {}, undefined);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error).toEqual(
        expect.objectContaining({ _tag: "AdapterFetchError" }),
      );
    }
  });

  test("keeps a redacted ÚOHS decision outside the published view", () => {
    expect(publishedCaseLawDecisionIndexPredicateSql()).toContain(
      "redacted_at IS NULL",
    );
  });
});

const CZ_COLLECTION_URLS = [
  ["hospodarska-soutez", "https://uohs.gov.cz/cs/hospodarska-soutez.html"],
  ["verejne-zakazky", "https://uohs.gov.cz/cs/verejne-zakazky.html"],
  ["verejna-podpora", "https://uohs.gov.cz/cs/verejna-podpora.html"],
  ["vyznamna-trzni-sila", "https://uohs.gov.cz/cs/vyznamna-trzni-sila.html"],
  [
    "pristup-k-dopravni-infrastrukture",
    "https://uohs.gov.cz/cs/pristup-k-dopravni-infrastrukture.html",
  ],
] as const;
