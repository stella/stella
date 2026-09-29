import { describe, expect, test } from "bun:test";

import { loadStampFonts } from "@/api/lib/files/pdf-signing/stamp-font";
import {
  FIRST_STRONG_ISOLATE,
  layoutStampRow,
  POP_DIRECTIONAL_ISOLATE,
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
