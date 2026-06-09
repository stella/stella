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
});
