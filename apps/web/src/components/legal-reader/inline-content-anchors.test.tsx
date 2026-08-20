import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type { Inline } from "@stll/legal-ast/document-ast";

import { InlineContent } from "@/components/legal-reader/document-ast-text";
import type { TextAnchor } from "@/components/legal-reader/document-ast-text";

const inlines: Inline[] = [
  { text: "srov. ", type: "text" },
  { children: [{ text: "nález I. ÚS 2447/13", type: "text" }], type: "bold" },
  { text: " a dále.", type: "text" },
];
const plainText = "srov. nález I. ÚS 2447/13 a dále.";

const anchor: TextAnchor = {
  end: plainText.indexOf("I. ÚS") + "I. ÚS 2447/13".length,
  key: "c1",
  render: (children) => <a href="/cited">{children}</a>,
  start: plainText.indexOf("I. ÚS"),
};

const render = ({
  activeMatchIndex = 0,
  anchors,
  ranges,
}: {
  activeMatchIndex?: number;
  anchors: TextAnchor[];
  ranges: { start: number; end: number; matchIndex: number }[];
}) =>
  renderToStaticMarkup(
    <InlineContent
      activeMatchIndex={activeMatchIndex}
      anchors={anchors}
      inlines={inlines}
      pieceId="p"
      ranges={ranges}
    />,
  );

/** The text a reader sees: markup parsed, not pattern-stripped. */
const visibleText = async (html: string): Promise<string> => {
  let text = "";
  await new HTMLRewriter()
    .onDocument({
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return text;
};

describe("InlineContent anchors", () => {
  test("wraps the anchored span and nothing else, across nested inlines", () => {
    const html = render({ anchors: [anchor], ranges: [] });

    expect(html).toBe(
      'srov. <strong class="font-[650]">nález <a href="/cited">I. ÚS 2447/13</a></strong> a dále.',
    );
  });

  test("a search match crossing the anchor boundary is split, both halves keep the index", async () => {
    // "nález I." spans the anchor start.
    const start = plainText.indexOf("nález");
    const end = plainText.indexOf("I.") + 2;
    const html = render({
      anchors: [anchor],
      ranges: [{ end, matchIndex: 0, start }],
    });

    const marks = html.match(/<mark[^>]*data-reader-match-index="0"[^>]*>/gu);
    expect(marks).toHaveLength(2);
    expect(html).toContain('<a href="/cited"><mark');
    // Visible text is untouched by either wrapping.
    expect(await visibleText(html)).toBe(plainText);
  });

  test("a citation inside a source link keeps the source link only", () => {
    const linked: Inline[] = [
      { text: "srov. ", type: "text" },
      {
        children: [{ text: "nález I. ÚS 2447/13", type: "text" }],
        href: "https://example.test/source",
        type: "link",
      },
    ];
    const text = "srov. nález I. ÚS 2447/13";
    const start = text.indexOf("I. ÚS");
    const html = renderToStaticMarkup(
      <InlineContent
        activeMatchIndex={-1}
        anchors={[
          {
            end: start + "I. ÚS 2447/13".length,
            key: "cited",
            render: (children) => <a href="/cited">{children}</a>,
            start,
          },
        ]}
        inlines={linked}
        pieceId="p"
        ranges={[]}
      />,
    );

    expect(html).toContain('href="https://example.test/source"');
    expect(html).not.toContain('href="/cited"');
    expect(html.match(/<a /gu)).toHaveLength(1);
  });

  test("without anchors the output is the plain highlight", () => {
    const plain = render({ anchors: [], ranges: [] });
    expect(plain).toBe(
      'srov. <strong class="font-[650]">nález I. ÚS 2447/13</strong> a dále.',
    );

    const start = plainText.indexOf("nález");
    const marked = render({
      anchors: [],
      ranges: [{ end: start + "nález".length, matchIndex: 0, start }],
    });
    expect(
      marked.match(/<mark[^>]*data-reader-match-index="0"[^>]*>/gu),
    ).toHaveLength(1);
    expect(marked).toContain("nález</mark>");
  });
});
