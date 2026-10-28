import { describe, expect, test } from "bun:test";

import { loadStampFonts } from "@/api/lib/files/pdf-signing/stamp-font";
import {
  FIRST_STRONG_ISOLATE,
  layoutStampColumns,
  layoutStampRow,
  POP_DIRECTIONAL_ISOLATE,
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
  const fit = async (
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

  test("fills the left half with one name word per line and top-aligns the details", async () => {
    const rows = await fit("Jan Kubica");
    expect(rows).not.toBeNull();
    if (rows === null) {
      return;
    }
    const name = rows.filter(({ x }) => x < 120);
    const details = rows.filter(({ x }) => x > 120);
    expect(name.map(({ row }) => runTexts(row).join(""))).toEqual([
      "Jan",
      "Kubica",
    ]);
    expect(details.map(({ row }) => runTexts(row).join(""))).toEqual([
      "Digitally signed by",
      "Jan Kubica",
      "Date: 2026.10.08",
      "12:50:57 +02'00'",
    ]);
    const size = name.at(0)?.fontSize ?? 0;
    expect(size).toBeGreaterThan(details.at(0)?.fontSize ?? Infinity);
    for (const { row, fontSize, x, y } of rows) {
      const faces = row.runs.map(({ face }) => face.font);
      const ascent = Math.max(
        1,
        ...faces.map((font) => font.ascender / font.unitsPerEm),
      );
      const descent = Math.max(
        0,
        ...faces.map((font) => -font.descender / font.unitsPerEm),
      );
      expect(
        x + (row.width * fontSize) / STAMP_UNITS_PER_EM,
      ).toBeLessThanOrEqual(x < 120 ? 114.001 : 234.001);
      expect(y - descent * fontSize).toBeGreaterThanOrEqual(5.999);
      expect(y + ascent * fontSize).toBeLessThanOrEqual(74.001);
    }
    // At least one dimension binds: increasing the name size would overflow.
    const widest =
      Math.max(...name.map(({ row }) => row.width / STAMP_UNITS_PER_EM)) * size;
    const fonts = name.flatMap(({ row }) =>
      row.runs.map(({ face }) => face.font),
    );
    const ascent = Math.max(
      1,
      ...fonts.map((font) => font.ascender / font.unitsPerEm),
    );
    const descent = Math.max(
      0,
      ...fonts.map((font) => -font.descender / font.unitsPerEm),
    );
    const usedHeight =
      size * (ascent + descent + Math.max(1.25, ascent + descent));
    expect(
      Math.min(Math.abs(widest - 108), Math.abs(usedHeight - 68)),
    ).toBeLessThan(0.001);
    expect(
      (details.at(0)?.y ?? 0) + (details.at(0)?.fontSize ?? 0),
    ).toBeCloseTo(74);
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
    expect(
      rows.filter(({ x }) => x < 200).map(({ row }) => runTexts(row).join("")),
    ).toEqual(ARABIC_NAME.split(" "));
    expect(
      rows.filter(({ x }) => x > 200).map(({ row }) => runTexts(row).join("")),
    ).toContain(ARABIC_NAME);
    expect(
      rows.every(({ row }) =>
        row.runs.every(({ glyphs }) =>
          glyphs.every(({ glyphId }) => glyphId !== 0),
        ),
      ),
    ).toBe(true);
  });
});
