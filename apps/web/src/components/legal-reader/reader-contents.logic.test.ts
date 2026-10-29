import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { withDashSubheadingLevels } from "@stll/legal-ast/dash-subheadings";
import type { Block, HeadingLevel } from "@stll/legal-ast/document-ast";
import { comparableHeadingTitle } from "@stll/legal-ast/source-contents";
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

/**
 * The block a section's row stands at: the heading at its anchor; else the
 * heading of the same title that encloses its block or comes right after it,
 * walking the blocks outwards to the nearest heading on each side; else its
 * own block. A section naming a block the document lacks belongs to the first
 * heading of its title, if any.
 */
const sectionRowAnchor = (
  blocks: readonly Block[],
  { anchorId, title }: SectionSpec,
): string => {
  const same = (block: Block | undefined) =>
    block?.type === "heading" &&
    comparableHeadingTitle(block.plainText) === comparableHeadingTitle(title);
  const at = blocks.findIndex((block) => block.anchorId === anchorId);
  if (at === -1) {
    return blocks.find((block) => same(block))?.anchorId ?? anchorId;
  }
  if (blocks[at]?.type === "heading") {
    return anchorId;
  }
  const before = blocks
    .slice(0, at)
    .findLast((block) => block.type === "heading");
  const after = blocks.slice(at + 1).find((block) => block.type === "heading");
  return [before, after].find((block) => same(block))?.anchorId ?? anchorId;
};

/** The first section placed at each row the document has. */
const placedSections = ({
  blocks,
  sections,
}: {
  blocks: readonly Block[];
  sections: readonly SectionSpec[];
}) => {
  const anchors = new Set(blocks.map(({ anchorId }) => anchorId));
  const placed = new Map<string, string>();
  for (const section of sections) {
    const rowAnchor = sectionRowAnchor(blocks, section);
    if (anchors.has(rowAnchor) && !placed.has(rowAnchor)) {
      placed.set(rowAnchor, section.title);
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

  test("reader contents gives a section the trail of the heading it is in, and marks a model's trail", () => {
    assertProperty(
      "reader contents gives a section the trail of the heading it is in, and marks a model's trail",
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
            expect(trail?.segments.at(-1)).toEqual({
              anchorId: row.anchorId,
              title: row.title,
            });
            expect(trail).toEqual({ type: "document", segments: enclosing });
          } else if (headings.headings.length === 0) {
            // Only a model titled this trail, so it says so.
            expect(trail).toEqual({
              type: "analysis",
              segments:
                outline.sections.paths.get(row.anchorId) ??
                panic(`Analysis row ${row.anchorId} has no section path`),
              disclosure: "caseLaw",
            });
          } else {
            expect(trail).toEqual({ type: "document", segments: enclosing });
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

  test("a section titled as the heading it starts under shares that heading's row", () => {
    const blocks = documentBlocks([
      { type: "paragraph" },
      { type: "heading", level: 2, title: "Účastníci řízení" },
      { type: "paragraph" },
      { type: "heading", level: 2, title: "Odůvodnění rozsudku" },
      { type: "paragraph" },
      { type: "heading", level: 2, title: "Výrok" },
      { type: "paragraph" },
    ]);
    const { rows } = contentsOf({
      blocks,
      sections: [
        // Starts at the first passage under its heading.
        { anchorId: "b2", title: "ÚČASTNÍCI ŘÍZENÍ" },
        // Starts at a block the reader does not show (a contents line).
        { anchorId: "toc-2", title: "Odůvodnění rozsudku" },
        // Titled as a heading two headings away: it keeps its own row.
        { anchorId: "b0", title: "Výrok" },
      ],
    });
    expect(rows).toEqual([
      {
        type: "analysis",
        anchorId: "b0",
        title: "Výrok",
        disclosure: "caseLaw",
      },
      {
        type: "headingWithAnalysis",
        anchorId: "b1",
        title: "Účastníci řízení",
        analysisTitle: "ÚČASTNÍCI ŘÍZENÍ",
        disclosure: "caseLaw",
      },
      {
        type: "headingWithAnalysis",
        anchorId: "b3",
        title: "Odůvodnění rozsudku",
        analysisTitle: "Odůvodnění rozsudku",
        disclosure: "caseLaw",
      },
      { type: "heading", anchorId: "b5", title: "Výrok" },
    ]);
  });

  // The shape the published corpus holds for a Court of Justice appeal: the
  // same dash-led pair under every ground, stored at the ground's own level.
  const appeal = () =>
    withDashSubheadingLevels(
      documentBlocks([
        { type: "heading", level: 2, title: "The appeal" },
        { type: "heading", level: 3, title: "Substance" },
        { type: "heading", level: 4, title: "The first ground of appeal" },
        { type: "heading", level: 4, title: "– Arguments of the parties" },
        { type: "paragraph" },
        { type: "heading", level: 4, title: "– Findings of the Court" },
        { type: "paragraph" },
        { type: "heading", level: 4, title: "The second ground of appeal" },
        { type: "heading", level: 4, title: "– Arguments of the parties" },
        { type: "paragraph" },
      ]),
    );

  test("a subheading repeated under each ground is indented under the ground it answers", () => {
    const { rows, trails, depths } = contentsOf({
      blocks: appeal(),
      sections: undefined,
    });
    expect(
      rows.map(({ anchorId, title }) => [title, depths.get(anchorId)]),
    ).toEqual([
      ["The appeal", 0],
      ["Substance", 1],
      ["The first ground of appeal", 2],
      ["– Arguments of the parties", 3],
      ["– Findings of the Court", 3],
      ["The second ground of appeal", 2],
      ["– Arguments of the parties", 3],
    ]);
    // No two rows read the same once the heading each sits under is named.
    const placed = rows.map(
      ({ anchorId, title }) =>
        `${trails.get(anchorId)?.segments.at(-2)?.title ?? ""} › ${title}`,
    );
    expect(new Set(placed).size).toBe(rows.length);
  });

  test("a section titled without the dash merges into the subheading it starts under", () => {
    const { rows } = contentsOf({
      blocks: appeal(),
      sections: [{ anchorId: "b9", title: "Arguments of the parties" }],
    });
    expect(rows.filter(({ type }) => type !== "heading")).toEqual([
      {
        type: "headingWithAnalysis",
        anchorId: "b8",
        title: "– Arguments of the parties",
        analysisTitle: "Arguments of the parties",
        disclosure: "caseLaw",
      },
    ]);
  });
});
