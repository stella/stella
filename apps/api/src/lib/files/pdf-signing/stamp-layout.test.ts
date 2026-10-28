import { describe, expect, test } from "bun:test";

import { loadStampFonts } from "@/api/lib/files/pdf-signing/stamp-font";
import {
  FIRST_STRONG_ISOLATE,
  layoutStampColumns,
  layoutStampRow,
  POP_DIRECTIONAL_ISOLATE,
  type PositionedStampRow,
  STAMP_UNITS_PER_EM,
  type StampRow,
} from "@/api/lib/files/pdf-signing/stamp-layout";

const ARABIC_NAME = "محمد عبد الله";

/** Each run's text in reading order, the runs left to right as drawn. */
const runTexts = (row: StampRow) =>
  row.runs.map(({ clusterText }) => [...clusterText.values()].join(""));

describe("laying out a stamp row", () => {
  test("keeps the date after an isolated right-to-left name, where it was written", async () => {
    const fonts = await loadStampFonts();
    const isolated = layoutStampRow({
      direction: "ltr",
      fonts,
      text: `Digitally signed by ${FIRST_STRONG_ISOLATE}${ARABIC_NAME}${POP_DIRECTIONAL_ISOLATE} 2026-09-26`,
    });
    const bare = layoutStampRow({
      direction: "ltr",
      fonts,
      text: `Digitally signed by ${ARABIC_NAME} 2026-09-26`,
    });

    expect(runTexts(isolated)).toEqual([
      "Digitally signed by ",
      ARABIC_NAME,
      " 2026-09-26",
    ]);
    // Without the isolate the date joins the name's right-to-left run and
    // lands on the name's left: the failure the isolate exists for.
    expect(runTexts(bare).at(-1)).toContain(ARABIC_NAME.split(" ")[0]);
  });

  test("puts a right-to-left paragraph's first words on the right", async () => {
    const fonts = await loadStampFonts();
    const row = layoutStampRow({
      direction: "rtl",
      fonts,
      text: `المكان: ${FIRST_STRONG_ISOLATE}Brno${POP_DIRECTIONAL_ISOLATE}`,
    });

    expect(runTexts(row)).toEqual(["Brno", "المكان: "]);
  });

  test("draws each script in the face that owns it, and digits with their neighbours", async () => {
    const fonts = await loadStampFonts();
    const row = layoutStampRow({
      direction: "ltr",
      fonts,
      text: "Jan 東京2026 서울 नई दिल्ली กรุงเทพ",
    });

    expect(row.runs.map(({ face }) => face.key)).toEqual([
      "DejaVuSans",
      "NotoSansSC",
      "NotoSansKR",
      "NotoSansDevanagari",
      "NotoSansThai",
    ]);
    expect(runTexts(row)).toEqual([
      "Jan ",
      "東京2026 ",
      "서울 ",
      "नई दिल्ली ",
      "กรุงเทพ",
    ]);
  });

  test("shapes Arabic by position rather than one glyph per letter", async () => {
    const fonts = await loadStampFonts();
    const row = layoutStampRow({ direction: "rtl", fonts, text: "ببب" });
    const glyphs = row.runs.flatMap(({ glyphs: shaped }) =>
      shaped.map(({ glyphId }) => glyphId),
    );

    // Initial, medial and final beh are three different glyphs.
    expect(new Set(glyphs).size).toBe(3);
  });
});

describe("the stamp's two columns", () => {
  const fitColumns = async (
    name: string,
    {
      width = 240,
      height = 80,
      unit = 1,
      direction = "ltr",
    }: {
      width?: number;
      height?: number;
      unit?: number;
      direction?: "ltr" | "rtl";
    } = {},
  ) => {
    const fonts = await loadStampFonts();
    return layoutStampColumns({
      height,
      width,
      unit,
      lines: {
        name,
        details: [
          "Digitally signed by",
          `${FIRST_STRONG_ISOLATE}${name}${POP_DIRECTIONAL_ISOLATE}`,
          "Date: 2026.10.08",
          "12:50:57 +02'00'",
        ],
      },
      layoutRow: (text) => layoutStampRow({ direction, fonts, text }),
    });
  };
  const fit = async (...args: Parameters<typeof fitColumns>) =>
    (await fitColumns(...args))?.rows ?? null;

  /** Vertical extent and right edge of a positioned row, in points. */
  const extent = ({ row, fontSize, x, y }: PositionedStampRow) => {
    const faces = row.runs.map(({ face }) => face.font);
    const ascent = Math.max(
      1,
      ...faces.map((font) => font.ascender / font.unitsPerEm),
    );
    const descent = Math.max(
      0,
      ...faces.map((font) => -font.descender / font.unitsPerEm),
    );
    return {
      top: y + ascent * fontSize,
      bottom: y - descent * fontSize,
      right: x + (row.width * fontSize) / STAMP_UNITS_PER_EM,
    };
  };
  const texts = (rows: readonly PositionedStampRow[]) =>
    rows.map(({ row }) => runTexts(row).join(""));
  /** Both columns, the name rows first, as the layout returns them. */
  const columns = (rows: readonly PositionedStampRow[], nameWords: number) => ({
    name: rows.slice(0, nameWords),
    details: rows.slice(nameWords),
  });
  /** Top of the first row of a column and bottom of its last. */
  const span = (column: readonly PositionedStampRow[]) => {
    const [first] = column;
    const last = column.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("empty column");
    }
    return { top: extent(first).top, bottom: extent(last).bottom };
  };

  test("fills the box: one name word per line in the left half, details beside it, both centred", async () => {
    const rows = await fit("Jan Kubica");
    expect(rows).not.toBeNull();
    if (rows === null) {
      return;
    }
    const { name, details } = columns(rows, 2);
    expect(texts(name)).toEqual(["Jan", "Kubica"]);
    expect(texts(details)).toEqual([
      "Digitally signed by",
      "Jan Kubica",
      "Date: 2026.10.08",
      "12:50:57 +02'00'",
    ]);
    const size = name.at(0)?.fontSize ?? 0;
    expect(size).toBeGreaterThan(details.at(0)?.fontSize ?? Infinity);
    for (const row of rows) {
      const { top, bottom, right } = extent(row);
      expect(right).toBeLessThanOrEqual(234.001);
      expect(bottom).toBeGreaterThanOrEqual(5.999);
      expect(top).toBeLessThanOrEqual(74.001);
    }
    for (const row of name) {
      expect(row.x).toBeCloseTo(6);
      expect(extent(row).right).toBeLessThanOrEqual(114.001);
    }
    // At least one dimension binds: increasing the name size would overflow.
    const nameRight = Math.max(...name.map((row) => extent(row).right));
    const nameSpan = span(name);
    expect(
      Math.min(
        Math.abs(nameRight - 114),
        Math.abs(nameSpan.top - nameSpan.bottom - 68),
      ),
    ).toBeLessThan(0.001);
    // The details start one padding right of the widest name row.
    for (const row of details) {
      expect(row.x).toBeCloseTo(nameRight + 6);
    }
    // Each column is centred vertically in the box.
    for (const column of [name, details]) {
      const { top, bottom } = span(column);
      expect((top + bottom) / 2).toBeCloseTo(40);
    }
  });

  test("sizes the details to fill the box, with no fixed cap", async () => {
    const laidOut = await fitColumns("Jan Kubica", { width: 380, height: 100 });
    expect(laidOut).not.toBeNull();
    if (laidOut === null) {
      return;
    }
    const { rows } = laidOut;
    const { name, details } = columns(rows, 2);
    expect(details).toHaveLength(4);
    const fontSize = details.at(0)?.fontSize ?? 0;
    expect(fontSize).toBeGreaterThan(10);
    expect(details.every((row) => row.fontSize === fontSize)).toBe(true);
    expect((fontSize * 2) % 1).toBe(0);
    // With four unwrapped rows chosen, the same rows one half point larger
    // must overflow the width or the height, or that size would have won.
    const nameRight = Math.max(...name.map((row) => extent(row).right));
    const detailsWidth = 380 - 6 - (nameRight + 6);
    const next = fontSize + 0.5;
    const widest = Math.max(
      ...details.map(({ row }) => (row.width * next) / STAMP_UNITS_PER_EM),
    );
    const { top, bottom } = span(details);
    const nextHeight = ((top - bottom) * next) / fontSize;
    expect(widest > detailsWidth || nextHeight > 88).toBe(true);
    for (const row of rows) {
      const edges = extent(row);
      expect(edges.right).toBeLessThanOrEqual(374.001);
      expect(edges.bottom).toBeGreaterThanOrEqual(5.999);
      expect(edges.top).toBeLessThanOrEqual(94.001);
    }
    expect((top + bottom) / 2).toBeCloseTo(50);
    // The details box, which the mark fills, spans the column inside the
    // padding.
    expect(laidOut.details.x).toBeCloseTo(nameRight + 6);
    expect(laidOut.details.width).toBeCloseTo(detailsWidth);
    expect(laidOut.details.y).toBeCloseTo(6);
    expect(laidOut.details.height).toBeCloseTo(88);
  });

  test("shrinks a long name and refuses an unbreakable word below the readable size", async () => {
    const short = await fit("Jan Kubica");
    const long = await fit("Maximilián Křižovnický-Dvořáková");
    expect(long).not.toBeNull();
    expect(long?.at(0)?.fontSize ?? 0).toBeGreaterThanOrEqual(6);
    expect(long?.at(0)?.fontSize ?? Infinity).toBeLessThan(
      short?.at(0)?.fontSize ?? 0,
    );
    expect(await fit("W".repeat(64))).toBeNull();
  });

  test("keeps physical layout identical on pages with a UserUnit", async () => {
    const normal = await fit("Jan Kubica");
    const scaled = await fit("Jan Kubica", { width: 24, height: 8, unit: 0.1 });
    expect(normal).not.toBeNull();
    expect(scaled).not.toBeNull();
    if (normal === null || scaled === null) {
      return;
    }
    expect(scaled).toHaveLength(normal.length);
    for (const [index, row] of normal.entries()) {
      const other = scaled.at(index);
      expect((other?.fontSize ?? 0) * 10).toBeCloseTo(row.fontSize);
      expect((other?.x ?? 0) * 10).toBeCloseTo(row.x);
      expect((other?.y ?? 0) * 10).toBeCloseTo(row.y);
    }
  });

  test("preserves whole shaped RTL words in both columns", async () => {
    const rows = await fit(ARABIC_NAME, {
      width: 400,
      height: 120,
      direction: "rtl",
    });
    expect(rows).not.toBeNull();
    if (rows === null) {
      return;
    }
    const words = ARABIC_NAME.split(" ");
    const { name, details } = columns(rows, words.length);
    expect(texts(name)).toEqual(words);
    expect(texts(details)).toContain(ARABIC_NAME);
    expect(Math.min(...details.map(({ x }) => x))).toBeGreaterThan(
      Math.max(...name.map((row) => extent(row).right)),
    );
    expect(
      rows.every(({ row }) =>
        row.runs.every(({ glyphs }) =>
          glyphs.every(({ glyphId }) => glyphId !== 0),
        ),
      ),
    ).toBe(true);
  });
});
