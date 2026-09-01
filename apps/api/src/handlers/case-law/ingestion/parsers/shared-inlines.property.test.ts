/**
 * Properties of the shared inline-tree normalizers.
 *
 * `inlinesToPlainText` and `stripInlinePrefix` run on every HTML court
 * parser, and both are about where text ends up relative to markup —
 * the axis the cz-nss letter-spacing defect got wrong. Example tests
 * cover the tree shapes someone drew; these generate the shape.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import type { Inline } from "@/api/handlers/case-law/document-ast";
import {
  inlinesToPlainText,
  stripInlinePrefix,
} from "@/api/handlers/case-law/ingestion/parsers/shared-inlines";

// Fixed seed: a failing counterexample has to be reproducible from the
// CI log alone. The nightly sweep widens coverage through numRuns.
const SEED = 20_260_901;

const config = (numRuns: number) => propertyConfig({ numRuns, seed: SEED });

/**
 * Text fragments mixing letters with every whitespace encoding a court
 * document carries, since whitespace is what these functions move.
 */
const textContent = fc
  .array(fc.constantFrom("a", "b", "č", " ", "  ", "\n", "\u00a0"), {
    minLength: 1,
    maxLength: 5,
  })
  .map((parts) => parts.join(""));

const inlineTree: fc.Arbitrary<Inline> = fc.letrec<{ node: Inline }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    textContent.map((text): Inline => ({ type: "text", text })),
    fc.constant<Inline>({ type: "line-break" }),
    fc
      .array(tie("node"), { maxLength: 3 })
      .map((children): Inline => ({ type: "bold", children })),
    fc
      .array(tie("node"), { maxLength: 3 })
      .map((children): Inline => ({ type: "italic", children })),
    fc.array(tie("node"), { maxLength: 3 }).map((children): Inline => ({
      type: "link",
      href: "https://court.test/d",
      children,
    })),
  ),
})).node;

const inlines = fc.array(inlineTree, { maxLength: 5 });

/** A tree paired with a prefix length that actually bites into it. */
const treeAndPrefix = inlines.chain((tree) =>
  fc.tuple(
    fc.constant(tree),
    fc.integer({ min: 1, max: Math.max(1, inlinesToPlainText(tree).length) }),
  ),
);

describe("inlinesToPlainText (properties)", () => {
  /**
   * Flattening is a homomorphism over concatenation: no node's text
   * depends on what sits beside it. This is what lets a parser splice
   * inline lists without re-deriving plain text.
   */
  test("distributes over concatenation", () => {
    fc.assert(
      fc.property(inlines, inlines, (left, right) => {
        expect(inlinesToPlainText([...left, ...right])).toBe(
          inlinesToPlainText(left) + inlinesToPlainText(right),
        );
      }),
      config(300),
    );
  });

  /**
   * Emphasis is presentation, never content: wrapping a subtree in
   * bold, italic or a link must not change a single character of the
   * text a reader or the search index sees.
   */
  test("is unchanged by wrapping in emphasis or a link", () => {
    fc.assert(
      fc.property(inlines, (tree) => {
        const flat = inlinesToPlainText(tree);

        expect(inlinesToPlainText([{ type: "bold", children: tree }])).toBe(
          flat,
        );
        expect(inlinesToPlainText([{ type: "italic", children: tree }])).toBe(
          flat,
        );
        expect(
          inlinesToPlainText([
            { type: "link", href: "https://court.test/d", children: tree },
          ]),
        ).toBe(flat);
      }),
      config(300),
    );
  });
});

describe("stripInlinePrefix (properties)", () => {
  /**
   * The core contract: removing `k` characters of prefix removes
   * exactly the first `k` characters of the flattened text, nesting
   * notwithstanding. Compared after `trimStart` on both sides because
   * the function also drops whitespace left at the head — see the
   * skipped property below for where it fails to.
   */
  test("removes exactly the first k characters of the plain text", () => {
    fc.assert(
      fc.property(treeAndPrefix, ([tree, k]) => {
        const stripped = inlinesToPlainText(stripInlinePrefix(tree, k));

        expect(stripped.trimStart()).toBe(
          inlinesToPlainText(tree).slice(k).trimStart(),
        );
      }),
      config(500),
    );
  });

  /** A non-positive prefix is documented to change nothing. */
  test("is a no-op for a non-positive prefix", () => {
    fc.assert(
      fc.property(inlines, fc.integer({ min: -5, max: 0 }), (tree, k) => {
        expect(inlinesToPlainText(stripInlinePrefix(tree, k))).toBe(
          inlinesToPlainText(tree),
        );
      }),
      config(200),
    );
  });

  /** Stripping at least the whole text leaves nothing behind. */
  test("empties the tree when the prefix covers all of it", () => {
    fc.assert(
      fc.property(inlines, fc.nat({ max: 5 }), (tree, extra) => {
        const all = inlinesToPlainText(tree).length + extra;

        expect(inlinesToPlainText(stripInlinePrefix(tree, all))).toBe("");
      }),
      config(300),
    );
  });

  /**
   * Regression for the defect this file was written to catch: the trim
   * reached only a top-level text node, so a paragraph's plain text
   * depended on where the publisher opened an emphasis tag.
   */
  test("trims exposed leading whitespace regardless of nesting", () => {
    fc.assert(
      fc.property(treeAndPrefix, ([tree, k]) => {
        expect(inlinesToPlainText(stripInlinePrefix(tree, k))).toBe(
          inlinesToPlainText(tree).slice(k).trimStart(),
        );
      }),
      config(500),
    );
  });

  /**
   * The same document written two ways must strip to the same text. This
   * is the invariant the property above generalizes, spelled out on the
   * shape that actually occurs: a paragraph marker followed by a bold
   * opening.
   */
  test("strips a marker identically however the emphasis is nested", () => {
    const flat: Inline[] = [{ type: "text", text: "[1] Text" }];
    const behindBold: Inline[] = [
      { type: "text", text: "[1]" },
      { type: "bold", children: [{ type: "text", text: " Text" }] },
    ];
    const behindNestedLink: Inline[] = [
      { type: "text", text: "[1]" },
      {
        type: "link",
        href: "https://court.test/d",
        children: [
          { type: "bold", children: [{ type: "text", text: "  Text" }] },
        ],
      },
    ];

    for (const tree of [flat, behindBold, behindNestedLink]) {
      expect(inlinesToPlainText(stripInlinePrefix(tree, 3))).toBe("Text");
    }
  });

  /**
   * A wrapper holding nothing but the exposed whitespace is dropped
   * rather than left as an empty emphasis span.
   */
  test("drops a wrapper emptied by the trim", () => {
    const tree: Inline[] = [
      { type: "text", text: "[1]" },
      { type: "italic", children: [{ type: "text", text: "   " }] },
      { type: "text", text: "Text" },
    ];

    expect(inlinesToPlainText(stripInlinePrefix(tree, 3))).toBe("Text");
  });

  /**
   * Decision: a line-break exposed by the cut is dropped like any other
   * leading whitespace. It separated the marker from the body, and a
   * paragraph cannot open with an empty line. Keeping it would also
   * reintroduce the markup-shape dependence, since the same break
   * written as "\n" inside a text node is trimmed.
   */
  test("drops a line-break exposed at the new start", () => {
    const tree: Inline[] = [
      { type: "text", text: "ab" },
      { type: "line-break" },
      { type: "text", text: "cd" },
    ];

    expect(inlinesToPlainText(stripInlinePrefix(tree, 2))).toBe("cd");
  });
});
