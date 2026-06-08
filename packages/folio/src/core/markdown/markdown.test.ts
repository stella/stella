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

  test("block markers after an inline break are escaped", () => {
    const para1: Paragraph = {
      type: "paragraph",
      content: [
        {
          type: "run",
          content: [
            { type: "text", text: "Intro" },
            { type: "break" },
            { type: "text", text: "# Clause" },
          ],
        },
      ],
    };
    expect(md([para1])).toBe("Intro  \n\\# Clause");
  });

  test("a plain paragraph that begins with block syntax is escaped", () => {
    // Literal legal text must not be reclassified as a heading/list/quote.
    expect(md([para([run("# Not a heading")])])).toBe("\\# Not a heading");
    expect(md([para([run("- not a bullet")])])).toBe("\\- not a bullet");
    expect(md([para([run("1. not a list")])])).toBe("1\\. not a list");
    expect(md([para([run("> not a quote")])])).toBe("\\> not a quote");
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

  test("a hidden list marker (w:vanish) exports as plain prose", () => {
    const hidden: ListRendering = { ...list(0, true, "•"), markerHidden: true };
    expect(md([para([run("text")], { listRendering: hidden })])).toBe("text");
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

  test("hidden runs (w:vanish) are dropped", () => {
    expect(md([para([run("Keep"), run("Hidden", { hidden: true })])])).toBe(
      "Keep",
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

  test("inline code with backticks uses a longer fence", () => {
    const mono = { fontFamily: { ascii: "Consolas" } };
    expect(md([para([run("a``b", mono)])])).toBe("```a``b```");
    // Content beginning with a backtick gets an inner space.
    expect(md([para([run("`x", mono)])])).toBe("`` `x ``");
  });

  test("a math equation exports its plain-text fallback", () => {
    const out = toMarkdown({
      package: {
        document: {
          content: [
            {
              type: "paragraph",
              content: [
                run("E="),
                {
                  type: "mathEquation",
                  display: "inline",
                  ommlXml: "<m/>",
                  plainText: "mc^2",
                },
              ],
            },
          ],
        },
      },
    });
    expect(out).toBe("E=mc^2");
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

  test("reference-mode link destinations are escaped", () => {
    const link: Hyperlink = {
      type: "hyperlink",
      href: "https://x.com/a b(c)",
      children: [run("t")],
    };
    const out = toMarkdown(doc([{ type: "paragraph", content: [link] }]), {
      hyperlinks: "reference",
    });
    expect(out).toBe("[t][1]\n\n[1]: https://x.com/a%20b%28c%29");
  });

  test("an unbalanced paren in an inline link destination is encoded", () => {
    const link: Hyperlink = {
      type: "hyperlink",
      href: "https://example.com/a)b",
      children: [run("x")],
    };
    // `encodeURIComponent` leaves parens untouched, so without explicit
    // encoding the `)` would close the `[x](…)` destination early.
    expect(toMarkdown(doc([{ type: "paragraph", content: [link] }]))).toBe(
      "[x](https://example.com/a%29b)",
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

  test("a literal pipe in a cell is encoded so it is not a column break", () => {
    const table: BlockContent = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [{ type: "tableCell", content: [para([run("a|b")])] }],
        },
      ],
    };
    expect(md([table])).toBe("| a&#124;b |\n| --- |");
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

  test("math in an HTML-fallback table cell exports its fallback", () => {
    const table: BlockContent = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              formatting: { gridSpan: 2 },
              content: [
                {
                  type: "paragraph",
                  content: [
                    run("E="),
                    {
                      type: "mathEquation",
                      display: "inline",
                      ommlXml: "<m/>",
                      plainText: "mc^2",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(md([table])).toContain("E=mc^2");
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

  test("a point comment (commentReference) is preserved in sidecar mode", () => {
    const content: Paragraph["content"] = [
      run("text"),
      { type: "commentReference", id: 5 },
    ];
    const out = toMarkdown(
      {
        package: {
          document: {
            content: [{ type: "paragraph", content }],
            comments: [{ id: 5, author: "R", content: [para([run("note")])] }],
          },
        },
      },
      { comments: "sidecar" },
    );
    expect(out).toBe("text[^c1]\n\n## Comments\n[^c1]: R: note");
  });

  test("comment sidecar text includes hyperlink/field text, not just runs", () => {
    const commentPara: Paragraph = {
      type: "paragraph",
      content: [
        run("see "),
        {
          type: "hyperlink",
          href: "https://x",
          children: [run("link")],
        },
      ],
    };
    const content: Paragraph["content"] = [
      run("x"),
      { type: "commentReference", id: 7 },
    ];
    const out = toMarkdown(
      {
        package: {
          document: {
            content: [{ type: "paragraph", content }],
            comments: [{ id: 7, author: "A", content: [commentPara] }],
          },
        },
      },
      { comments: "sidecar" },
    );
    expect(out).toBe("x[^c1]\n\n## Comments\n[^c1]: A: see link");
  });

  const delMark = (): Paragraph["pPrMark"] => ({
    kind: "del",
    info: { id: 1, author: "A" },
  });

  test("a deleted paragraph mark merges into the next paragraph on accept", () => {
    const first: Paragraph = {
      type: "paragraph",
      content: [run("Hello")],
      pPrMark: delMark(),
    };
    // Word's join keeps the first paragraph's properties and concatenates the
    // runs; "annotate" mode (default) leaves both paragraphs intact.
    expect(md([first, para([run(" world")])], clean)).toBe("Hello world");
    expect(md([first, para([run(" world")])])).toBe("Hello\n\n world");
  });

  test("the merged paragraph keeps the first paragraph's heading style", () => {
    const heading: Paragraph = {
      type: "paragraph",
      content: [run("Title")],
      formatting: { styleId: "Heading1" },
      pPrMark: delMark(),
    };
    expect(md([heading, para([run(" tail")])], clean)).toBe("# Title tail");
  });

  test("a chain of deleted marks collapses into one paragraph", () => {
    const a: Paragraph = {
      type: "paragraph",
      content: [run("A")],
      pPrMark: delMark(),
    };
    const b: Paragraph = {
      type: "paragraph",
      content: [run("B")],
      pPrMark: delMark(),
    };
    expect(md([a, b, para([run("C")])], clean)).toBe("ABC");
  });

  test("a deleted mark before a table is left unmerged (no structural join)", () => {
    const para1: Paragraph = {
      type: "paragraph",
      content: [run("Lead")],
      pPrMark: delMark(),
    };
    const table: BlockContent = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [{ type: "tableCell", content: [para([run("X")])] }],
        },
      ],
    };
    expect(md([para1, table], clean)).toBe("Lead\n\n| X |\n| --- |");
  });
});
