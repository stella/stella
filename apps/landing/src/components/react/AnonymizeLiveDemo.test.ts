import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { escapeRegExp } from "@stll/text-normalize";

import {
  buildSegments,
  INITIAL_TEXT,
  PRECOMPUTED_SAMPLE_MATCHES,
  PRECOMPUTED_SAMPLE_PAIRS,
  segmentsFromMatches,
  startEngine,
} from "./AnonymizeLiveDemo";

import { AhoCorasick } from "#aho-corasick";

const segments = (text: string, pairs: Parameters<typeof buildSegments>[1]) =>
  buildSegments(text, pairs, AhoCorasick);

describe("anonymization demo literal highlights", () => {
  test("uses the longest original at each position and first duplicate label", () => {
    expect(
      segments("Čapek, Čapkova a [a+b].", [
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
      segments("😀 Čapek Capek Čapek", [
        { original: "Čapek", label: "person" },
      ]),
    ).toEqual([
      { text: "😀 ", sourceStart: 0, sourceEnd: 3 },
      { text: "Čapek", bucket: "person", sourceStart: 3, sourceEnd: 8 },
      { text: " Capek ", sourceStart: 8, sourceEnd: 15 },
      { text: "Čapek", bucket: "person", sourceStart: 15, sourceEnd: 20 },
    ]);
    expect(
      segments("aaaaa", [{ original: "aa", label: "person" }]).map(
        ({ text }) => text,
      ),
    ).toEqual(["aa", "aa", "a"]);
    expect(
      segments("C\u030capek", [{ original: "Čapek", label: "person" }]),
    ).toEqual([{ text: "C\u030capek", sourceStart: 0, sourceEnd: 6 }]);
  });

  test("normalizes unpaired surrogates at the input boundary", () => {
    expect(
      segments("x\ud800y", [{ original: "\ud801", label: "person" }]),
    ).toEqual([
      { text: "x", sourceStart: 0, sourceEnd: 1 },
      { text: "�", bucket: "person", sourceStart: 1, sourceEnd: 2 },
      { text: "y", sourceStart: 2, sourceEnd: 3 },
    ]);
    expect(segments("😀", [{ original: "\ud83d", label: "person" }])).toEqual([
      { text: "😀", sourceStart: 0, sourceEnd: 2 },
    ]);
  });

  test("ignores empty originals before constructing the matcher", () => {
    expect(segments("😀", [{ original: "", label: "person" }])).toEqual([
      { text: "😀", sourceStart: 0, sourceEnd: 2 },
    ]);
    expect(
      segments("😀 Čapek", [
        { original: "", label: "organization" },
        { original: "Čapek", label: "person" },
      ]),
    ).toEqual([
      { text: "😀 ", sourceStart: 0, sourceEnd: 3 },
      { text: "Čapek", bucket: "person", sourceStart: 3, sourceEnd: 8 },
    ]);
  });

  test("keeps empty text and empty lists as one plain segment", () => {
    expect(segments("", [{ original: "Čapek", label: "person" }])).toEqual([
      { text: "", sourceStart: 0, sourceEnd: 0 },
    ]);
    expect(segments("Čapek", [])).toEqual([
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
        const built = segments(
          rawText,
          originals.map((original) => ({ original, label: "person" })),
        );
        expect(built.map(({ text: segmentText }) => segmentText).join("")).toBe(
          text,
        );
        expect(
          built
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

describe("anonymization demo first paint and engine start", () => {
  test("the precomputed sample matches are what the matcher finds", () => {
    expect(
      segmentsFromMatches(INITIAL_TEXT, PRECOMPUTED_SAMPLE_MATCHES),
    ).toEqual(segments(INITIAL_TEXT, PRECOMPUTED_SAMPLE_PAIRS));
  });

  const pairs = [{ original: "Čapek", label: "person" }];
  const run = async () => ({ pairs });
  const loadMatcher = async () => AhoCorasick;
  const failed = async (): Promise<never> => {
    throw new Error("download failed");
  };

  test("a run and a loaded matcher make the engine ready", async () => {
    expect(await startEngine("Čapek", { run, loadMatcher })).toEqual({
      status: "ready",
      pairs,
      Matcher: AhoCorasick,
    });
  });

  // The browser keeps a module that failed to load, so only a reload helps.
  test("a matcher that fails to load is an engine error recovered by reload", async () => {
    expect(await startEngine("Čapek", { run, loadMatcher: failed })).toEqual({
      status: "error",
      recovery: "reload",
    });
    expect(
      await startEngine("Čapek", { run: failed, loadMatcher: failed }),
    ).toEqual({ status: "error", recovery: "reload" });
  });

  test("a failed run is an engine error recovered by retry", async () => {
    expect(await startEngine("Čapek", { run: failed, loadMatcher })).toEqual({
      status: "error",
      recovery: "retry",
    });
  });

  // A value import would load the browser matcher's wasm with the island,
  // and a failed download would stop the demo from hydrating at all.
  test("the demo module loads the matcher only with the engine", async () => {
    const source = await Bun.file(
      new URL("AnonymizeLiveDemo.tsx", import.meta.url),
    ).text();
    expect(source).not.toMatch(
      /^import\s+(?!type\b)[^;]*["']#aho-corasick["']/mu,
    );
    expect(source).toContain('import("#aho-corasick")');
  });
});
