import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("source parsers cannot read the note collection without paragraph anchors", async () => {
  const source = [
    "const notes = document.package.footnotes;",
    'const alias = document.package; const copied = alias["footnotes"];',
    "const { footnotes: tailNotes } = document.package;",
    "const optional = document?.package?.footnotes;",
    "const template = document.package[`footnotes`];",
    'const { ["footnotes"]: computedNotes } = document.package;',
    'import { createParagraphFootnoteReader as loseMembership } from "./document-footnotes";',
    "const raw = owner.createParagraphFootnoteReader(document);",
    "const dynamic = document.package[key];",
    "const readLines = createParagraphLineReader(document, project);",
    "const anchored = readLines(paragraph);",
  ].join("\n");
  expect(await lintSingleRule("no-unanchored-footnotes", source)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
});

test("typed paragraph line readers preserve anchors without reading package notes", async () => {
  expect(
    await lintSingleRule(
      "no-unanchored-footnotes",
      [
        'import { createParagraphLineReader } from "./document-footnotes";',
        "const readLines = createParagraphLineReader(document, project);",
        "const lines = readLines(paragraph);",
        "const dynamic = document.package[key];",
      ].join("\n"),
    ),
  ).toEqual([]);
});
