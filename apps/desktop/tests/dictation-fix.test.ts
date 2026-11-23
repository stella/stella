import { describe, expect, test } from "bun:test";

import {
  isFixRequest,
  isFixSaved,
  pickWords,
  wordRange,
} from "../src/dictation/dictation-fix";
import { isLearnedView, listedFixes } from "../src/mainview/dictation-learned";

describe("fix panel", () => {
  test("a word next to the picked ones joins them, up to three words", () => {
    const first = wordRange(null, 4);
    expect(first).toEqual({ end: 4, start: 4 });
    const two = wordRange(first, 5);
    expect(two).toEqual({ end: 5, start: 4 });
    const three = wordRange(two, 3);
    expect(three).toEqual({ end: 5, start: 3 });
    // A fourth word starts over.
    expect(wordRange(three, 6)).toEqual({ end: 6, start: 6 });
    // So does a word that is not next to them.
    expect(wordRange(first, 8)).toEqual({ end: 8, start: 8 });
  });

  test("picked words read as one phrase", () => {
    const words = ["Ask", "jon", "smith", "today"];
    expect(pickWords(words, { end: 2, start: 1 })).toBe("jon smith");
  });

  test("only the shapes the native side sends are read", () => {
    expect(isFixRequest({ lastWords: ["a"], selection: null })).toBe(true);
    expect(isFixRequest({ lastWords: [], selection: "Novak" })).toBe(true);
    expect(isFixRequest({ lastWords: [1], selection: null })).toBe(false);
    expect(isFixSaved({ status: "saved" })).toBe(true);
    expect(isFixSaved({ reason: "tooManyWords", status: "refused" })).toBe(
      true,
    );
    expect(isFixSaved({ reason: "other", status: "refused" })).toBe(false);
    expect(isFixSaved({ status: "notSaved" })).toBe(true);
    expect(isFixSaved(null)).toBe(false);
  });
});

describe("learned fixes", () => {
  const fix = (status: string) => ({
    from: "novak",
    seen: 2,
    status,
    to: "Novák",
  });

  test("Settings lists fixes that are on or switched off", () => {
    const view = {
      fixes: [fix("learning"), fix("on"), fix("off"), fix("contradicted")],
    };
    expect(isLearnedView(view)).toBe(true);
    if (isLearnedView(view)) {
      expect(listedFixes(view.fixes).map(({ status }) => status)).toEqual([
        "on",
        "off",
      ]);
    }
  });

  test("an unknown status is not read", () => {
    expect(isLearnedView({ fixes: [fix("maybe")] })).toBe(false);
    expect(isLearnedView({})).toBe(false);
  });
});
