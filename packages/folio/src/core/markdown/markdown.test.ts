// Feature coverage for the DOCX-document → Markdown export (eigenpal #595 port).
// Asserts the markdown subset skills rely on (headings, paragraphs, bold/italic,
// bullet + ordered lists, GFM tables, inline code, blockquotes, links) plus the
// clean-markdown preset (strip annotations/comments, flatten tracked changes,
// strip footnotes). The MD↔Document round-trip stability test lives with the
// skills bridge fixtures.

import { describe, expect, test } from "bun:test";

import type {
  BlockContent,
  Document,
  Hyperlink,
  ListRendering,
  Paragraph,
  Run,
  TextFormatting,
} from "../types/document";
import { toMarkdown } from "./index";
import type { MarkdownOptions } from "./types";

const run = (text: string, formatting?: TextFormatting): Run => ({
  type: "run",
  content: [{ type: "text", text }],
  ...(formatting ? { formatting } : {}),
});

const para = (
  content: Run[],
  extra?: { styleId?: string; listRendering?: ListRendering; paraId?: string },
): Paragraph => ({
  type: "paragraph",
  content,
  ...(extra?.styleId ? { formatting: { styleId: extra.styleId } } : {}),
  ...(extra?.listRendering ? { listRendering: extra.listRendering } : {}),
  ...(extra?.paraId ? { paraId: extra.paraId } : {}),
});

const doc = (content: BlockContent[]): Document => ({
  package: { document: { content } },
});

const md = (content: BlockContent[], opts?: MarkdownOptions): string =>
  toMarkdown(doc(content), opts);

const list = (
  level: number,
  isBullet: boolean,
  marker: string,
): ListRendering => ({
  marker,
  level,
  numId: 1,
  isBullet,
});

describe("toMarkdown — block structure", () => {
  test("heading style → ATX heading at the matching level", () => {
    expect(md([para([run("Title")], { styleId: "Heading1" })])).toBe("# Title");
    expect(md([para([run("Sub")], { styleId: "Heading3" })])).toBe("### Sub");
  });

  test("plain paragraphs join with a blank line", () => {
    expect(md([para([run("One")]), para([run("Two")])])).toBe("One\n\nTwo");
  });

  test("Quote style becomes a blockquote", () => {
    expect(md([para([run("Cited")], { styleId: "Quote" })])).toBe("> Cited");
  });

  test("bullet and ordered lists keep Word's exact marker", () => {
    const out = md([
      para([run("first")], { listRendering: list(0, true, "•") }),
      para([run("second")], { listRendering: list(0, true, "•") }),
    ]);
    expect(out).toBe("- first\n- second");

    const ordered = md([
      para([run("a")], { listRendering: list(0, false, "1.") }),
      para([run("b")], { listRendering: list(0, false, "2.") }),
    ]);
    expect(ordered).toBe("1. a\n2. b");
  });
});

describe("toMarkdown — inline marks", () => {
  test("bold, italic, and combined", () => {
    expect(md([para([run("x", { bold: true })])])).toBe("**x**");
    expect(md([para([run("x", { italic: true })])])).toBe("*x*");
    expect(md([para([run("x", { bold: true, italic: true })])])).toBe(
      "***x***",
    );
  });

  test("strikethrough", () => {
    expect(md([para([run("x", { strike: true })])])).toBe("~~x~~");
  });

  test("inline code is inferred from a monospace font", () => {
    expect(
      md([para([run("code()", { fontFamily: { ascii: "Consolas" } })])]),
    ).toBe("`code()`");
  });

  test("a hyperlink renders inline", () => {
    const link: Hyperlink = {
      type: "hyperlink",
      href: "https://example.com",
      children: [run("here")],
    };
    expect(toMarkdown(doc([{ type: "paragraph", content: [link] }]))).toBe(
      "[here](https://example.com)",
    );
  });
});

describe("toMarkdown — tables", () => {
  test("a simple table renders as GFM", () => {
    const table: BlockContent = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            { type: "tableCell", content: [para([run("A")])] },
            { type: "tableCell", content: [para([run("B")])] },
          ],
        },
        {
          type: "tableRow",
          cells: [
            { type: "tableCell", content: [para([run("1")])] },
            { type: "tableCell", content: [para([run("2")])] },
          ],
        },
      ],
    };
    expect(md([table])).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  test("a merged cell falls back to inline HTML with colspan", () => {
    const table: BlockContent = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              formatting: { gridSpan: 2 },
              content: [para([run("Span")])],
            },
          ],
        },
        {
          type: "tableRow",
          cells: [
            { type: "tableCell", content: [para([run("L")])] },
            { type: "tableCell", content: [para([run("R")])] },
          ],
        },
      ],
    };
    expect(md([table])).toBe(
      '<table>\n  <tr>\n    <th colspan="2">Span</th>\n  </tr>\n  <tr>\n    <td>L</td>\n    <td>R</td>\n  </tr>\n</table>',
    );
  });
});

describe("toMarkdown — clean preset for skills", () => {
  const clean: MarkdownOptions = {
    annotations: "strip",
    trackedChanges: "clean",
    comments: "strip",
    hyperlinks: "inline",
    footnotes: "strip",
  };

  test("a footnote reference is dropped (no marker, no trailer)", () => {
    const content: Paragraph["content"] = [
      run("text"),
      { type: "run", content: [{ type: "footnoteRef", id: 1 }] },
    ];
    const out = toMarkdown(
      {
        package: {
          document: { content: [{ type: "paragraph", content }] },
          footnotes: [
            { type: "footnote", id: 1, content: [para([run("note")])] },
          ],
        },
      },
      clean,
    );
    expect(out).toBe("text");
  });

  test("footnotes are kept by default", () => {
    const content: Paragraph["content"] = [
      run("text"),
      { type: "run", content: [{ type: "footnoteRef", id: 1 }] },
    ];
    const out = toMarkdown({
      package: {
        document: { content: [{ type: "paragraph", content }] },
        footnotes: [
          { type: "footnote", id: 1, content: [para([run("note")])] },
        ],
      },
    });
    expect(out).toBe("text[^1]\n\n[^1]: note");
  });
});
