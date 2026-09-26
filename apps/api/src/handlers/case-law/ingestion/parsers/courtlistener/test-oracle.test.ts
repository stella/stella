import { expect, test } from "bun:test";

import { sourceWords, wordDifference } from "./test-oracle";

test("the HTML source walk detects lost cross-reference text inside a note", () => {
  const anchor = '<a href="#ref-fn1">the text accompanying note 1</a>';
  const source = `<html><body><footnote_body>See note <a class="footnote" href="#fn3">3</a>, supra, and ${anchor}.</footnote_body></body></html>`;
  const words = sourceWords("html", source);
  const afterLostAnchor = sourceWords("html", source.replace(anchor, ""));

  expect(words).toContain("3,");
  expect(words).toContain("accompanying");
  expect(wordDifference(words, afterLostAnchor)).toEqual({
    missing: ["note", "the", "text", "accompanying", "1."],
    extra: ["."],
  });
});
