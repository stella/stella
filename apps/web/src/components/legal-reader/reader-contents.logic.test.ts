import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { Block, HeadingLevel } from "@stll/legal-ast/document-ast";
import { assertProperty } from "@stll/property-testing";

import { readerBreadcrumbPaths } from "./reader-breadcrumb-paths";
import type { ReaderBreadcrumbSegment } from "./reader-breadcrumb.logic";
import { readerContents } from "./reader-contents.logic";
import type {
  ReaderAnalysisOutline,
  ReaderContentsRow,
} from "./reader-contents.logic";

type BlockSpec =
  | { type: "paragraph" }
  | { type: "heading"; level: HeadingLevel; title: string };

type SectionSpec = { anchorId: string; title: string };

const documentBlocks = (specs: readonly BlockSpec[]): Block[] =>
  specs.map((spec, index): Block => {
    const anchorId = `b${String(index)}`;
    switch (spec.type) {
      case "paragraph":
        return {
          type: "paragraph",
          id: anchorId,
          anchorId,
          plainText: `Paragraph ${String(index)}`,
          inlines: [],
        };
      case "heading":
        return {
          type: "heading",
          id: anchorId,
          anchorId,
          level: spec.level,
          plainText: spec.title,
          inlines: [],
        };
      default:
        spec satisfies never;
        throw new Error("Unhandled block spec");
    }
  });

/** A flat analysis outline as a model returns it, repeats and stray anchors included. */
const analysisOutline = (
  sections: readonly SectionSpec[],
): ReaderAnalysisOutline => {
  const paths = new Map<string, readonly ReaderBreadcrumbSegment[]>();
  for (const section of sections) {
    if (!paths.has(section.anchorId)) {
      paths.set(section.anchorId, [section]);
    }
  }
  return {
    disclosure: "caseLaw",
    sections: { headings: sections, paths },
  };
};

const contentsOf = ({
  blocks,
  sections,
}: {
  blocks: readonly Block[];
  sections: readonly SectionSpec[] | undefined;
}) =>
  readerContents({
    anchorOrder: blocks.map(({ anchorId }) => anchorId),
    headings: readerBreadcrumbPaths(blocks),
    analysis: sections === undefined ? undefined : analysisOutline(sections),
  });

const MAX_BLOCKS = 12;
const MAX_SECTIONS = 10;
const titleArbitrary = fc.constantFrom(
  "USNESENÍ",
  "Odůvodnění:",
  "I.",
  "Outcome",
  "Reasoning",
  "",
  "ﺍﻟﺤﻜﻢ",
);
const blockSpecArbitrary: fc.Arbitrary<BlockSpec> = fc.oneof(
  fc.constant({ type: "paragraph" } as const),
  fc.record({
    type: fc.constant("heading" as const),
    level: fc.constantFrom<HeadingLevel>(1, 2, 3),
    title: titleArbitrary,
  }),
);
// Anchors past the last block stand for model output naming no block.
const sectionArbitrary = fc.record({
  anchorId: fc
    .integer({ min: 0, max: MAX_BLOCKS + 2 })
    .map((index) => `b${String(index)}`),
  title: titleArbitrary,
});
const documentArbitrary = fc.record({
  blocks: fc
    .array(blockSpecArbitrary, { maxLength: MAX_BLOCKS })
    .map(documentBlocks),
  sections: fc.array(sectionArbitrary, { maxLength: MAX_SECTIONS }),
});

const isHeadingRow = (row: ReaderContentsRow) =>
  row.type === "heading" || row.type === "headingWithAnalysis";

const headingsOf = (blocks: readonly Block[]) =>
  blocks.flatMap((block) =>
    block.type === "heading"
      ? [{ anchorId: block.anchorId, title: block.plainText }]
      : [],
  );

/** The first section the model placed at each anchor the document has. */
const placedSections = ({
  blocks,
  sections,
}: {
  blocks: readonly Block[];
  sections: readonly SectionSpec[];
}) => {
  const anchors = new Set(blocks.map(({ anchorId }) => anchorId));
  const placed = new Map<string, string>();
  for (const { anchorId, title } of sections) {
    if (anchors.has(anchorId) && !placed.has(anchorId)) {
      placed.set(anchorId, title);
    }
  }
  return placed;
};

describe("reader contents", () => {
  test("reader contents lists every heading as written, in reading order, with each placed section once", () => {
    assertProperty(
      "reader contents lists every heading as written, in reading order, with each placed section once",
      fc.property(documentArbitrary, ({ blocks, sections }) => {
        const { rows } = contentsOf({ blocks, sections });
        const position = new Map(
          blocks.map(({ anchorId }, index) => [anchorId, index]),
        );
        const positions = rows.map(
          ({ anchorId }) => position.get(anchorId) ?? -1,
        );
        expect(positions.every((at) => at >= 0)).toBe(true);
        expect(positions).toEqual(positions.toSorted((a, b) => a - b));
        expect(new Set(positions).size).toBe(positions.length);

        expect(
          rows
            .filter(isHeadingRow)
            .map(({ anchorId, title }) => ({ anchorId, title })),
        ).toEqual(headingsOf(blocks));

        const placed = placedSections({ blocks, sections });
        const shown = new Map(
          rows.flatMap((row) => {
            switch (row.type) {
              case "heading":
                return [];
              case "analysis":
                return [[row.anchorId, row.title] as const];
              case "headingWithAnalysis":
                return [[row.anchorId, row.analysisTitle] as const];
              default:
                row satisfies never;
                throw new Error("Unhandled contents row");
            }
          }),
        );
        expect(shown).toEqual(placed);
        const headingAnchors = new Set(
          headingsOf(blocks).map(({ anchorId }) => anchorId),
        );
        for (const row of rows) {
          expect(row.type === "analysis").toBe(
            !headingAnchors.has(row.anchorId),
          );
        }
      }),
    );
  });

  test("reader contents without analysis is the headings alone", () => {
    assertProperty(
      "reader contents without analysis is the headings alone",
      fc.property(documentArbitrary, fc.boolean(), ({ blocks }, absent) => {
        const { rows } = contentsOf({
          blocks,
          sections: absent ? undefined : [],
        });
        expect(rows).toEqual(
          headingsOf(blocks).map(({ anchorId, title }) => ({
            type: "heading",
            anchorId,
            title,
          })),
        );
      }),
    );
  });

  test("reader contents keeps every shown row in place as sections arrive", () => {
    assertProperty(
      "reader contents keeps every shown row in place as sections arrive",
      fc.property(documentArbitrary, ({ blocks, sections }) => {
        for (let count = 0; count < sections.length; count += 1) {
          const before = contentsOf({
            blocks,
            sections: sections.slice(0, count),
          }).rows;
          const after = contentsOf({
            blocks,
            sections: sections.slice(0, count + 1),
          }).rows;
          const afterByAnchor = new Map(
            after.map((row) => [row.anchorId, row]),
          );
          // Earlier rows survive with their titles and keep their order.
          const kept = after.filter(({ anchorId }) =>
            before.some((row) => row.anchorId === anchorId),
          );
          expect(kept.map(({ anchorId }) => anchorId)).toEqual(
            before.map(({ anchorId }) => anchorId),
          );
          for (const row of before) {
            const next = afterByAnchor.get(row.anchorId);
            expect(next?.title).toBe(row.title);
            switch (row.type) {
              case "heading":
                expect(next?.type === "analysis").toBe(false);
                break;
              case "analysis":
              case "headingWithAnalysis":
                expect(next).toEqual(row);
                break;
              default:
                row satisfies never;
                throw new Error("Unhandled contents row");
            }
          }
          expect(after.length - before.length).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  test("reader contents gives a section the trail of the heading it is in", () => {
    assertProperty(
      "reader contents gives a section the trail of the heading it is in",
      fc.property(documentArbitrary, ({ blocks, sections }) => {
        const headings = readerBreadcrumbPaths(blocks);
        const outline = analysisOutline(sections);
        const { rows, trails } = contentsOf({ blocks, sections });
        expect([...trails.keys()].toSorted()).toEqual(
          rows.map(({ anchorId }) => anchorId).toSorted(),
        );
        let enclosing: readonly ReaderBreadcrumbSegment[] = [];
        for (const row of rows) {
          const trail = trails.get(row.anchorId);
          if (isHeadingRow(row)) {
            enclosing = headings.paths.get(row.anchorId) ?? [];
            expect(trail?.at(-1)).toEqual({
              anchorId: row.anchorId,
              title: row.title,
            });
            expect(trail).toEqual(enclosing);
          } else if (headings.headings.length === 0) {
            expect(trail).toEqual(outline.sections.paths.get(row.anchorId));
          } else {
            expect(trail).toEqual(enclosing);
          }
        }
      }),
    );
  });

  test("a section starting at a heading shares its row and never renames it", () => {
    const blocks = documentBlocks([
      { type: "heading", level: 1, title: "USNESENÍ" },
      { type: "paragraph" },
      { type: "heading", level: 1, title: "Odůvodnění:" },
      { type: "paragraph" },
    ]);
    const { rows } = contentsOf({
      blocks,
      sections: [
        { anchorId: "b3", title: "Reasons for dismissal" },
        { anchorId: "b0", title: "Heading and operative part" },
        { anchorId: "b0", title: "A later title at the same anchor" },
        { anchorId: "missing", title: "Section naming no block" },
      ],
    });
    expect(rows).toEqual([
      {
        type: "headingWithAnalysis",
        anchorId: "b0",
        title: "USNESENÍ",
        analysisTitle: "Heading and operative part",
        disclosure: "caseLaw",
      },
      { type: "heading", anchorId: "b2", title: "Odůvodnění:" },
      {
        type: "analysis",
        anchorId: "b3",
        title: "Reasons for dismissal",
        disclosure: "caseLaw",
      },
    ]);
  });
});
