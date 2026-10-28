import { describe, expect, test } from "bun:test";

import {
  STAMP_DETAIL_COLOR,
  STAMP_NAME_COLOR,
} from "@/api/lib/files/pdf-signing/stamp-colors";
import {
  boldStampFonts,
  loadStampFonts,
} from "@/api/lib/files/pdf-signing/stamp-font";
import {
  FIRST_STRONG_ISOLATE,
  layoutStampColumns,
  layoutStampRow,
  POP_DIRECTIONAL_ISOLATE,
  type PositionedStampRow,
  STAMP_UNITS_PER_EM,
  type StampRow,
} from "@/api/lib/files/pdf-signing/stamp-layout";
import { STELLA_MARK_ASPECT } from "@/api/lib/files/pdf-signing/stamp-mark";

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

describe("the stamp columns", () => {
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
    const bold = boldStampFonts(fonts);
    return layoutStampColumns({
      direction,
      height,
      width,
      unit,
      mark: { aspect: STELLA_MARK_ASPECT },
      lines: {
        name,
        details: [
          { text: "Digitally signed by", signer: false },
          {
            text: `${FIRST_STRONG_ISOLATE}${name}${POP_DIRECTIONAL_ISOLATE}`,
            signer: true,
          },
          { text: "Date: 2026.10.08", signer: false },
          { text: "12:50:57 +02'00'", signer: false },
        ],
      },
      layoutRow: (text, weight) =>
        layoutStampRow({
          direction,
          fonts: weight === "bold" ? bold : fonts,
          text,
        }),
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
  const faceKeys = (row: PositionedStampRow | undefined) => [
    ...new Set(row?.row.runs.map(({ face }) => face.key)),
  ];
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
  const capHeight = (row: PositionedStampRow) =>
    Math.max(
      ...row.row.runs.map(
        ({ face: { font } }) => font.capHeight / font.unitsPerEm,
      ),
    ) * row.fontSize;

  test("sets the name bold in the left half, then a rule, then the details, all centred", async () => {
    const laidOut = await fitColumns("Jan Kubica");
    expect(laidOut).not.toBeNull();
    if (laidOut === null) {
      return;
    }
    const { rows, mark, rule } = laidOut;
    const { name, details } = columns(rows, 2);
    expect(texts(name)).toEqual(["Jan", "Kubica"]);
    expect(texts(details)).toEqual([
      "Digitally signed by",
      "Jan Kubica",
      "Date: 2026.10.08",
      "12:50:57 +02'00'",
    ]);

    // Bold and near-black for the name, in both columns; grey for the rest.
    for (const row of [...name, details.at(1)]) {
      expect(faceKeys(row)).toEqual(["DejaVuSansBold"]);
      expect(row?.color).toBe(STAMP_NAME_COLOR);
    }
    for (const row of [details.at(0), details.at(2), details.at(3)]) {
      expect(faceKeys(row)).toEqual(["DejaVuSans"]);
      expect(row?.color).toBe(STAMP_DETAIL_COLOR);
    }

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

    // The details are about 0.4 of the name size, in half points.
    const nameSize = name.at(0)?.fontSize ?? 0;
    const size = details.at(0)?.fontSize ?? 0;
    expect(details.every((row) => row.fontSize === size)).toBe(true);
    expect((size * 2) % 1).toBe(0);
    expect(size).toBeGreaterThanOrEqual(6);
    expect(size).toBeLessThanOrEqual(nameSize * 0.4 + 0.001);

    // The rule: one padding after the name, 1.5 pt, spanning the details.
    const detailsSpan = span(details);
    expect(rule).not.toBeNull();
    expect(rule?.width).toBeCloseTo(1.5);
    expect(rule?.x).toBeCloseTo(nameRight + 6 + 0.75);
    expect(rule?.top).toBeCloseTo(detailsSpan.top);
    expect(rule?.bottom).toBeCloseTo(detailsSpan.bottom);
    const column = (rule?.x ?? 0) + 0.75 + 6;
    for (const row of details.slice(1)) {
      expect(row.x).toBeCloseTo(column);
    }

    // The mark: one cap height, on the first row baseline, before its text.
    const [lead] = details;
    expect(mark).not.toBeNull();
    if (mark === null || lead === undefined) {
      return;
    }
    expect(mark.x).toBeCloseTo(column);
    expect(mark.y).toBeCloseTo(lead.y);
    expect(mark.height).toBeCloseTo(capHeight(lead));
    expect(mark.width).toBeCloseTo(mark.height * STELLA_MARK_ASPECT);
    expect(lead.x).toBeCloseTo(mark.x + mark.width + 0.4 * size);

    // Each column is centred vertically in the box.
    for (const block of [nameSpan, detailsSpan]) {
      expect((block.top + block.bottom) / 2).toBeCloseTo(40);
    }
  });

  test("keeps the details at 0.4 of the name size where the box has room", async () => {
    const rows = await fit("Jan Kubica", { width: 380, height: 100 });
    expect(rows).not.toBeNull();
    if (rows === null) {
      return;
    }
    const { name, details } = columns(rows, 2);
    const nameSize = name.at(0)?.fontSize ?? 0;
    expect(details.at(0)?.fontSize).toBe(Math.floor(nameSize * 0.4 * 2) / 2);
    for (const row of rows) {
      const edges = extent(row);
      expect(edges.right).toBeLessThanOrEqual(374.001);
      expect(edges.bottom).toBeGreaterThanOrEqual(5.999);
      expect(edges.top).toBeLessThanOrEqual(94.001);
    }
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
    const normal = await fitColumns("Jan Kubica");
    const scaled = await fitColumns("Jan Kubica", {
      width: 24,
      height: 8,
      unit: 0.1,
    });
    expect(normal).not.toBeNull();
    expect(scaled).not.toBeNull();
    if (normal === null || scaled === null) {
      return;
    }
    expect(scaled.rows).toHaveLength(normal.rows.length);
    for (const [index, row] of normal.rows.entries()) {
      const other = scaled.rows.at(index);
      expect((other?.fontSize ?? 0) * 10).toBeCloseTo(row.fontSize);
      expect((other?.x ?? 0) * 10).toBeCloseTo(row.x);
      expect((other?.y ?? 0) * 10).toBeCloseTo(row.y);
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      expect((scaled.mark?.[key] ?? 0) * 10).toBeCloseTo(
        normal.mark?.[key] ?? Number.NaN,
      );
    }
    for (const key of ["x", "top", "bottom", "width"] as const) {
      expect((scaled.rule?.[key] ?? 0) * 10).toBeCloseTo(
        normal.rule?.[key] ?? Number.NaN,
      );
    }
  });

  test("preserves whole shaped RTL words and puts the mark at the row start", async () => {
    const laidOut = await fitColumns(ARABIC_NAME, {
      width: 400,
      height: 120,
      direction: "rtl",
    });
    expect(laidOut).not.toBeNull();
    if (laidOut === null) {
      return;
    }
    const { rows, mark } = laidOut;
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
    // A right-to-left row starts on the right: the mark follows its text.
    const [lead] = details;
    expect(mark).not.toBeNull();
    if (mark === null || lead === undefined) {
      return;
    }
    expect(lead.x).toBeCloseTo(details.at(1)?.x ?? Number.NaN);
    expect(mark.x).toBeCloseTo(extent(lead).right + 0.4 * lead.fontSize);
    expect(mark.y).toBeCloseTo(lead.y);
    expect(mark.x + mark.width).toBeLessThanOrEqual(394.001);
  });
});
