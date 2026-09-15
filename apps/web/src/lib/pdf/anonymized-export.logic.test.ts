import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import {
  buildAnonymizedExportMasks,
  extractAnonymizedExportText,
} from "@/lib/pdf/anonymized-export.logic";

const loadPages = async (pdf: PDF) =>
  (await PDF.load(await pdf.save())).getPages();

describe("anonymized PDF export masks", () => {
  test("rejects matched text whose coordinates cannot produce a valid mask", () => {
    for (const box of [
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: -1, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
    ]) {
      const result = buildAnonymizedExportMasks({
        extraction: { text: "x", glyphs: [{ pageIndex: 0, box }] },
        terms: ["x"],
      });
      expect(result.isErr()).toBe(true);
    }
  });

  test("covers the exact glyphs of a proportional-width match", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("Wide narrow", { x: 50, y: 700, size: 18 });
    const pages = await loadPages(pdf);
    const extraction = extractAnonymizedExportText(pages);
    const masks = buildAnonymizedExportMasks({
      extraction,
      terms: ["narrow"],
    }).unwrap();
    const source = pages.at(0)?.extractText().lines.at(0)?.spans.at(0);
    const mask = masks.get(0)?.at(0);

    expect(mask).toBeDefined();
    expect(source).toBeDefined();
    if (!mask || !source) {
      throw new Error("Expected a mask and source span");
    }
    expect(mask.x).toBeGreaterThan(source.bbox.x);
    expect(mask.x + mask.width).toBeLessThanOrEqual(
      source.bbox.x + source.bbox.width,
    );
  });

  test("keeps repeated occurrences on separate lines and pages", async () => {
    const pdf = PDF.create();
    const first = pdf.addPage({ size: "letter" });
    first.drawText("needle", { x: 50, y: 700, size: 18 });
    first.drawText("needle", { x: 50, y: 650, size: 18 });
    const second = pdf.addPage({ size: "letter" });
    second.drawText("needle", { x: 50, y: 700, size: 18 });

    const extraction = extractAnonymizedExportText(await loadPages(pdf));
    const masks = buildAnonymizedExportMasks({
      extraction,
      terms: ["needle", "needle"],
    }).unwrap();

    expect(masks.get(0)).toHaveLength(2);
    expect(masks.get(1)).toHaveLength(1);
  });

  test("matches vocabulary terms across extracted line breaks", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("Acme", { x: 50, y: 700, size: 18 });
    page.drawText("Holdings", { x: 50, y: 675, size: 18 });

    const extraction = extractAnonymizedExportText(await loadPages(pdf));
    const masks = buildAnonymizedExportMasks({
      extraction,
      terms: ["Acme Holdings"],
    }).unwrap();

    expect(masks.get(0)).toHaveLength(2);
  });

  test("does not cap a large set of matches at the preview limit", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    for (let index = 0; index < 125; index += 1) {
      page.drawText("needle", {
        x: 50,
        y: 750 - index * 5,
        size: 4,
      });
    }

    const extraction = extractAnonymizedExportText(await loadPages(pdf));
    const masks = buildAnonymizedExportMasks({
      extraction,
      terms: ["needle"],
    }).unwrap();

    expect(masks.get(0)).toHaveLength(125);
  });

  test("rejects a matched term without source glyph coordinates", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("source", { x: 50, y: 700, size: 18 });
    const extraction = extractAnonymizedExportText(await loadPages(pdf));
    extraction.glyphs.fill(null);

    expect(
      buildAnonymizedExportMasks({ extraction, terms: ["source"] }).isErr(),
    ).toBe(true);
  });

  test("rejects zero-width matched glyphs", async () => {
    const pdf = PDF.create();
    pdf
      .addPage({ size: "letter" })
      .drawText("source", { x: 50, y: 700, size: 18 });
    const extraction = extractAnonymizedExportText(await loadPages(pdf));
    for (const glyph of extraction.glyphs) {
      if (glyph !== null) {
        glyph.box.width = 0;
      }
    }
    expect(
      buildAnonymizedExportMasks({ extraction, terms: ["source"] }).isErr(),
    ).toBe(true);
  });

  test("does not mutate the source PDF while building masks", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("keep this source", { x: 50, y: 700, size: 18 });
    const before = page.extractText();
    const extraction = extractAnonymizedExportText([page]);

    buildAnonymizedExportMasks({ extraction, terms: ["source"] }).unwrap();

    expect(page.extractText()).toEqual(before);
  });

  test("maps a UTF-16 surrogate-pair match to both code-unit glyphs", async () => {
    const pdf = PDF.create();
    const page = pdf.addPage({ size: "letter" });
    page.drawText("A", { x: 50, y: 700, size: 18 });
    const extraction = extractAnonymizedExportText(await loadPages(pdf));
    const glyph = extraction.glyphs.find((entry) => entry !== null);
    if (!glyph) {
      throw new Error("fixture did not produce a glyph");
    }
    extraction.text = "😀";
    extraction.glyphs = [glyph, glyph];

    expect(
      buildAnonymizedExportMasks({ extraction, terms: ["😀"] })
        .unwrap()
        .get(0),
    ).toHaveLength(1);
  });
});
