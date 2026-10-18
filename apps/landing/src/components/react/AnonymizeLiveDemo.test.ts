import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { escapeRegExp } from "@stll/text-normalize";

import { buildSegments } from "./AnonymizeLiveDemo";

describe("anonymization demo literal highlights", () => {
  test("uses the longest original at each position and first duplicate label", () => {
    expect(
      buildSegments("Čapek, Čapkova a [a+b].", [
        { original: "Čap", label: "organization" },
        { original: "Čapek", label: "person" },
        { original: "Čapek", label: "organization" },
        { original: "Čapkova", label: "person" },
        { original: "[a+b]", label: "misc" },
      ]),
    ).toEqual([
      { text: "Čapek", bucket: "person", sourceStart: 0, sourceEnd: 5 },
      { text: ", ", sourceStart: 5, sourceEnd: 7 },
      { text: "Čapkova", bucket: "person", sourceStart: 7, sourceEnd: 14 },
      { text: " a ", sourceStart: 14, sourceEnd: 17 },
      { text: "[a+b]", bucket: "misc", sourceStart: 17, sourceEnd: 22 },
      { text: ".", sourceStart: 22, sourceEnd: 23 },
    ]);
  });

  test("keeps case, accents, overlaps and UTF-16 source positions", () => {
    expect(
      buildSegments("😀 Čapek Capek Čapek", [
        { original: "Čapek", label: "person" },
      ]),
    ).toEqual([
      { text: "😀 ", sourceStart: 0, sourceEnd: 3 },
      { text: "Čapek", bucket: "person", sourceStart: 3, sourceEnd: 8 },
      { text: " Capek ", sourceStart: 8, sourceEnd: 15 },
      { text: "Čapek", bucket: "person", sourceStart: 15, sourceEnd: 20 },
    ]);
    expect(
      buildSegments("aaaaa", [{ original: "aa", label: "person" }]).map(
        ({ text }) => text,
      ),
    ).toEqual(["aa", "aa", "a"]);
    expect(
      buildSegments("C\u030capek", [{ original: "Čapek", label: "person" }]),
    ).toEqual([{ text: "C\u030capek", sourceStart: 0, sourceEnd: 6 }]);
  });

  test("normalizes unpaired surrogates at the input boundary", () => {
    expect(
      buildSegments("x\ud800y", [{ original: "\ud801", label: "person" }]),
    ).toEqual([
      { text: "x", sourceStart: 0, sourceEnd: 1 },
      { text: "�", bucket: "person", sourceStart: 1, sourceEnd: 2 },
      { text: "y", sourceStart: 2, sourceEnd: 3 },
    ]);
    expect(
      buildSegments("😀", [{ original: "\ud83d", label: "person" }]),
    ).toEqual([{ text: "😀", sourceStart: 0, sourceEnd: 2 }]);
  });

  test("ignores empty originals before constructing the matcher", () => {
    expect(buildSegments("😀", [{ original: "", label: "person" }])).toEqual([
      { text: "😀", sourceStart: 0, sourceEnd: 2 },
    ]);
    expect(
      buildSegments("😀 Čapek", [
        { original: "", label: "organization" },
        { original: "Čapek", label: "person" },
      ]),
    ).toEqual([
      { text: "😀 ", sourceStart: 0, sourceEnd: 3 },
      { text: "Čapek", bucket: "person", sourceStart: 3, sourceEnd: 8 },
    ]);
  });

  test("keeps empty text and empty lists as one plain segment", () => {
    expect(buildSegments("", [{ original: "Čapek", label: "person" }])).toEqual(
      [{ text: "", sourceStart: 0, sourceEnd: 0 }],
    );
    expect(buildSegments("Čapek", [])).toEqual([
      { text: "Čapek", sourceStart: 0, sourceEnd: 5 },
    ]);
  });
});

const characters = fc.constantFrom(
  "a",
  "A",
  "Č",
  "ě",
  "[",
  "]",
  "+",
  ".",
  " ",
  "\n",
  "\u030c",
  "😀",
  "\ud800",
  "\ud801",
);
const demoText = fc
  .array(characters, { maxLength: 40 })
  .map((parts) => parts.join(""));
const originalText = fc
  .array(characters, { maxLength: 8 })
  .map((parts) => parts.join(""));

test("demo engine agrees with longest-first scalar regex oracle", () => {
  assertProperty(
    "demo engine agrees with longest-first scalar regex oracle",
    fc.property(
      demoText,
      fc.array(originalText, { maxLength: 6 }),
      (rawText, originals) => {
        const text = rawText.toWellFormed();
        const needles = [
          ...new Set(
            originals
              .map((original) => original.toWellFormed())
              .filter((original) => original !== ""),
          ),
        ].toSorted((a, b) => b.length - a.length);
        const expected =
          text.length === 0 || needles.length === 0
            ? []
            : [
                ...text.matchAll(
                  new RegExp(needles.map(escapeRegExp).join("|"), "gu"),
                ),
              ].map(({ index, 0: match }) => ({
                start: index,
                end: index + match.length,
                text: match,
              }));
        const segments = buildSegments(
          rawText,
          originals.map((original) => ({ original, label: "person" })),
        );
        expect(
          segments.map(({ text: segmentText }) => segmentText).join(""),
        ).toBe(text);
        expect(
          segments
            .filter(({ bucket }) => bucket !== undefined)
            .map(
              ({ sourceStart: start, sourceEnd: end, text: segmentText }) => ({
                start,
                end,
                text: segmentText,
              }),
            ),
        ).toEqual(expected);
      },
    ),
  );
});
