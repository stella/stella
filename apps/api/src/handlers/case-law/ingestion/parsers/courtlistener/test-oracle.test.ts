import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sourceWords, wordDifference } from "./test-oracle";

test("the source walk keeps adjacent headings and page text from a recorded opinion", () => {
  const source = readFileSync(
    new URL(
      "__fixtures__/html/heading-4696496-discussion-ii.html",
      import.meta.url,
    ),
    "utf-8",
  );
  expect(sourceWords("html", source)).toEqual([
    "*45",
    "II.",
    "DISCUSSION",
    "A.",
    "RESPONDENT'S",
    "ADJUSTMENTS",
  ]);
});

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

test("the HTML source walk preserves literal less-than text", () => {
  expect(
    sourceWords("html", "<html><body>Less than 4 < 5 and x > 3</body></html>"),
  ).toEqual(["Less", "than", "4", "<", "5", "and", "x", ">", "3"]);
});

test("the HTML source walk ignores document metadata and templates", () => {
  expect(
    sourceWords(
      "html",
      "<html><head><title>Metadata only</title></head><body>Visible <template>Template only</template> text</body></html>",
    ),
  ).toEqual(["Visible", "text"]);
});

test("excluding a mid-word page marker keeps the word joined", () => {
  const source = "left<span>*2</span>right";
  expect(source.slice(10, 12)).toBe("*2");
  expect(
    sourceWords("html", source, { excludedSpans: [{ start: 10, end: 12 }] }),
  ).toEqual(["leftright"]);
});

test("excluding one note label still detects deletion of an identical numeric cross-reference", () => {
  const source =
    '<footnote_body><sup>1</sup> See note <a href="#fn1">1</a> above.</footnote_body>';
  // The first digit labels this note; the second digit is its substantive cross-reference.
  expect(source.slice(20, 21)).toBe("1");
  expect(source.slice(52, 53)).toBe("1");
  const options = { excludedSpans: [{ start: 20, end: 21 }] };
  const words = sourceWords("html", source, options);
  expect(words).toEqual(["See", "note", "1", "above."]);
  const deletedCrossReference = source.slice(0, 52) + source.slice(53);
  expect(
    wordDifference(words, sourceWords("html", deletedCrossReference, options)),
  ).toEqual({
    missing: ["1"],
    extra: [],
  });
});
