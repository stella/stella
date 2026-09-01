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

import {
  omitDerivablePlainText,
  parseDocumentAst,
  plainTextOf,
  projectPlainText,
  withProjectedPlainText,
} from "./document-ast.js";
import type {
  Block,
  DocumentAst,
  HeadingLevel,
  TableCell,
} from "./document-ast.js";
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

/**
 * The emphasis kinds are one shape — a discriminator plus children — so
 * they are generated from their names rather than listed one arbitrary
 * at a time. A kind added to the union has to be added here too, or the
 * wire round trip below never sees it.
 */
const EMPHASIS_TYPES = [
  "bold",
  "italic",
  "underline",
  "superscript",
  "subscript",
] as const;

const inlineTree: fc.Arbitrary<Inline> = fc.letrec<{ node: Inline }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    textContent.map((text): Inline => ({ type: "text", text })),
    fc.constant<Inline>({ type: "line-break" }),
    fc.constant<Inline>({ type: "page-anchor", label: "495" }),
    fc
      .tuple(
        fc.constantFrom(...EMPHASIS_TYPES),
        fc.array(tie("node"), { maxLength: 3 }),
      )
      .map(([type, children]): Inline => ({ type, children })),
    fc.array(tie("node"), { maxLength: 3 }).map((children): Inline => ({
      type: "link",
      href: "https://court.test/d",
      children,
    })),
    fc.array(tie("node"), { maxLength: 3 }).map((children): Inline => ({
      type: "citation",
      cite: "Rep. 2019, 412",
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

const cellSpan = fc.option(fc.integer({ min: 2, max: 4 }), { nil: undefined });

/**
 * The optional fields are spread in conditionally so an absent one is
 * absent rather than present-and-undefined: the wire round trip compares
 * the parsed object against this one, and `{ colSpan: undefined }` is not
 * what a reader rebuilds from JSON that never carried the key.
 */
const makeCell = ([cellInlines, colSpan, rowSpan, header]: [
  Inline[],
  number | undefined,
  number | undefined,
  boolean,
]): TableCell => ({
  inlines: cellInlines,
  plainText: "",
  ...(colSpan === undefined ? {} : { colSpan }),
  ...(rowSpan === undefined ? {} : { rowSpan }),
  ...(header ? { header: true as const } : {}),
});

const tableCell = fc
  .tuple(inlines, cellSpan, cellSpan, fc.boolean())
  .map(makeCell);

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const satisfies HeadingLevel[];

/** Identity the document arbitrary overwrites once the blocks are ordered. */
const BLANK = { id: "", anchorId: "", plainText: "" };

const makeHeading = ([level, blockInlines]: [
  HeadingLevel,
  Inline[],
]): Block => ({
  ...BLANK,
  type: "heading",
  level,
  inlines: blockInlines,
});

const makeParagraph = ([blockInlines, number]: [
  Inline[],
  number | undefined,
]): Block => ({
  ...BLANK,
  type: "paragraph",
  inlines: blockInlines,
  ...(number === undefined ? {} : { number }),
});

const makeTable = (rows: TableCell[][]): Block => ({
  ...BLANK,
  type: "table",
  rows,
});

const makeImage = (alt: string | undefined): Block => ({
  ...BLANK,
  type: "image",
  src: "https://assets.test/seal.png",
  ...(alt === undefined ? {} : { alt }),
  width: 120,
  height: 80,
});

const blockArbitrary: fc.Arbitrary<Block> = fc.oneof(
  fc.tuple(fc.constantFrom(...HEADING_LEVELS), inlines).map(makeHeading),
  fc
    .tuple(
      inlines,
      fc.option(fc.integer({ min: 1, max: 99 }), { nil: undefined }),
    )
    .map(makeParagraph),
  fc
    .array(fc.array(tableCell, { minLength: 1, maxLength: 3 }), {
      minLength: 1,
      maxLength: 3,
    })
    .map(makeTable),
  fc.option(textContent, { nil: undefined }).map(makeImage),
);

const identified = (block: Block, index: number): Block => ({
  ...block,
  id: `b${String(index)}`,
  anchorId: `b-${String(index)}`,
});

const documentAst: fc.Arbitrary<DocumentAst> = fc
  .array(blockArbitrary, { maxLength: 6 })
  .map((blocks) =>
    withProjectedPlainText({
      version: 1,
      source: {
        system: "test",
        documentId: "d",
        webUrl: "https://court.test/d",
        printUrl: "https://court.test/d/print",
      },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: blocks.map(identified),
    }),
  );

describe("wire round trip (properties)", () => {
  /**
   * Dropping a rebuildable `plainText` is lossless only while every kind
   * of block can rebuild it. Generated over every block kind rather than
   * sampled, because the failure is silent: a kind whose text the reader
   * cannot rebuild comes back with an empty string, not an error.
   */
  test("omitting the derivable text and parsing it back is the identity", () => {
    fc.assert(
      fc.property(documentAst, (ast) => {
        const wire = omitDerivablePlainText(ast);
        expect(parseDocumentAst(JSON.stringify(wire))).toEqual(ast);
      }),
      config(300),
    );
  });
});
