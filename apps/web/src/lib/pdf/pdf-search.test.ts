import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  findPDFSearchResults,
  mergePDFSearchBoxes,
  toPDFSearchViewportBox,
} from "@/lib/pdf/pdf-search";
import { MAX_SEARCH_PREVIEW_MATCHES } from "@/lib/search-match-navigation";

const createSearchablePDF = async () => {
  const pdf = PDF.create();
  const firstPage = pdf.addPage({ size: "letter" });
  firstPage.drawText("Introduction", { x: 50, y: 700, size: 18 });
  const secondPage = pdf.addPage({ size: "letter" });
  secondPage.drawText("Due Diligence Report", { x: 72, y: 640, size: 18 });
  secondPage.drawText("Another diligence review", {
    x: 72,
    y: 600,
    size: 18,
  });
  return await pdf.save();
};

describe("canonical PDF search", () => {
  test("finds case-insensitive text and returns LibPDF geometry", async () => {
    const result = await findPDFSearchResults({
      bytes: await createSearchablePDF(),
      searchText: "DILIGENCE",
      signal: new AbortController().signal,
    });

    expect(result?.matches).toHaveLength(2);
    expect(result?.matches.map((match) => match.pageIndex)).toEqual([1, 1]);
    expect(result?.matches.at(0)?.boxes.length).toBeGreaterThan(0);
    expect(result?.matches.at(0)?.boxes.at(0)?.width).toBeGreaterThan(0);
    expect(result?.matches.at(0)?.boxes.at(0)?.height).toBeGreaterThan(0);
  });

  test("normalizes OCR and embedded-text diacritic differences", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("odštepení", { x: 50, y: 700, size: 18 });

    const result = await findPDFSearchResults({
      bytes: await pdf.save(),
      searchText: "odštěpení",
      signal: new AbortController().signal,
    });

    expect(result?.matches).toHaveLength(1);
    expect(result?.matches.at(0)?.boxes.length).toBeGreaterThan(0);
  });

  test("finds every query term when the exact phrase is absent", async () => {
    const result = await findPDFSearchResults({
      bytes: await createSearchablePDF(),
      searchText: "introduction diligence",
      signal: new AbortController().signal,
    });

    expect(result?.matches.map((match) => match.pageIndex)).toEqual([0, 1, 1]);
  });

  test("finds every independently marked term even when one forms a phrase", async () => {
    const result = await findPDFSearchResults({
      bytes: await createSearchablePDF(),
      searchText: {
        type: "separate-terms",
        terms: ["Due Diligence", "Introduction"],
      },
      signal: new AbortController().signal,
    });

    expect(result?.matches.map((match) => match.pageIndex)).toEqual([0, 1]);
  });

  test("searches PDF portfolio pages in viewer render order", async () => {
    const createAttachment = async (
      pages: readonly { text: string; y: number }[],
    ) => {
      const pdf = PDF.create();
      for (const { text, y } of pages) {
        const page = pdf.addPage({ size: "letter" });
        page.drawText(text, { x: 50, y, size: 18 });
      }
      return await pdf.save();
    };

    const portfolio = PDF.create();
    const containerPage = portfolio.addPage({ size: "letter" });
    containerPage.drawText("needle in container", {
      x: 50,
      y: 700,
      size: 18,
    });
    portfolio.addAttachment(
      "z-second.pdf",
      await createAttachment([{ text: "needle second", y: 500 }]),
    );
    portfolio.addAttachment(
      "a-first.pdf",
      await createAttachment([
        { text: "needle first page", y: 700 },
        { text: "needle next page", y: 600 },
      ]),
    );
    portfolio.addAttachment("ignored.txt", new TextEncoder().encode("needle"));

    const result = await findPDFSearchResults({
      bytes: await portfolio.save(),
      searchText: "needle",
      signal: new AbortController().signal,
    });

    expect(result?.matches).toHaveLength(3);
    expect(result?.matches.map((match) => match.pageIndex)).toEqual([0, 1, 2]);
    expect(result?.matches.at(0)?.boxes.at(0)?.y).toBeGreaterThan(
      result?.matches.at(1)?.boxes.at(0)?.y ?? Number.POSITIVE_INFINITY,
    );
    expect(result?.matches.at(1)?.boxes.at(0)?.y).toBeGreaterThan(
      result?.matches.at(2)?.boxes.at(0)?.y ?? Number.POSITIVE_INFINITY,
    );
  });

  test("searches root pages when attachments do not form a portfolio", async () => {
    const attachment = PDF.create();
    const attachmentPage = attachment.addPage({ size: "letter" });
    attachmentPage.drawText("needle in attachment", {
      x: 50,
      y: 700,
      size: 18,
    });

    const pdf = PDF.create();
    const firstPage = pdf.addPage({ size: "letter" });
    firstPage.drawText("needle in root", { x: 50, y: 700, size: 18 });
    pdf.addPage({ size: "letter" });
    pdf.addAttachment("attachment.pdf", await attachment.save());

    const result = await findPDFSearchResults({
      bytes: await pdf.save(),
      searchText: "needle",
      signal: new AbortController().signal,
    });

    expect(result?.matches.map((match) => match.pageIndex)).toEqual([0]);
  });

  test("bounds one page at the global cap plus one", async () => {
    const createPDFWithHits = async (count: number) => {
      const pdf = PDF.create();
      const page = pdf.addPage({ size: "letter" });
      page.drawText("hit ".repeat(count), { x: 20, y: 700, size: 8 });
      return await pdf.save();
    };

    const atCap = await findPDFSearchResults({
      bytes: await createPDFWithHits(MAX_SEARCH_PREVIEW_MATCHES),
      searchText: "hit",
      signal: new AbortController().signal,
    });
    const overCap = await findPDFSearchResults({
      bytes: await createPDFWithHits(MAX_SEARCH_PREVIEW_MATCHES + 1),
      searchText: "hit",
      signal: new AbortController().signal,
    });

    expect(atCap?.matches).toHaveLength(MAX_SEARCH_PREVIEW_MATCHES);
    expect(atCap?.truncated).toBe(false);
    expect(overCap?.matches).toHaveLength(MAX_SEARCH_PREVIEW_MATCHES);
    expect(overCap?.truncated).toBe(true);
  });

  test("bounds normalized-only matches at the global cap plus one", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("odstepeni ".repeat(MAX_SEARCH_PREVIEW_MATCHES + 1), {
      x: 20,
      y: 700,
      size: 8,
    });

    const result = await findPDFSearchResults({
      bytes: await pdf.save(),
      searchText: "odštěpení",
      signal: new AbortController().signal,
    });

    expect(result?.matches).toHaveLength(MAX_SEARCH_PREVIEW_MATCHES);
    expect(result?.truncated).toBe(true);
  });

  test("stops before loading LibPDF when the search is cancelled", async () => {
    const abortController = new AbortController();
    abortController.abort();

    const result = await Result.tryPromise({
      try: async () =>
        await findPDFSearchResults({
          bytes: new Uint8Array(),
          searchText: "term",
          signal: abortController.signal,
        }),
      catch: (cause) => cause,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ name: "AbortError" });
    }
  });
});

describe("PDF search highlight geometry", () => {
  test("merges adjacent character boxes but preserves separate lines", () => {
    expect(
      mergePDFSearchBoxes([
        { x: 10, y: 20, width: 4, height: 8 },
        { x: 14, y: 20, width: 5, height: 8 },
        { x: 10, y: 8, width: 6, height: 8 },
      ]),
    ).toEqual([
      { x: 10, y: 20, width: 9, height: 8 },
      { x: 10, y: 8, width: 6, height: 8 },
    ]);
  });

  test("maps bottom-left PDF coordinates through the active viewport", () => {
    expect(
      toPDFSearchViewportBox(
        { x: 10, y: 20, width: 30, height: 5 },
        {
          convertToViewportPoint: (x, y) => [x * 2, 1000 - y * 2],
        },
      ),
    ).toEqual({ left: 20, top: 950, width: 60, height: 10 });
  });
});
