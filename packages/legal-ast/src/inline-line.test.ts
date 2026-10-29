import { describe, expect, test } from "bun:test";

import { type Inline, plainTextOf } from "./document-ast.js";
import {
  mapInlineText,
  rewriteInlineWhitespace,
  stripInlineSuffix,
} from "./inline-line.js";

/** U+00AD, spelled out: the formatter writes the escape as the character. */
const SOFT_HYPHEN = String.fromCodePoint(0xad);

describe("cutting a line's end", () => {
  test("a suffix cut reaches into emphasis and keeps zero-width anchors", () => {
    const inlines: Inline[] = [
      { type: "text", text: "(ďalej len " },
      { type: "bold", children: [{ type: "text", text: "„charta“)    2" }] },
      { type: "page-anchor", label: "2" },
    ];
    const cut = stripInlineSuffix(inlines, "    2".length);
    expect(plainTextOf(cut)).toBe("(ďalej len „charta“)");
    expect(cut.at(-1)).toEqual({ type: "page-anchor", label: "2" });
    expect(cut[1]).toEqual({
      type: "bold",
      children: [{ type: "text", text: "„charta“)" }],
    });
  });

  test("text mapping rewrites every text node and keeps the tree", () => {
    const inlines: Inline[] = [
      { type: "text", text: `C${SOFT_HYPHEN}293/12` },
      {
        type: "italic",
        children: [{ type: "text", text: `peer${SOFT_HYPHEN}to` }],
      },
    ];
    expect(
      mapInlineText(inlines, (text) => text.replaceAll(SOFT_HYPHEN, "-")),
    ).toEqual([
      { type: "text", text: "C-293/12" },
      { type: "italic", children: [{ type: "text", text: "peer-to" }] },
    ]);
  });

  test("a whole-line whitespace rewrite lands on the nodes that held the spaces", () => {
    const inlines: Inline[] = [
      { type: "text", text: "zákonov   n i e" },
      { type: "bold", children: [{ type: "text", text: "   j e   v" }] },
      { type: "text", text: " súlade" },
    ];
    const rewritten = rewriteInlineWhitespace(inlines, (text) =>
      text.replace("   n i e   j e   ", " nie je "),
    );
    expect(plainTextOf(rewritten)).toBe("zákonov nie je v súlade");
    expect(rewritten).toEqual([
      { type: "text", text: "zákonov nie" },
      { type: "bold", children: [{ type: "text", text: " je v" }] },
      { type: "text", text: " súlade" },
    ]);
  });

  test("a rewrite that changes more than whitespace leaves the tree", () => {
    const inlines: Inline[] = [
      { type: "text", text: "k e" },
      { type: "text", text: "lektronickému" },
    ];
    expect(
      rewriteInlineWhitespace(inlines, (text) => text.toUpperCase()),
    ).toEqual(inlines);
  });

  test("a removed newline drops its line break", () => {
    const inlines: Inline[] = [
      { type: "text", text: "first" },
      { type: "line-break" },
      { type: "text", text: "second" },
    ];

    expect(
      rewriteInlineWhitespace(inlines, (text) => text.replace("\n", "")),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  test("a newline replaced by a space becomes text", () => {
    const inlines: Inline[] = [
      { type: "text", text: "first" },
      { type: "line-break" },
      { type: "text", text: "second" },
    ];

    expect(
      rewriteInlineWhitespace(inlines, (text) => text.replace("\n", " ")),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: " " },
      { type: "text", text: "second" },
    ]);
  });

  test("an untouched newline stays a line break", () => {
    const inlines: Inline[] = [
      { type: "text", text: "first" },
      { type: "line-break" },
      { type: "text", text: "second  " },
    ];

    expect(
      rewriteInlineWhitespace(inlines, (text) => text.replace("  ", " ")),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "line-break" },
      { type: "text", text: "second " },
    ]);
  });

  test("a removed space before a retained newline keeps its line break", () => {
    const inlines: Inline[] = [
      { type: "text", text: "first " },
      { type: "line-break" },
      { type: "text", text: "second" },
    ];

    expect(
      rewriteInlineWhitespace(inlines, (text) => text.replace(" \n", "\n")),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "line-break" },
      { type: "text", text: "second" },
    ]);
  });

  test("nested children around a line break keep their offsets", () => {
    const inlines: Inline[] = [
      {
        type: "bold",
        children: [
          { type: "text", text: "first" },
          {
            type: "italic",
            children: [
              { type: "line-break" },
              { type: "text", text: "  second" },
            ],
          },
        ],
      },
      { type: "text", text: "  third" },
    ];

    expect(
      rewriteInlineWhitespace(inlines, (text) => text.replaceAll("  ", " ")),
    ).toEqual([
      {
        type: "bold",
        children: [
          { type: "text", text: "first" },
          {
            type: "italic",
            children: [
              { type: "line-break" },
              { type: "text", text: " second" },
            ],
          },
        ],
      },
      { type: "text", text: " third" },
    ]);
  });
});
