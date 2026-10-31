import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  claimId,
  makeClaim,
  supported,
} from "@/features/avt/avt.test-fixtures";
import {
  claimPageNumbers,
  locateClaimsOnPages,
  resolvePdfClaimLocations,
  selectionVisitKey,
  translatePageRange,
  visitSelection,
} from "@/features/avt/original-pdf.logic";
import type { VerificationRun } from "@/features/avt/types";
import { extractPDFPageSearchTexts } from "@/lib/pdf/pdf-search";
import type { PageSearchText } from "@/lib/pdf/pdf-search";

/** Two pages with several lines, mixed font sizes on one line and a gap
 *  LibPDF turns into a synthetic space. */
const createStatementPDF = async () => {
  const pdf = PDF.create();
  const first = pdf.addPage({ size: "letter" });
  first.drawText("Witness statement", { x: 72, y: 700, size: 18 });
  first.drawText("The lease was signed on", { x: 72, y: 660, size: 12 });
  first.drawText("3 March 2021", { x: 72, y: 640, size: 14 });
  first.drawText("by both parties.", { x: 200, y: 640, size: 12 });
  const second = pdf.addPage({ size: "letter" });
  second.drawText("Rent fell due monthly.", { x: 72, y: 700, size: 12 });
  second.drawText("The lender refused the extension.", {
    x: 72,
    y: 680,
    size: 12,
  });
  return await pdf.save();
};

/** A real court ruling: published text, dense pages. */
const readRulingPDF = async () =>
  await Bun.file(
    new URL(
      "../../../../api/src/handlers/case-law/ingestion/parsers/__fixtures__/pl-uokik-ruling-vi-aca-527-08.pdf",
      import.meta.url,
    ),
  ).bytes();

/** The page text the server stores, read exactly as the API reads it. */
const serverPageTexts = async (bytes: Uint8Array) =>
  (await PDF.load(bytes))
    .extractText()
    .map((page) => ({ pageNumber: page.pageIndex + 1, text: page.text }));

const viewerPages = async (bytes: Uint8Array, pageNumbers: number[]) =>
  new Map(
    (
      await extractPDFPageSearchTexts({
        bytes,
        pageNumbers,
        signal: new AbortController().signal,
      })
    ).map((page): [number, PageSearchText] => [page.pageNumber, page]),
  );

const storedBlocks = (
  pages: readonly { pageNumber: number; text: string }[],
): VerificationRun["blocks"] =>
  pages.map((page, ordinal) => ({
    ordinal,
    blockId: `P${String(page.pageNumber)}`,
    kind: "pdf-page",
    pageNumber: page.pageNumber,
    text: page.text,
  }));

const pdfClaim = (
  suffix: number,
  pageNumber: number,
  start: number,
  end: number,
) =>
  makeClaim({
    suffix,
    verdict: supported(),
    anchor: { type: "pdf-page", pageNumber, start, end },
  });

describe("server and viewer page text parity", () => {
  test.each([
    ["a generated statement", createStatementPDF],
    ["a real ruling", readRulingPDF],
  ])(
    "%s: the viewer's page text is the stored text, unit for unit",
    async (_name, read) => {
      const bytes = await read();
      const server = await serverPageTexts(bytes);
      const viewer = await viewerPages(
        bytes,
        server.map((page) => page.pageNumber),
      );
      expect(server.length).toBeGreaterThan(0);
      for (const page of server) {
        const viewed = viewer.get(page.pageNumber);
        expect(viewed?.text).toBe(page.text);
        // One box slot per UTF-16 unit, so a stored offset indexes a box.
        expect(viewed?.boxesByOffset.length).toBe(page.text.length);
      }
      // Lines are joined by "\n" on both sides, with no box behind the join.
      const multiLine = server.find((page) => page.text.includes("\n"));
      const newline = multiLine?.text.indexOf("\n") ?? -1;
      expect(newline).toBeGreaterThan(0);
      expect(
        multiLine === undefined
          ? undefined
          : viewer.get(multiLine.pageNumber)?.boxesByOffset.at(newline),
      ).toBeNull();
    },
  );
});

describe("locateClaimsOnPages", () => {
  test("a stored offset range becomes boxes over exactly its words", async () => {
    const bytes = await createStatementPDF();
    const server = await serverPageTexts(bytes);
    const second = server.at(1) ?? panic("Missing second page");
    const words = "lender refused the extension";
    const start = second.text.indexOf(words);
    const crossLine = server.at(0) ?? panic("Missing first page");
    // A claim crossing a line break draws one box per line.
    const crossStart = crossLine.text.indexOf("signed on");
    const crossEnd = crossLine.text.indexOf("2021") + 4;
    const pages = await viewerPages(bytes, [1, 2]);

    const locations = locateClaimsOnPages({
      pages,
      blocks: storedBlocks(server),
      claims: [
        pdfClaim(2, 2, start, start + words.length),
        pdfClaim(1, 1, crossStart, crossEnd),
      ],
    });

    expect(locations.unlocated).toEqual([]);
    expect(locations.located.map((claim) => claim.claimId)).toEqual([
      claimId(1),
      claimId(2),
    ]);
    const [cross, single] = locations.located;
    expect(cross?.pageNumber).toBe(1);
    expect(cross?.boxes).toHaveLength(2);
    expect(single?.pageNumber).toBe(2);
    expect(single?.boxes).toHaveLength(1);
    const box = single?.boxes.at(0) ?? panic("Missing claim box");
    // The second line sits at y 680 and starts at x 72; the claim starts a
    // few words in, so its box starts right of the margin.
    expect(box.x).toBeGreaterThan(72);
    expect(box.y).toBeGreaterThan(670);
    expect(box.y).toBeLessThan(700);
    expect(box.width).toBeGreaterThan(0);
  });

  test("claims with no place in the original are reported in reading order", async () => {
    const bytes = await createStatementPDF();
    const server = await serverPageTexts(bytes);
    const pages = await viewerPages(bytes, [1, 2]);
    const blocks = storedBlocks(server);
    const changed = blocks.map((block) =>
      block.pageNumber === 2
        ? { ...block, text: "An earlier draft said something else." }
        : block,
    );

    const locations = locateClaimsOnPages({
      pages,
      blocks: changed,
      claims: [
        // Stored words no longer on the page the viewer reads.
        pdfClaim(3, 2, 3, 15),
        // A page the viewer did not read (past the end).
        pdfClaim(1, 9, 0, 4),
        // A DOCX anchor has no page.
        makeClaim({ suffix: 2, verdict: supported() }),
        // Offsets past the stored text.
        pdfClaim(4, 1, 0, 10_000),
      ],
    });

    expect(locations.located).toEqual([]);
    expect(locations.unlocated).toEqual([
      claimId(1),
      claimId(2),
      claimId(3),
      claimId(4),
    ]);
  });

  test("the pages to read are the claims' pages, once each", () => {
    expect(
      claimPageNumbers([
        pdfClaim(1, 3, 0, 1),
        pdfClaim(2, 1, 0, 1),
        pdfClaim(3, 3, 2, 4),
        makeClaim({ suffix: 4, verdict: supported() }),
      ]),
    ).toEqual([1, 3]);
  });
});

describe("resolvePdfClaimLocations", () => {
  const blocks = storedBlocks([{ pageNumber: 1, text: "Rent fell due." }]);
  const docxOnly = [
    makeClaim({ suffix: 2, verdict: supported() }),
    makeClaim({ suffix: 1, verdict: supported() }),
  ];

  test("a PDF run whose claims carry no page anchor lists every claim, reading no page text", () => {
    // No page text is read for such a run, so there is never data or an
    // error to wait for.
    expect(
      resolvePdfClaimLocations({
        pages: undefined,
        failed: false,
        blocks,
        claims: docxOnly,
      }),
    ).toEqual({
      status: "placed",
      locations: { located: [], unlocated: [claimId(1), claimId(2)] },
    });
  });

  test("waits for the page texts, and reports a failed read instead of listing every claim", () => {
    const onPage = [pdfClaim(1, 1, 0, 4)];
    expect(
      resolvePdfClaimLocations({
        pages: undefined,
        failed: false,
        blocks,
        claims: onPage,
      }),
    ).toEqual({ status: "reading" });
    expect(
      resolvePdfClaimLocations({
        pages: undefined,
        failed: true,
        blocks,
        claims: onPage,
      }),
    ).toEqual({ status: "failed" });
  });
});

// The PDF viewer does not render pages under happy-dom, so the scroll-once
// rule is held here, on the visit keys the drawn box compares.
describe("selection visits", () => {
  test("A, then an unlocated claim, then A again shows A's box anew", () => {
    const first = { id: "A", serial: 0 };
    const unlocated = visitSelection(first, "U");
    const again = visitSelection(unlocated, "A");
    expect(selectionVisitKey(again)).not.toBe(selectionVisitKey(first));
    expect(selectionVisitKey(unlocated)).not.toBe(selectionVisitKey(first));
  });

  test("the same selection redrawn keeps its visit, so it is not shown twice", () => {
    const first = { id: "A", serial: 0 };
    expect(visitSelection(first, "A")).toBe(first);
    expect(selectionVisitKey(visitSelection(first, "A"))).toBe(
      selectionVisitKey(first),
    );
  });
});

describe("translatePageRange", () => {
  test("identical texts map offsets unchanged", () => {
    expect(
      translatePageRange({
        stored: "abc def",
        page: "abc def",
        start: 4,
        end: 7,
      }),
    ).toEqual({ start: 4, end: 7 });
  });

  test("a changed page finds the stored words nearest their old offset", () => {
    const stored = "Paid. Paid in full. Paid late.";
    const page = "Note. Paid. Paid in full. Paid late. Paid in full.";
    const start = stored.indexOf("Paid in full");
    expect(
      translatePageRange({ stored, page, start, end: start + 12 }),
    ).toEqual({ start: 12, end: 24 });
  });

  test("case and diacritic differences still match, missing words do not", () => {
    expect(
      translatePageRange({
        stored: "Smlouva o odštěpení",
        page: "SMLOUVA O ODSTEPENI",
        start: 10,
        end: 19,
      }),
    ).toEqual({ start: 10, end: 19 });
    expect(
      translatePageRange({
        stored: "Rent fell due.",
        page: "Something else.",
        start: 0,
        end: 4,
      }),
    ).toBeNull();
  });
});
