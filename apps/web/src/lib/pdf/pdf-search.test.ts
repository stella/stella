import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  findPDFSearchResults,
  mergePDFSearchBoxes,
  toPDFSearchViewportBox,
} from "@/lib/pdf/pdf-search";

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

  test("reports truncation only after observing the cap plus one", async () => {
    const createPDFWithHits = async (count: number) => {
      const pdf = PDF.create();
      const page = pdf.addPage({ size: "letter" });
      page.drawText("hit ".repeat(count), { x: 20, y: 700, size: 8 });
      return await pdf.save();
    };

    const atCap = await findPDFSearchResults({
      bytes: await createPDFWithHits(200),
      searchText: "hit",
      signal: new AbortController().signal,
    });
    const overCap = await findPDFSearchResults({
      bytes: await createPDFWithHits(201),
      searchText: "hit",
      signal: new AbortController().signal,
    });

    expect(atCap?.matches).toHaveLength(200);
    expect(atCap?.truncated).toBe(false);
    expect(overCap?.matches).toHaveLength(200);
    expect(overCap?.truncated).toBe(true);
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
