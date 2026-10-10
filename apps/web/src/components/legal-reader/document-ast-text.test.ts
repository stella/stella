import { createElement } from "react";

import { describe, expect, test } from "bun:test";

import {
  BlockRenderer,
  FulltextFallback,
  HEADING_CLASS,
} from "@stll/decision-reader/document-ast-text";
import type { HeadingLevel } from "@stll/legal-ast/document-ast";

import { renderReaderFixture as renderToStaticMarkup } from "../../../../../packages/decision-reader/src/decision-text.test";

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

// The reader states a size in one of two scale-aware ways: a size token,
// which `reader.css` redefines against `--reader-text-scale`, or an
// arbitrary value that multiplies its own rem by that same scale. Both read
// as a rem at scale 1. A bare `text-[1.35rem]` is neither: it looks right at
// rest and silently drops out of the reader's zoom, so `remOf` refuses it
// instead of measuring it.
const READER_SIZE_TOKEN_REM = {
  // `text-base` is the body size the reading column is set in.
  "text-sm": 0.875,
  "text-base": 1,
  "text-lg": 1.125,
} as const;

const SCALED_REM =
  /text-\[calc\((?<rem>\d+(?:\.\d+)?)rem\*var\(--reader-text-scale\)\)\]/u;

const remOf = (level: HeadingLevel): number => {
  const classes = HEADING_CLASS.statute[level];
  const scaled = SCALED_REM.exec(classes)?.groups?.["rem"];

  if (scaled !== undefined) {
    return Number(scaled);
  }

  const token = Object.entries(READER_SIZE_TOKEN_REM).find(([name]) =>
    classes.includes(name),
  );

  if (token === undefined) {
    throw new Error(
      `statute heading level ${String(level)} states no scale-aware size`,
    );
  }

  return token[1];
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

describe("footnote tables", () => {
  test("renders table note membership and its printed mark", () => {
    const markup = renderToStaticMarkup(
      createElement(BlockRenderer, {
        activeMatchIndex: -1,
        anchorPresentation: "embedded",
        block: {
          anchorId: "note-5-table",
          id: "b103",
          note: { type: "footnote", label: "5", noteId: "fn5" },
          plainText: "A\tB",
          rows: [
            [
              { inlines: [{ text: "A", type: "text" }], plainText: "A" },
              { inlines: [{ text: "B", type: "text" }], plainText: "B" },
            ],
          ],
          type: "table",
        },
        rangesByPieceId: {},
        variant: "case-law",
      }),
    );

    expect(markup).toContain('data-note="footnote"');
    expect(markup).toContain(
      'class="reader-note-label" data-reader-chrome="">5</span>',
    );
    expect(markup).toContain("<table");
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
