import { expect, test } from "bun:test";

import { collapseHtmlWhitespace } from "./html-whitespace";

test.each(["\u00a0", "\u202f", "\u2007"])(
  "preserves a trailing non-HTML space %s across inline formatting",
  (space) => {
    expect(
      collapseHtmlWhitespace([
        { type: "text", text: "Body" },
        { type: "bold", children: [{ type: "text", text: `${space} \t\n` }] },
      ]),
    ).toEqual([
      { type: "text", text: "Body" },
      { type: "bold", children: [{ type: "text", text: space }] },
    ]);
  },
);
