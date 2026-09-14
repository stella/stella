import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type { Block, HeadingLevel } from "@stll/legal-ast/document-ast";

import {
  BlockRenderer,
  buildDocumentAstSearchPieces,
  FulltextFallback,
  firstMatchIndexInPassage,
  HEADING_CLASS,
} from "@/components/legal-reader/document-ast-text";
import { buildSearchResults } from "@/components/legal-reader/reader-search";

// A statute is navigated by its containers (Část, Hlava, Díl, Oddíl) and
// read by its sections. The four containers carry the hierarchy; the
// section title and the section designation under them are markers the eye
// finds. Emphasis therefore has to fall away with depth, never rise: a
// designation set as heavy as the container it sits in flattens every level
// above it, which is a styling regression no type can catch.

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const satisfies HeadingLevel[];
const CONTAINER_LEVELS = [1, 2, 3, 4] as const satisfies HeadingLevel[];
const SECTION_LEVELS = [5, 6] as const satisfies HeadingLevel[];

const FONT_WEIGHT = {
  "font-medium": 500,
  "font-semibold": 600,
  "font-bold": 700,
} as const;

const remOf = (level: HeadingLevel): number => {
  const classes = HEADING_CLASS.statute[level];
  const arbitrary = /text-\[(?<rem>\d+(?:\.\d+)?)rem\]/u.exec(classes)
    ?.groups?.["rem"];

  if (arbitrary !== undefined) {
    return Number(arbitrary);
  }

  // `text-base` is the body size the reading column is set in.
  expect(classes).toContain("text-base");
  return 1;
};

const weightOf = (level: HeadingLevel): number => {
  const classes = HEADING_CLASS.statute[level];
  const found = Object.entries(FONT_WEIGHT).find(([token]) =>
    classes.includes(token),
  );

  if (found === undefined) {
    throw new Error(`statute heading level ${String(level)} states no weight`);
  }

  return found[1];
};

describe("statute heading emphasis", () => {
  test("size never grows with depth and bottoms out at the body size", () => {
    const sizes = HEADING_LEVELS.map(remOf);

    for (const [index, size] of sizes.entries()) {
      expect(size).toBeLessThanOrEqual(sizes[index - 1] ?? size);
    }

    expect(sizes.at(-1)).toBe(1);
  });

  test("containers are bold and the section levels under them are not", () => {
    for (const level of CONTAINER_LEVELS) {
      expect(weightOf(level)).toBe(700);
    }

    for (const level of SECTION_LEVELS) {
      expect(weightOf(level)).toBe(600);
    }
  });

  test("every statute heading is centred", () => {
    for (const level of HEADING_LEVELS) {
      expect(HEADING_CLASS.statute[level]).toContain("text-center");
    }
  });

  test("the case-law scale is untouched by the statute variant", () => {
    expect(HEADING_CLASS["case-law"][1]).toContain("text-lg");
    expect(HEADING_CLASS["case-law"][6]).toContain("text-sm");
  });
});

describe("embedded block anchors", () => {
  test("keeps a local anchor hook without duplicating document ids or permalinks", () => {
    const markup = renderToStaticMarkup(
      createElement(BlockRenderer, {
        activeMatchIndex: -1,
        anchorPresentation: "embedded",
        block: {
          anchorId: "prilohy-cl_7",
          id: "b42",
          inlines: [{ type: "text", text: "Čl. 7" }],
          level: 3,
          plainText: "Čl. 7",
          type: "heading",
        },
        rangesByPieceId: {},
        variant: "statute",
      }),
    );

    expect(markup).toContain('data-anchor="prilohy-cl_7"');
    expect(markup).not.toContain('id="prilohy-cl_7"');
    expect(markup).not.toContain('href="#prilohy-cl_7"');
  });
});

describe("fallback legal text anchors", () => {
  test("every paragraph remains annotatable and renders its stored mark", () => {
    const markup = renderToStaticMarkup(
      createElement(FulltextFallback, {
        activeMatchIndex: -1,
        anchorsByPieceId: {
          "fulltext:1": [
            {
              end: 6,
              key: "annotation:one",
              render: (children) =>
                createElement(
                  "mark",
                  { "data-annotation-id": "one" },
                  children,
                ),
              start: 0,
            },
          ],
        },
        rangesByPieceId: {},
        text: "First paragraph.\n\nSecond paragraph.",
      }),
    );

    expect(markup).toContain('data-anchor="fulltext:0"');
    expect(markup).toContain('data-anchor="fulltext:1"');
    expect(markup).toContain(
      '<mark data-annotation-id="one">Second</mark> paragraph.',
    );
  });
});

// A reader sent to a passage by a search result should land on the words in
// that passage, not on the document's first occurrence of them. Matches are
// numbered across the whole document, so the lookup has to map a block back
// onto every search piece it renders.
describe("the find's first match inside a passage", () => {
  // A corpus passage is a run of blocks deep-linked by its first member, so a
  // hit's anchor names where the passage starts, not where the words are.
  const blocks = [
    {
      anchorId: "p-1",
      id: "b-1",
      inlines: [
        { text: "The appellant relied on the contract.", type: "text" },
      ],
      plainText: "The appellant relied on the contract.",
      type: "paragraph",
    },
    {
      anchorId: "p-2",
      id: "b-2",
      inlines: [{ text: "The parties disagreed.", type: "text" }],
      plainText: "The parties disagreed.",
      type: "paragraph",
    },
    {
      anchorId: "p-3",
      id: "b-3",
      inlines: [{ text: "The contract was void.", type: "text" }],
      plainText: "The contract was void.",
      type: "paragraph",
    },
    {
      anchorId: "p-4",
      id: "b-4",
      inlines: [{ text: "Costs follow the event.", type: "text" }],
      number: 142,
      plainText: "Costs follow the event.",
      type: "paragraph",
    },
    {
      anchorId: "h-1",
      id: "b-5",
      inlines: [{ text: "Further reasons", type: "text" }],
      level: 2,
      plainText: "Further reasons",
      type: "heading",
    },
    {
      anchorId: "p-5",
      id: "b-6",
      inlines: [{ text: "The contract is mentioned once more.", type: "text" }],
      plainText: "The contract is mentioned once more.",
      type: "paragraph",
    },
  ] as const satisfies readonly Block[];

  const rangesFor = (query: string) =>
    buildSearchResults({
      pieces: buildDocumentAstSearchPieces(blocks),
      query,
    }).rangesByPieceId;

  test("the lowest match index in the passage is the one the reader lands on", () => {
    expect(
      firstMatchIndexInPassage({
        anchorId: "p-1",
        blocks,
        rangesByPieceId: rangesFor("contract"),
      }),
    ).toBe(0);
  });

  // The words that won the hit may sit in a block after the one the anchor
  // names. Reading the anchor block alone would miss them and send the reader
  // to the earlier, unrelated occurrence instead.
  test("a passage whose words sit in a later block still finds them", () => {
    expect(
      firstMatchIndexInPassage({
        anchorId: "p-2",
        blocks,
        rangesByPieceId: rangesFor("contract"),
      }),
    ).toBe(1);
  });

  // A heading closes the run it follows, so the scan must not read past one
  // into the next passage even when that passage matches.
  test("the scan stops at the heading that ends the passage", () => {
    expect(
      firstMatchIndexInPassage({
        anchorId: "p-4",
        blocks,
        rangesByPieceId: rangesFor("contract"),
      }),
    ).toBeNull();
    // The fixture has to carry a match beyond the heading, or the boundary is
    // never reached.
    expect(
      firstMatchIndexInPassage({
        anchorId: "p-5",
        blocks,
        rangesByPieceId: rangesFor("contract"),
      }),
    ).toBe(2);
  });

  test("a passage the query does not reach names no match", () => {
    expect(
      firstMatchIndexInPassage({
        anchorId: "p-5",
        blocks,
        rangesByPieceId: rangesFor("bankruptcy"),
      }),
    ).toBeNull();
    expect(
      firstMatchIndexInPassage({
        anchorId: "p-9",
        blocks,
        rangesByPieceId: rangesFor("contract"),
      }),
    ).toBeNull();
  });

  // A numbered paragraph hangs its number in the margin as a search piece of
  // its own; it is still that paragraph, so a match on it counts as one.
  test("the hanging paragraph number belongs to its own block", () => {
    expect(
      firstMatchIndexInPassage({
        anchorId: "p-4",
        blocks,
        rangesByPieceId: rangesFor("142"),
      }),
    ).toBe(0);
  });
});
