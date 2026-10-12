import { expect, test } from "bun:test";

import { RTF_CONTROLS } from "./rtf-control-vocabulary";
import { rtfControlResidueMatchesIn } from "./rtf-reader";

const matches = (text: string) => Array.from(rtfControlResidueMatchesIn(text));

test("the specification vocabulary is sorted, unique and covers its sections", () => {
  expect(Array.from(RTF_CONTROLS)).toEqual(RTF_CONTROLS.toSorted());
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
    expect(RTF_CONTROLS.some((entry) => entry === control)).toBe(true);
  }
});

test("every known control is recognized as a sole lexical token", () => {
  for (const control of RTF_CONTROLS) {
    const written = control === "'" ? "'7a" : control;
    const result = matches(`\\${written}`);
    expect(result).toHaveLength(1);
    expect(result.at(0)?.matched).toBe(`\\${written}`);
  }
});

test("every control word accepts RTF delimiters and optional signed parameters", () => {
  const words = RTF_CONTROLS.filter((control) => /^[a-zA-Z]+$/u.test(control));
  for (const word of words) {
    for (const delimiter of [" ", "\t", "\n", "\r", ".", "\\", "{", "}"]) {
      expect(matches(`\\${word}${delimiter}Continued`)).toHaveLength(1);
    }
  }
  expect(matches("\\fs-24 Continued")).toHaveLength(1);
  expect(matches("\\pard24")).toHaveLength(1);
  expect(matches("\\PARD ")).toHaveLength(0);
});

test("unknown and malformed control words are not recognized", () => {
  for (const text of [
    String.raw`\noise`,
    String.raw`\pard24X`,
    String.raw`\pardish `,
    `\\${"a".repeat(33)} `,
  ]) {
    expect(matches(text)).toHaveLength(0);
  }
  expect(matches(String.raw`\u-`)).toEqual([]);
  expect(matches(String.raw`\u-1`)).toHaveLength(1);
});

test("control symbols are recognized next to following text", () => {
  expect(matches(String.raw`\'e9clair`)).toHaveLength(1);
  expect(matches(String.raw`\~continued`)).toHaveLength(1);
});

test.each([
  String.raw`C:\file\temp`,
  String.raw`C:\b\i\f\u\v\s`,
  String.raw`\\server\share\file`,
  String.raw`(C:\file\temp)`,
  String.raw`[\\server\share\file]`,
  String.raw`"\u1234"`,
  String.raw`'\pard'`,
  String.raw`'The court's \par text'`,
  "`\\pard`",
  "```rtf\n\\pard\n```",
])("complete paths and quoted/code escapes are literal: %s", (text) => {
  expect(matches(text)).toEqual([]);
});

test("literal exclusions do not consume adjacent controls", () => {
  const text = String.raw`"\pard" C:\file\temp Text\pard Continued`;
  expect(matches(text)).toEqual([
    { index: text.lastIndexOf("\\pard"), matched: "\\pard" },
  ]);
  for (const adjacent of [
    String.raw`C:\file"\pard`,
    String.raw`"C:\file"\pard`,
    String.raw`C:\file)\pard`,
    String.raw`\\server\share"\pard`,
  ]) {
    expect(matches(adjacent)).toEqual([
      { index: adjacent.lastIndexOf("\\pard"), matched: "\\pard" },
    ]);
  }
  expect(matches(String.raw`C:\b\i\f\u\v\s`)).toEqual([]);
});
