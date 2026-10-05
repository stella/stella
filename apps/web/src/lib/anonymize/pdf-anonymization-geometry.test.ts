import { PDF } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { projectOverlayRects } from "@/lib/anonymize/overlay-rects";
import {
  extractPdfAnonymizationText,
  glyphBoxesByPage,
  locateAnonymizationTerm,
} from "@/lib/anonymize/pdf-anonymization-geometry";
import type {
  AnonymizationGlyph,
  PdfAnonymizationText,
} from "@/lib/anonymize/pdf-anonymization-geometry";
import { locateOverlayEntities } from "@/lib/pdf/anonymization-helpers";
import { buildAnonymizedExportMasks } from "@/lib/pdf/anonymized-export.logic";
import type { PDFSearchBox } from "@/lib/pdf/pdf-search";

const GLYPH_WIDTH = 8;
const GLYPH_HEIGHT = 12;
const LINE_HEIGHT = 20;
/** Enough words for repeats, substrings and several lines. */
const MAX_WORDS = 14;

type Layout = { words: string[]; separators: string[]; spaceGlyphs: boolean };

/**
 * Lay words out the way the extractor reports them: one box per character,
 * left to right per line, a line break with no glyph. Spaces carry a box or
 * not, as real PDFs do both.
 */
const layOut = ({ words, separators, spaceGlyphs }: Layout) => {
  const extraction: PdfAnonymizationText = { text: "", glyphs: [] };
  const parts: string[] = [];
  let line = 0;
  let column = 0;
  const pushChar = (char: string) => {
    parts.push(char);
    if (char === "\n") {
      extraction.glyphs.push(null);
      line += 1;
      column = 0;
      return;
    }
    const box = {
      x: column * GLYPH_WIDTH,
      // `0 - n`, not `-n`: line 0 must be +0, which toEqual tells from -0.
      y: 0 - line * LINE_HEIGHT,
      width: GLYPH_WIDTH,
      height: GLYPH_HEIGHT,
    };
    column += 1;
    extraction.glyphs.push(
      char === " " && !spaceGlyphs ? null : { pageIndex: 0, box },
    );
  };
  for (const [index, word] of words.entries()) {
    if (index > 0) {
      for (const char of separators[index - 1] ?? " ") {
        pushChar(char);
      }
    }
    for (const char of word) {
      pushChar(char);
    }
  }
  extraction.text = parts.join("");
  return extraction;
};

const center = ({ x, y, width, height }: PDFSearchBox) => ({
  x: x + width / 2,
  y: y + height / 2,
});

const contains = (outer: PDFSearchBox, point: { x: number; y: number }) =>
  point.x >= outer.x &&
  point.x <= outer.x + outer.width &&
  point.y >= outer.y &&
  point.y <= outer.y + outer.height;

const wordArbitrary = fc.stringMatching(/^[A-Za-z]{1,6}$/u);
const separatorArbitrary = fc.constantFrom(" ", "  ", "\n", " \n");

const layoutArbitrary = fc
  .integer({ min: 1, max: MAX_WORDS })
  .chain((count) =>
    fc.tuple(...Array.from({ length: count }, () => wordArbitrary)),
  )
  .chain((words) =>
    fc.record({
      words: fc.constant(words),
      separators: fc.tuple(...words.map(() => separatorArbitrary)),
      spaceGlyphs: fc.boolean(),
      termIndex: fc.integer({ min: 0, max: words.length - 1 }),
    }),
  );

describe("PDF anonymization geometry (properties)", () => {
  test(
    "covers exactly the matched characters, in the overlay and the export alike",
    () => {
      assertProperty(
        "covers exactly the matched characters, in the overlay and the export alike",
        fc.property(layoutArbitrary, ({ termIndex, ...layout }) => {
          const extraction = layOut(layout);
          const term = layout.words[termIndex] ?? "";
          const located = locateAnonymizationTerm(extraction, term).unwrap();

          const matched = new Set<AnonymizationGlyph>();
          for (const { start, end, glyphs } of located) {
            const expected = extraction.glyphs
              .slice(start, end)
              .filter((glyph) => glyph !== null);
            // Every visible character of the occurrence, and nothing else.
            expect(glyphs).toEqual(expected);
            for (const glyph of glyphs) {
              matched.add(glyph);
            }
          }

          const masks =
            buildAnonymizedExportMasks({ extraction, terms: [term] })
              .unwrap()
              .get(0) ?? [];
          const unmatched = extraction.glyphs.filter(
            (glyph): glyph is AnonymizationGlyph =>
              glyph !== null &&
              !matched.has(glyph) &&
              extraction.text.charAt(extraction.glyphs.indexOf(glyph)) !== " ",
          );
          for (const glyph of matched) {
            const point = center(glyph.box);
            expect(masks.some((mask) => contains(mask, point))).toBe(true);
          }
          for (const glyph of unmatched) {
            const point = center(glyph.box);
            expect(masks.some((mask) => contains(mask, point))).toBe(false);
          }

          // The overlay draws the same rectangles the export burns in.
          const entities = locateOverlayEntities({
            extraction,
            term,
            label: "PERSON",
            allocateId: (() => {
              let next = 0;
              return () => (next += 1);
            })(),
            seenRanges: new Set(),
          }).unwrap();
          const overlay = projectOverlayRects({
            entities,
            pageIndex: 0,
            viewport: { convertToViewportPoint: (x, y) => [x, y] },
          });
          const overlayBoxes = [...overlay.values()].flat();
          expect(overlayBoxes).toHaveLength(masks.length);
        }),
      );
    },
    propertyTestTimeout(20_000),
  );
});

describe("PDF anonymization geometry", () => {
  test("fails closed when a matched character has no glyph", () => {
    const extraction = layOut({
      words: ["Jan", "Novak"],
      separators: [" "],
      spaceGlyphs: true,
    });
    extraction.glyphs[5] = null;

    expect(locateAnonymizationTerm(extraction, "Novak").isErr()).toBe(true);
  });

  test("never bridges two occurrences across the text between them", () => {
    const extraction = layOut({
      words: ["Novak", "a", "Novak"],
      separators: [" ", " "],
      spaceGlyphs: true,
    });
    const between = extraction.glyphs[6];
    expect(between?.box).toBeDefined();
    if (!between) {
      return;
    }
    const exported =
      buildAnonymizedExportMasks({ extraction, terms: ["Novak"] })
        .unwrap()
        .get(0) ?? [];
    expect(exported).toHaveLength(2);
    expect(exported.some((mask) => contains(mask, center(between.box)))).toBe(
      false,
    );
  });

  test("merges one occurrence's glyphs into one box per line", () => {
    const extraction = layOut({
      words: ["Jan", "Novak"],
      separators: [" "],
      spaceGlyphs: true,
    });
    const [occurrence] = locateAnonymizationTerm(
      extraction,
      "Jan Novak",
    ).unwrap();
    expect(occurrence).toBeDefined();
    expect(glyphBoxesByPage(occurrence?.glyphs ?? []).get(0)).toEqual([
      { x: 0, y: 0, width: 9 * GLYPH_WIDTH, height: GLYPH_HEIGHT },
    ]);
  });

  // pdf.js ends a text-layer node at a run of spaces where the extraction
  // keeps one span; the glyph geometry does not depend on either split.
  test("covers exactly the term on a line with runs of spaces", async () => {
    const pdf = PDF.create();
    pdf
      .addPage({ size: "letter" })
      .drawText("Party     Jan  Novák      signs", {
        x: 50,
        y: 700,
        size: 12,
      });
    const pages = (await PDF.load(await pdf.save())).getPages();
    const extraction = extractPdfAnonymizationText(pages);
    const [occurrence] = locateAnonymizationTerm(extraction, "Novák").unwrap();
    expect(occurrence).toBeDefined();
    if (!occurrence) {
      return;
    }
    const masks = glyphBoxesByPage(occurrence.glyphs).get(0) ?? [];
    for (const [index, glyph] of extraction.glyphs.entries()) {
      if (glyph === null || /\s/u.test(extraction.text.charAt(index))) {
        continue;
      }
      const covered = masks.some((mask) => contains(mask, center(glyph.box)));
      expect({ index, covered }).toEqual({
        index,
        covered: index >= occurrence.start && index < occurrence.end,
      });
    }
  });

  test("the overlay and the export cover the same boxes on a real PDF", async () => {
    const pdf = PDF.create();
    const first = pdf.addPage({ size: "letter" });
    first.drawText("Contract between Jan Novák and Acme", {
      x: 50,
      y: 700,
      size: 14,
    });
    first.drawText("Novák signs below", { x: 72, y: 640, size: 11 });
    pdf
      .addPage({ size: "letter" })
      .drawText("Witness: Jan Novák", { x: 50, y: 700, size: 12 });
    const pages = (await PDF.load(await pdf.save())).getPages();
    const extraction = extractPdfAnonymizationText(pages);

    const exported = buildAnonymizedExportMasks({
      extraction,
      terms: ["Novák"],
    }).unwrap();
    const entities = locateOverlayEntities({
      extraction,
      term: "Novák",
      label: "PERSON",
      allocateId: (() => {
        let next = 0;
        return () => (next += 1);
      })(),
      seenRanges: new Set(),
    }).unwrap();

    for (const pageIndex of [0, 1]) {
      const overlay = entities.flatMap(
        (entity) => entity.boxesByPage.get(pageIndex) ?? [],
      );
      expect(overlay).toEqual(exported.get(pageIndex) ?? []);
      expect(overlay.length).toBeGreaterThan(0);
    }
  });
});
