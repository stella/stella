import { expect, test } from "bun:test";

import { RTF_CONTROLS } from "./rtf-control-vocabulary";
import { rtfControlResiduePattern } from "./rtf-reader";

test("the specification vocabulary is sorted, unique and covers its sections", () => {
  expect(RTF_CONTROLS).toEqual(RTF_CONTROLS.toSorted());
  expect(new Set(RTF_CONTROLS).size).toBe(RTF_CONTROLS.length);
  for (const control of [
    "loch",
    "hich",
    "dbch",
    "af",
    "ltrch",
    "rtlch",
    "uc",
    "upr",
    "ud",
    "pard",
    "plain",
    "par",
    "line",
    "tab",
    "fonttbl",
    "pict",
    "object",
    "maccPr",
    "*",
    "'",
    "\\",
    "{",
    "}",
    "\n",
    "\r",
  ]) {
    expect(RTF_CONTROLS).toContain(control);
  }
});

test("every specification control is recognized alone", () => {
  for (const control of RTF_CONTROLS) {
    const written = control === "'" ? "'7a" : control;
    expect(rtfControlResiduePattern().test(`\\${written}`)).toBe(true);
  }
});

test("unknown backslashed prose is not a control sequence", () => {
  for (const text of [
    String.raw`C:\records\exhibits`,
    String.raw`C:\file\temp`,
    String.raw`C:\b\i\f\u\v\s`,
    String.raw`\\server\share`,
    String.raw`"\u1234"`,
    String.raw`a literal \n`,
    String.raw`\lochish\hichish`,
  ]) {
    expect(rtfControlResiduePattern().test(text)).toBe(false);
  }
});

test("known symbols may precede text while the escaped backslash respects paths", () => {
  for (const text of [String.raw`\'e9clair`, String.raw`\~continued`]) {
    expect(rtfControlResiduePattern().test(text)).toBe(true);
  }
  expect(rtfControlResiduePattern().test(String.raw`\\server\share`)).toBe(
    false,
  );
});
