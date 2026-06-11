// Round-trip coverage for the skills markdown bridge: fromMarkdown (import) and
// toMarkdown (export) must compose without drift, so editing a skill body in the
// Folio editor and saving it back reproduces the markdown a user would expect.
//
// `normalize` is one import→export cycle. We assert two properties:
//  - idempotence: a second cycle changes nothing (no drift on repeated edits),
//    which holds even where the first cycle normalises (table padding, marker
//    glyphs, hard breaks);
//  - exact fidelity for the constructs whose canonical form fromMarkdown already
//    emits (headings, prose, marks, lists, tables, inline code, blockquotes).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { fromMarkdown } from "./fromMarkdown";
import { toMarkdown } from "./index";

const CLEAN = {
  annotations: "strip",
  trackedChanges: "clean",
  comments: "strip",
  hyperlinks: "inline",
  footnotes: "strip",
} as const;

const normalize = (src: string): string => toMarkdown(fromMarkdown(src), CLEAN);

const SUBSET = [
  "# What this skill does\n\n## Input",
  "Reviews a document and reports what **fails**, with a *citation*.",
  "- first\n- second\n- third",
  "1. classify\n2. apply\n3. report",
  "- parent\n  - child\n  - sibling",
  "| Finding | Status |\n| --- | --- |\n| cites rule | ok |",
  "See `references/checklist.md` for the table.",
  "> Always cite the specific rule.",
];

describe("markdown bridge — round-trip", () => {
  test("each construct is idempotent under import→export", () => {
    for (const src of SUBSET) {
      const once = normalize(src);
      expect(normalize(once)).toBe(once);
    }
  });

  test("headings round-trip exactly", () => {
    expect(normalize("# A\n\n## B\n\n### C")).toBe("# A\n\n## B\n\n### C");
  });

  test("inline marks round-trip exactly", () => {
    expect(normalize("**bold** and *italic* and ~~struck~~")).toBe(
      "**bold** and *italic* and ~~struck~~",
    );
  });

  test("bullet and ordered lists round-trip exactly", () => {
    expect(normalize("- one\n- two")).toBe("- one\n- two");
    expect(normalize("1. one\n2. two")).toBe("1. one\n2. two");
  });

  test("nested lists keep two-space indentation", () => {
    expect(normalize("- a\n  - b")).toBe("- a\n  - b");
  });

  test("an ordered list keeps its start offset", () => {
    expect(normalize("3. third\n4. fourth")).toBe("3. third\n4. fourth");
  });

  test("separate ordered lists restart numbering", () => {
    expect(normalize("1. a\n2. b\n\nbetween\n\n1. x\n2. y")).toBe(
      "1. a\n2. b\n\nbetween\n\n1. x\n2. y",
    );
  });

  test("list paragraphs carry numPr and a marker template", () => {
    // The editor's list behaviour (Enter continues the list, Tab indents,
    // live renumbering) keys off numPr + a `%N` lvlText-style template; a
    // baked "1." would repeat itself on every split paragraph.
    const doc = fromMarkdown("1. a\n2. b\n\n- bullet");
    const listParas = doc.package.document.content.filter(
      (block) => block.type === "paragraph" && block.listRendering,
    );
    expect(listParas).toHaveLength(3);
    for (const block of listParas) {
      if (block.type !== "paragraph") {
        continue;
      }
      expect(block.formatting?.numPr?.numId).toBe(
        block.listRendering?.numId ?? -1,
      );
      expect(block.formatting?.numPr?.ilvl).toBe(0);
      if (!block.listRendering?.isBullet) {
        expect(block.listRendering?.marker).toBe("%1.");
      }
    }
    // The bullet list is a separate markdown list, so it must not share the
    // ordered list's counter.
    const numIds = new Set(
      listParas.map((block) =>
        block.type === "paragraph" ? block.listRendering?.numId : undefined,
      ),
    );
    expect(numIds.size).toBe(2);
  });

  test("a simple pipe table round-trips exactly", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(normalize(table)).toBe(table);
  });

  test("inline code round-trips exactly", () => {
    expect(normalize("Use `code()` here")).toBe("Use `code()` here");
  });

  test("blockquote round-trips exactly", () => {
    expect(normalize("> cited line")).toBe("> cited line");
  });

  test("a list followed by prose keeps the blank-line separation", () => {
    expect(normalize("- item\n\nAfter the list.")).toBe(
      "- item\n\nAfter the list.",
    );
  });

  test("loose list paragraph tokens keep nested marks and links", () => {
    expect(
      normalize(
        "- **bold** item\n\n  continuation with [link](https://example.com)",
      ),
    ).toContain(
      "**bold** item  \ncontinuation with [link](https://example.com)",
    );
  });

  test("loose list items are idempotent after markdown bridge normalization", () => {
    fc.assert(
      fc.property(
        looseListItemMarkdown(),
        (source) => normalize(normalize(source)) === normalize(source),
      ),
      { numRuns: 100 },
    );
  });

  test("a soft line break becomes a break node, not a raw newline in a run", () => {
    // A Word run can't carry "\n"; the layout engine renders such lines on top
    // of each other. A two-line blockquote must produce an explicit break.
    const doc = fromMarkdown("> first line\n> second line");
    let rawNewlineRuns = 0;
    let breakNodes = 0;
    for (const block of doc.package.document.content) {
      if (block.type !== "paragraph") {
        continue;
      }
      for (const run of block.content) {
        if (run.type !== "run") {
          continue;
        }
        for (const node of run.content) {
          if (node.type === "break") {
            breakNodes += 1;
          }
          if (node.type === "text" && node.text.includes("\n")) {
            rawNewlineRuns += 1;
          }
        }
      }
    }
    expect(rawNewlineRuns).toBe(0);
    expect(breakNodes).toBeGreaterThan(0);
  });
});

const LOWERCASE_WORD_CHARS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
] as const;

const inlineText = fc
  .array(
    fc.array(fc.constantFrom(...LOWERCASE_WORD_CHARS), {
      minLength: 1,
      maxLength: 8,
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((words) => words.map((chars) => chars.join("")).join(" "));

const inlineMarkdown = fc.oneof(
  inlineText,
  inlineText.map((value) => `**${value}**`),
  inlineText.map((value) => `*${value}*`),
  inlineText.map((value) => `\`${value.replaceAll("`", "")}\``),
  inlineText.map(
    (value) => `[${value}](https://example.com/${encodeURIComponent(value)})`,
  ),
);

const looseListItemMarkdown = () =>
  fc
    .tuple(
      fc.array(inlineMarkdown, { minLength: 1, maxLength: 3 }),
      fc.array(inlineMarkdown, { minLength: 1, maxLength: 3 }),
    )
    .map(
      ([firstParagraph, secondParagraph]) =>
        `- ${firstParagraph.join(" ")}\n\n  ${secondParagraph.join(" ")}`,
    );
