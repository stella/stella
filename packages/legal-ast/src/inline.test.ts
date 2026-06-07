import { describe, expect, test } from "bun:test";

import { flattenInlineText, isInlineArray } from "./inline";
import type { Inline } from "./inline";

describe("inline AST", () => {
  test("validates and flattens nested inline content", () => {
    const inlines: Inline[] = [
      { type: "text", text: "Article " },
      { type: "bold", children: [{ type: "text", text: "5" }] },
      { type: "line-break" },
      {
        type: "link",
        href: "#art-5",
        children: [
          { type: "italic", children: [{ type: "text", text: "ref" }] },
        ],
      },
    ];

    expect(isInlineArray(inlines)).toBe(true);
    expect(flattenInlineText(inlines)).toBe("Article 5\nref");
  });
});
