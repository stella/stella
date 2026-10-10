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
    "const dynamic = document.package[key];",
    "const notesAfter = createParagraphFootnoteReader(document);",
    "const anchored = notesAfter(paragraph);",
  ].join("\n");
  expect(await lintSingleRule("no-unanchored-footnotes", source)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
});
