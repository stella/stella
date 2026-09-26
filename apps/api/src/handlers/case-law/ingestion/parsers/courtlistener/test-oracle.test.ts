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
