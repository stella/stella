/**
 * `splitTextRunsByEastAsia` is the paint-side half of per-character East-Asian
 * font selection: a text run carrying an EA font is split into per-script
 * sub-runs (CJK → `eastAsiaFontFamily`, rest → `fontFamily`) before rendering,
 * with each sub-run keeping a contiguous, exact PM range so selection and
 * click-to-caret stay correct.
 */

import { describe, expect, test } from "bun:test";

import type { TextRun } from "../layout-engine/types";
import { splitTextRunsByEastAsia } from "./renderParagraph";

const textRun = (over: Partial<TextRun> & { text: string }): TextRun => ({
  kind: "text",
  ...over,
});

describe("splitTextRunsByEastAsia", () => {
  test("splits a mixed run into per-script sub-runs with the EA font on CJK", () => {
    const run = textRun({
      text: "AB世界CD",
      fontFamily: "Latin",
      eastAsiaFontFamily: "Mincho",
      pmStart: 10,
      pmEnd: 16,
    });

    const result = splitTextRunsByEastAsia([run]) as TextRun[];

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      text: "AB",
      fontFamily: "Latin",
      pmStart: 10,
      pmEnd: 12,
    });
    expect(result[1]).toMatchObject({
      text: "世界",
      fontFamily: "Mincho",
      pmStart: 12,
      pmEnd: 14,
    });
    expect(result[2]).toMatchObject({
      text: "CD",
      fontFamily: "Latin",
      pmStart: 14,
      pmEnd: 16,
    });
  });

  test("passes through a run with no EA font", () => {
    const run = textRun({
      text: "A世",
      fontFamily: "Latin",
      pmStart: 0,
      pmEnd: 2,
    });
    expect(splitTextRunsByEastAsia([run])).toEqual([run]);
  });

  test("passes through an EA-carrying run that has no CJK", () => {
    const run = textRun({
      text: "plain",
      fontFamily: "Latin",
      eastAsiaFontFamily: "Mincho",
      pmStart: 0,
      pmEnd: 5,
    });
    expect(splitTextRunsByEastAsia([run])).toEqual([run]);
  });

  test("sub-run PM ranges partition the original run exactly", () => {
    const run = textRun({
      text: "a世b界c",
      fontFamily: "L",
      eastAsiaFontFamily: "M",
      pmStart: 100,
      pmEnd: 105,
    });

    const result = splitTextRunsByEastAsia([run]) as TextRun[];

    expect(result[0]?.pmStart).toBe(100);
    expect(result.at(-1)?.pmEnd).toBe(105);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]?.pmStart).toBe(result[i - 1]?.pmEnd);
    }
  });

  test("preserves other run formatting on every sub-run", () => {
    const run = textRun({
      text: "x世",
      fontFamily: "Latin",
      eastAsiaFontFamily: "Mincho",
      bold: true,
      pmStart: 0,
      pmEnd: 2,
    });

    const result = splitTextRunsByEastAsia([run]) as TextRun[];

    expect(result.every((r) => r.bold === true)).toBe(true);
  });
});
