import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import type { HeadingLevel } from "@stll/legal-ast/document-ast";

import {
  BlockRenderer,
  FulltextFallback,
  HEADING_CLASS,
} from "@/components/legal-reader/document-ast-text";

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
