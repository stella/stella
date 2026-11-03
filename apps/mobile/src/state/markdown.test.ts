import { describe, expect, test } from "bun:test";

import { parseInline, parseMarkdown } from "./markdown";

describe("inline spans", () => {
  test("reads bold, italic, code and links", () => {
    expect(
      parseInline(
        "See **§ 2** of *the act*, `code` and [the ruling](https://x.test/r).",
      ),
    ).toEqual([
      { text: "See " },
      { text: "§ 2", bold: true },
      { text: " of " },
      { text: "the act", italic: true },
      { text: ", " },
      { text: "code", code: true },
      { text: " and " },
      { text: "the ruling", href: "https://x.test/r" },
      { text: "." },
    ]);
  });

  test("keeps unmatched markers, arithmetic and snake_case as text", () => {
    expect(parseInline("2 * 3 * 4 and **open")).toEqual([
      { text: "2 * 3 * 4 and **open" },
    ]);
    expect(parseInline("a snake_case_name here")).toEqual([
      { text: "a snake_case_name here" },
    ]);
  });
});

describe("blocks", () => {
  test("reads headings, paragraphs, lists, quotes and fenced code", () => {
    expect(
      parseMarkdown(
        [
          "## Summary",
          "The court",
          "agreed.",
          "",
          "- first",
          "- second",
          "1. one",
          "> quoted",
          "```",
          "const x = 1;",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "heading", level: 2, spans: [{ text: "Summary" }] },
      { type: "paragraph", spans: [{ text: "The court agreed." }] },
      {
        type: "list",
        ordered: false,
        items: [[{ text: "first" }], [{ text: "second" }]],
      },
      { type: "list", ordered: true, items: [[{ text: "one" }]] },
      { type: "quote", spans: [{ text: "quoted" }] },
      { type: "code", text: "const x = 1;" },
    ]);
  });

  test("an unclosed fence takes the rest of the answer as code", () => {
    expect(parseMarkdown("```\nline")).toEqual([
      { type: "code", text: "line" },
    ]);
  });
});
