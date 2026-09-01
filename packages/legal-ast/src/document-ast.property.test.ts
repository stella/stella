/**
 * Properties of the two plain-text projections.
 *
 * `plainTextOf` is the raw axis every search highlight, citation anchor
 * and annotation offset indexes; its docstring forbids normalizing,
 * trimming or collapsing anything, because one character of drift moves
 * every anchor after it. `projectPlainText` is the normalized axis that
 * feeds search and AI. Keeping them apart is a correctness property, not
 * a style choice, so it is generated rather than sampled.
 */

import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import { plainTextOf, projectPlainText } from "./document-ast.js";
import { hasInlineChildren } from "./inline.js";
import type { Inline } from "./inline.js";

// Seeded in PR CI so a counterexample is reproducible from the log, and
// unseeded under the nightly sweep so it explores new inputs. See
// propertySeed in @stll/property-testing.

const config = (numRuns: number) =>
  propertyConfig({ numRuns, seed: propertySeed() });

const NBSP = "\u00a0";

/** Letters mixed with every whitespace encoding a court document uses. */
const textContent = fc
  .array(fc.constantFrom("a", "b", "č", " ", "  ", "\n", "\t", NBSP), {
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

/**
 * The exact character sequence the tree carries, built independently of
 * `plainTextOf`: text verbatim, a line break as "\n", containers by
 * their children. Comparing against this, not against a length, is what
 * catches a substituted NBSP or a reordered run.
 */
const rawTextOf = (nodes: readonly Inline[]): string => {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += node.text;
    } else if (node.type === "line-break") {
      out += "\n";
    } else if (hasInlineChildren(node)) {
      out += rawTextOf(node.children);
    }
  }
  return out;
};

const LETTER_RE = /\p{L}/gu;

/** Only the letters of a string, in order. */
const letters = (text: string): string => text.match(LETTER_RE)?.join("") ?? "";

describe("plainTextOf (properties)", () => {
  /**
   * The raw axis normalizes nothing. Every character in the tree
   * survives in place, so no whitespace run is squeezed, no NBSP is
   * folded and no edge is trimmed — exactly the guarantee the offset
   * consumers rely on.
   */
  test("is exactly the tree's character sequence", () => {
    fc.assert(
      fc.property(inlines, (tree) => {
        expect(plainTextOf(tree)).toBe(rawTextOf(tree));
      }),
      config(400),
    );
  });

  /** No node's text depends on what sits beside it. */
  test("distributes over concatenation", () => {
    fc.assert(
      fc.property(inlines, inlines, (left, right) => {
        expect(plainTextOf([...left, ...right])).toBe(
          plainTextOf(left) + plainTextOf(right),
        );
      }),
      config(300),
    );
  });
});

describe("projectPlainText (properties)", () => {
  /**
   * The normalized axis may move whitespace around. It may never lose,
   * add or reorder a letter: this text is what the corpus index matches
   * and what the reader is shown as the court's own words.
   */
  test("preserves the letters of the raw text", () => {
    fc.assert(
      fc.property(inlines, (tree) => {
        expect(letters(projectPlainText(tree))).toBe(
          letters(plainTextOf(tree)),
        );
      }),
      config(400),
    );
  });

  /**
   * Never longer than the raw text: the projection only folds no-break
   * spaces, drops spaces before a line break, trims and collapses.
   */
  test("never grows the raw text", () => {
    fc.assert(
      fc.property(inlines, (tree) => {
        expect(projectPlainText(tree).length).toBeLessThanOrEqual(
          plainTextOf(tree).length,
        );
      }),
      config(400),
    );
  });
});
