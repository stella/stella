import { describe, expect, test } from "bun:test";

import { parseDocumentAst, plainTextOf } from "./document-ast";
import {
  flattenInlineText,
  hasInlineChildren,
  isInline,
  isInlineArray,
} from "./inline";
import type { Inline } from "./inline";

/**
 * One sample per declared inline kind.
 *
 * Total over `Inline["type"]`, so a kind added to the union without a
 * sample is a type error. The tests then run every sample through both
 * readers, which is what binds the strict schema to its persisted
 * counterpart: a kind the persisted reader has no branch for would be
 * read as unrecognised and degraded to plain text, and the round trip
 * below fails on exactly that.
 */
const SAMPLES = {
  text: { type: "text", text: "Article " },
  "line-break": { type: "line-break" },
  "page-anchor": { type: "page-anchor", label: "495" },
  bold: { type: "bold", children: [{ type: "text", text: "5" }] },
  italic: { type: "italic", children: [{ type: "text", text: "obiter" }] },
  underline: { type: "underline", children: [{ type: "text", text: "not" }] },
  superscript: { type: "superscript", children: [{ type: "text", text: "3" }] },
  subscript: { type: "subscript", children: [{ type: "text", text: "2" }] },
  link: {
    type: "link",
    href: "#art-5",
    children: [{ type: "text", text: "ref" }],
  },
  citation: {
    type: "citation",
    cite: "Rep. 2019, 412",
    href: "https://reports.test/2019/412",
    children: [{ type: "text", text: "the earlier case" }],
  },
} satisfies Record<Inline["type"], Inline>;

const EVERY_KIND: Inline[] = Object.values(SAMPLES);

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

  test("every declared kind is accepted by the canonical guard", () => {
    for (const sample of EVERY_KIND) {
      expect(isInline(sample)).toBe(true);
    }
    expect(isInlineArray(EVERY_KIND)).toBe(true);
  });

  test("the kinds that nest children are exactly the ones that carry them", () => {
    for (const sample of EVERY_KIND) {
      expect(hasInlineChildren(sample)).toBe("children" in sample);
    }
  });

  test("every declared kind survives the persisted reader unchanged", () => {
    const parsed = parseDocumentAst({
      version: 1,
      blocks: [
        { id: "p1", anchorId: "p-1", type: "paragraph", inlines: EVERY_KIND },
      ],
    });
    const block = parsed?.blocks.at(0);
    expect(block?.type === "paragraph" ? block.inlines : null).toEqual(
      EVERY_KIND,
    );
  });
});

describe("text axis", () => {
  test("a citation contributes its children, never its printed cite", () => {
    expect(plainTextOf([SAMPLES.citation])).toBe("the earlier case");
    expect(flattenInlineText([SAMPLES.citation])).toBe("the earlier case");
  });

  test("superscript, subscript and underline contribute their children", () => {
    expect(
      plainTextOf([SAMPLES.superscript, SAMPLES.subscript, SAMPLES.underline]),
    ).toBe("32not");
  });

  test("a page anchor still contributes nothing", () => {
    expect(plainTextOf([SAMPLES["page-anchor"]])).toBe("");
  });
});

describe("citation", () => {
  test("requires the reference as the publisher printed it", () => {
    expect(isInline({ ...SAMPLES.citation, cite: "" })).toBe(false);
  });

  test("is valid without a link: not every printed reference has one", () => {
    const { href: _href, ...unlinked } = SAMPLES.citation;
    expect(isInline(unlinked)).toBe(true);
  });
});
