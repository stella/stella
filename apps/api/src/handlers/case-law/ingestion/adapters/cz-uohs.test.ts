import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";

import { isDocumentAst } from "@stll/legal-ast/document-ast";

import { decodeSourceRawEnvelope } from "@/api/handlers/case-law/ingestion/adapter";
import {
  CZ_UOHS_SYNTHETIC_LISTING,
  czUohsSyntheticPdf,
} from "@/api/handlers/case-law/ingestion/adapters/__fixtures__/cz-uohs.synthetic";
import {
  buildCzUohsDecision as uncheckedBuildCzUohsDecision,
  czUohsAdapter,
  czUohsCollectionOf,
  czUohsDecisionIdentifiers,
  czUohsLetterheadDate,
  encodeCzUohsCursor,
  parseCzUohsDocumentPdf as uncheckedParseCzUohsDocumentPdf,
  parseCzUohsListing,
} from "@/api/handlers/case-law/ingestion/adapters/cz-uohs";
import {
  extractPlPdfSeparatedContent,
  PL_PDF_PARAGRAPH_START,
} from "@/api/handlers/case-law/ingestion/parsers/pl-sn";
import { publishedCaseLawDecisionIndexPredicateSql } from "@/api/lib/case-law/published-decisions-sql";
import { savePdfRewrite } from "@/api/lib/files/pdf-signatures";
import { guardParser } from "@/api/tests/helpers/parser-reader-guard";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

const buildCzUohsDecision = guardParser(uncheckedBuildCzUohsDecision);
const parseCzUohsDocumentPdf = guardParser(uncheckedParseCzUohsDocumentPdf);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const records = async () => parseCzUohsListing(CZ_UOHS_SYNTHETIC_LISTING);

const CAPTURED_FOOTNOTES = {
  "cz-uohs-2026-R0137.pdf": [
    "Ve správním spise se nachází pod položkou č. 16.",
    "Ve správním spise se nachází pod položkou č. 17.",
    "Ve správním spise se nachází pod položkou č. 19.",
    "Ve správním spise se nachází pod položkou č. 20.",
    "Ve správním spise se nachází pod položkou č. 1.",
    "Pro posouzení zákonnosti postupu zadavatele je rozhodné znění zákona k okamžiku zahájení zadávacího řízení, a to vyjma ustanovení upravených zákonem č. 69/2025 Sb., a zákonem č. 238/2024 Sb. Postup ve správním řízení se řídí právními předpisy účinnými ke dni zahájení správního řízení.",
    "Ve správním spise se nachází pod položkou č. 18.",
    "Ve správním spise se nachází pod položkou č. 22.",
  ],
  "cz-uohs-2026-S0383.pdf": [
    ...[11, 33, 60, 75, 148, 76, 77, 78, 79, 80, 81, 82, 83, 84].map(
      (number) =>
        `Pozn. Úřadu: logový záznam č. ${number} ve výpisu z „Access logu“.`,
    ),
    "https://portal-vz.cz/elektronicke-zadavani-verejnych-zakazek/seznam-certifikovanych-el-nastroju-dle-zakona-c-134-2016- sb/",
  ],
} as const;

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
      expect(decision.metadata).toMatchObject({
        decisionDateSource: "document",
      });
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

  test.each([
    ["cz-uohs-2026-R0137.pdf", CAPTURED_FOOTNOTES["cz-uohs-2026-R0137.pdf"]],
    ["cz-uohs-2026-S0383.pdf", CAPTURED_FOOTNOTES["cz-uohs-2026-S0383.pdf"]],
  ] as const)(
    "reads %s without page furniture and emits increasing paragraph numbers",
    async (fixture, expectedFootnotes) => {
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
      const numbers = ast.blocks.flatMap((block) =>
        block.type === "paragraph" && block.number !== undefined
          ? [block.number]
          : [],
      );
      expect(numbers.slice(0, 3)).toEqual([1, 2, 3]);
      expect(numbers).toEqual(numbers.map((_, index) => index + 1));

      const notes = ast.blocks.filter(
        (block) =>
          block.type === "paragraph" && block.note?.type === "footnote",
      );
      const body = ast.blocks.filter(
        (block) => !(block.type === "paragraph" && block.note !== undefined),
      );
      const bodyJson = JSON.stringify(body);
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.map(({ plainText }) => plainText)).toEqual([
        ...expectedFootnotes,
      ]);
      expect(notes.map(({ anchorId }) => anchorId).toSorted()).toEqual(
        [...bodyJson.matchAll(/"href":"#([^"]+)"/gu)]
          .map((match) => match[1]!)
          .toSorted(),
      );
      expect(new Set(notes.map(({ plainText }) => plainText)).size).toBe(
        notes.length,
      );
      for (const note of notes) {
        expect(note.plainText.length).toBeGreaterThan(0);
        expect(
          body.some(({ plainText }) => plainText.includes(note.plainText)),
        ).toBe(false);
      }
      const bodyText = body.map(({ plainText }) => plainText).join("\n");
      expect(bodyText).not.toContain("1/12 třída Kpt. Jaroše");
      expect(bodyText).not.toContain(
        "Ve správním spise se nachází pod položkou",
      );
    },
  );

  test("keeps a raised reference immediately after its claim inside a line", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("first claim", { x: 72, y: 650, size: 12 });
    page.drawText("1", { x: 123, y: 652, size: 7 });
    page.drawText("; second claim", { x: 127, y: 650, size: 12 });
    page.drawText("Body text establishes the ordinary font size.", {
      x: 72,
      y: 620,
      size: 12,
    });
    page.drawText("1", { x: 72, y: 120, size: 7 });
    page.drawText("Source for the first claim.", { x: 72, y: 105, size: 8 });
    const saved = await savePdfRewrite({ pdf, source: new Uint8Array() });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") {
      return;
    }
    const extracted = await PDF.load(saved.bytes);
    expect(
      extracted
        .getPages()
        .at(0)
        ?.extractText()
        .lines.at(0)
        ?.spans.map(({ text }) => text),
    ).toEqual(["first claim", "1", "; second claim"]);
    const ast = await parseCzUohsDocumentPdf(saved.bytes, {
      caseNumber: "synthetic-reference",
      sourceUrl: "synthetic-reference",
    });
    const paragraph = ast.blocks.find((block) =>
      block.plainText.includes("first claim"),
    );
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") {
      return;
    }
    expect(paragraph.inlines.slice(0, 3)).toEqual([
      { type: "text", text: "first claim" },
      {
        type: "link",
        href: "#footnote-1",
        children: [
          { type: "superscript", children: [{ type: "text", text: "1" }] },
        ],
      },
      {
        type: "text",
        text: "; second claim Body text establishes the ordinary font size.",
      },
    ]);
  });

  test("keeps an unlabelled page-top continuation in the previous footnote until body resumes", async () => {
    const pdf = PDF.create();
    const first = pdf.addPage({ size: "letter" });
    first.drawText("First body paragraph with a reference", {
      x: 72,
      y: 650,
      size: 12,
    });
    first.drawText("1", { x: 274, y: 654, size: 7 });
    first.drawText("1", { x: 72, y: 120, size: 7 });
    first.drawText("Note begins on the first page", { x: 72, y: 105, size: 8 });
    const second = pdf.addPage({ size: "letter" });
    second.drawText("and continues at the next page top.", {
      x: 72,
      y: 720,
      size: 8,
    });
    second.drawText("Body resumes here with ordinary text.", {
      x: 72,
      y: 650,
      size: 12,
    });
    second.drawText("Small body text after the body resumes.", {
      x: 72,
      y: 620,
      size: 8,
    });
    second.drawText("More ordinary body text establishes the body font size.", {
      x: 72,
      y: 590,
      size: 12,
    });
    const saved = await savePdfRewrite({ pdf, source: new Uint8Array() });
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") {
      return;
    }
    const separated = await extractPlPdfSeparatedContent(
      saved.bytes,
      PL_PDF_PARAGRAPH_START.INDENT_OR_OUTDENT,
    );
    expect(separated.notes).toMatchObject([
      { type: "text", footnote: { label: "1", noteId: "footnote-1" } },
      { type: "text", footnote: { label: "1", noteId: "footnote-1" } },
    ]);
    const ast = await parseCzUohsDocumentPdf(saved.bytes, {
      caseNumber: "synthetic-continuation",
      sourceUrl: "synthetic-continuation",
    });
    const notes = ast.blocks.filter(
      (block) => block.type === "paragraph" && block.note !== undefined,
    );
    expect(notes).toHaveLength(1);
    expect(notes.at(0)).toMatchObject({
      note: { type: "footnote", label: "1", noteId: "footnote-1" },
      plainText:
        "Note begins on the first page and continues at the next page top.",
    });
    const bodyText = ast.blocks
      .filter((block) => block.type === "paragraph" && block.note === undefined)
      .map(({ plainText }) => plainText)
      .join(" ");
    expect(bodyText).not.toContain("Note begins");
    expect(bodyText).not.toContain("and continues at the next page top.");
    expect(bodyText).toContain("Small body text after the body resumes.");
  });

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
    // The label with an unreadable value does not borrow another date.
    expect(
      czUohsLetterheadDate(
        "Datum, místo neuvedeno\nPodnět ze dne 5. 3. 2026, Brno",
      ),
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
    // The links point at the file the text was read from, not the first one.
    expect(decision.documentUrl).toBe("https://uohs.gov.cz/second.pdf");
    const ast = decision.documentAst;
    expect(isDocumentAst(ast) ? ast.source.printUrl : undefined).toBe(
      "https://uohs.gov.cz/second.pdf",
    );
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
