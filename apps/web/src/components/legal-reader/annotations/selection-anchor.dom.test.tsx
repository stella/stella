import { renderToStaticMarkup } from "react-dom/server";

/* oxlint-disable no-untranslated-jsx-literal/no-untranslated-jsx-literal -- Static reader chrome fixture, never user-facing copy. */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { plainTextOf } from "@stll/legal-ast/document-ast";
import type { Inline } from "@stll/legal-ast/inline";

import { unregisterDomEnvironment } from "@/test-dom-environment";

import { selectionAnchorsFrom } from "./selection-anchor";

GlobalRegistrator.register();
const { InlineContent } =
  await import("@stll/decision-reader/document-ast-text");

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});
afterAll(async () => await unregisterDomEnvironment());

const fixture = (inlines: Inline[]) => {
  const root = document.createElement("article");
  // safe-html: React renderToStaticMarkup escapes the inline fixture text.
  root.innerHTML = renderToStaticMarkup(
    <p data-anchor="paragraph-anchor">
      <span data-reader-chrome="">
        {"¶99"}
        <br />
        {"Permalink"}
      </span>
      <InlineContent
        activeMatchIndex={-1}
        inlines={inlines}
        pieceId="internal-block-id"
        ranges={[]}
      />
    </p>,
  );
  document.body.append(root);
  const paragraph = root.querySelector("p");
  if (!paragraph) {
    throw new TypeError("Missing rendered paragraph");
  }
  const selection = document.getSelection();
  if (!selection) {
    throw new TypeError("Missing DOM selection");
  }
  return { root, paragraph, selection };
};

const inlineFixtures = [
  [
    { type: "text", text: "Before" },
    { type: "line-break" },
    { type: "text", text: "after" },
  ],
  [
    { type: "text", text: "Before" },
    { type: "line-break" },
    { type: "line-break" },
    { type: "bold", children: [{ type: "text", text: "😀after" }] },
  ],
  [
    { type: "text", text: "A citation " },
    {
      type: "citation",
      cite: "metadata only",
      children: [{ type: "text", text: "reference" }],
    },
    { type: "line-break" },
    { type: "page-anchor", label: "123" },
    { type: "text", text: "after" },
  ],
] satisfies Inline[][];

test.each(inlineFixtures.map((inlines, index) => ({ inlines, index })))(
  "reader selection preserves the rendered inline character axis $index",
  ({ inlines }) => {
    const { root, paragraph, selection } = fixture(inlines);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.addRange(range);
    const raw = plainTextOf(inlines);
    expect(raw).toContain("\n");
    expect(selectionAnchorsFrom(selection, root)).toEqual([
      {
        blockAnchorId: "paragraph-anchor",
        startOffset: 0,
        endOffset: raw.length,
        quote: raw,
        quotePrefix: "",
        quoteSuffix: "",
      },
    ]);
  },
);

test("element boundaries around each line break use the same offsets as text after it", () => {
  const inlines = inlineFixtures.at(1);
  if (!inlines) {
    throw new TypeError("Missing line-break fixture");
  }
  const { root, paragraph, selection } = fixture(inlines);
  const raw = plainTextOf(inlines);
  const children = [...paragraph.childNodes];
  let breaks = 0;
  for (const [index, child] of children.entries()) {
    if (!(child instanceof Element) || child.tagName !== "BR") {
      continue;
    }
    for (const offset of [index, index + 1]) {
      const range = document.createRange();
      range.setStart(paragraph, offset);
      range.setEnd(paragraph, children.length);
      selection.removeAllRanges();
      selection.addRange(range);
      // Leading line breaks are trimmed from the quote, but their original
      // characters still determine where the words begin in the paragraph.
      expect(selectionAnchorsFrom(selection, root)).toEqual([
        {
          blockAnchorId: "paragraph-anchor",
          startOffset: raw.indexOf("😀after"),
          endOffset: raw.length,
          quote: "😀after",
          // The context is the block's own words, line breaks included.
          quotePrefix: raw.slice(0, raw.indexOf("😀after")),
          quoteSuffix: "",
        },
      ]);
    }
    breaks++;
  }
  expect(breaks).toBe(2);
  const strong = paragraph.querySelector("strong");
  const text = strong?.firstChild;
  if (!(text instanceof Text)) {
    throw new TypeError("Missing styled text");
  }
  const range = document.createRange();
  range.setStart(text, 2);
  range.setEnd(text, text.length);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(selectionAnchorsFrom(selection, root)).toEqual([
    {
      blockAnchorId: "paragraph-anchor",
      startOffset: raw.indexOf("after"),
      endOffset: raw.length,
      quote: "after",
      quotePrefix: raw.slice(0, raw.indexOf("after")),
      quoteSuffix: "",
    },
  ]);
});
