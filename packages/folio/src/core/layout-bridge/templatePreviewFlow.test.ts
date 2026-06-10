import { describe, expect, test } from "bun:test";

import { measureParagraph } from "../layout-engine/measure";
import {
  fixedCharWidth,
  withFakeTextMeasure,
} from "../layout-engine/measure/__tests__/fakeTextMeasure";
import type {
  FlowBlock,
  ParagraphBlock,
  TableBlock,
  TextRun,
} from "../layout-engine/types";
import {
  applyTemplatePreviewToBlocks,
  templatePreviewDirtyRange,
} from "./templatePreviewFlow";

const textRun = (
  text: string,
  pmStart: number,
  extra: Partial<TextRun> = {},
): TextRun => ({
  kind: "text",
  text,
  pmStart,
  pmEnd: pmStart + text.length,
  ...extra,
});

const paragraph = (
  id: string,
  pmStart: number,
  runs: ParagraphBlock["runs"],
): ParagraphBlock => {
  const last = runs.at(-1);
  return {
    kind: "paragraph",
    id,
    runs,
    pmStart,
    pmEnd: (last?.pmEnd ?? pmStart) + 1,
  };
};

const runTexts = (block: FlowBlock): string[] => {
  if (block.kind !== "paragraph") {
    throw new Error("expected a paragraph block");
  }
  return block.runs.map((run) => (run.kind === "text" ? run.text : run.kind));
};

describe("applyTemplatePreviewToBlocks", () => {
  test("replaces the marker range inside a single run with the value", () => {
    // "before {{x}} after" — content starts at PM position 1.
    const source = paragraph("p1", 0, [textRun("before {{x}} after", 1)]);
    const [block] = applyTemplatePreviewToBlocks([source], {
      entries: [{ from: 8, to: 13, value: "1234" }],
      mode: "plain",
    });

    expect(runTexts(block!)).toEqual(["before ", "1234", " after"]);
    if (block!.kind !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const [prefix, value, suffix] = block!.runs as [TextRun, TextRun, TextRun];
    expect([prefix.pmStart, prefix.pmEnd]).toEqual([1, 8]);
    // The value run keeps the marker's PM range, not the value's length.
    expect([value.pmStart, value.pmEnd]).toEqual([8, 13]);
    expect(value.templatePreview).toBe("plain");
    expect([suffix.pmStart, suffix.pmEnd]).toEqual([13, 19]);
  });

  test("carries the hosting run's formatting onto the value run", () => {
    const source = paragraph("p1", 0, [
      textRun("{{client.name}}", 1, { bold: true, fontSize: 14 }),
    ]);
    const [block] = applyTemplatePreviewToBlocks([source], {
      entries: [{ from: 1, to: 16, value: "Maciej Kur" }],
      mode: "highlighted",
    });

    if (block!.kind !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const value = block!.runs[0] as TextRun;
    expect(value.text).toBe("Maciej Kur");
    expect(value.bold).toBe(true);
    expect(value.fontSize).toBe(14);
    expect(value.templatePreview).toBe("highlighted");
  });

  test("collapses a marker split across formatting boundaries into one value run", () => {
    const source = paragraph("p1", 0, [
      textRun("{{cli", 1, { italic: true }),
      textRun("ent.name}}", 6),
      textRun(" tail", 16),
    ]);
    const [block] = applyTemplatePreviewToBlocks([source], {
      entries: [{ from: 1, to: 16, value: "Acme" }],
      mode: "highlighted",
    });

    expect(runTexts(block!)).toEqual(["Acme", " tail"]);
    if (block!.kind !== "paragraph") {
      throw new Error("expected paragraph");
    }
    const value = block!.runs[0] as TextRun;
    // Formatting comes from the run hosting the marker start.
    expect(value.italic).toBe(true);
    expect([value.pmStart, value.pmEnd]).toEqual([1, 16]);
  });

  test("drops non-text inline nodes swallowed by the marker range", () => {
    const source = paragraph("p1", 0, [
      textRun("{{a", 1),
      { kind: "lineBreak", pmStart: 4, pmEnd: 5 },
      textRun("b}}", 5),
    ]);
    const [block] = applyTemplatePreviewToBlocks([source], {
      entries: [{ from: 1, to: 8, value: "v" }],
      mode: "plain",
    });

    expect(runTexts(block!)).toEqual(["v"]);
  });

  test("substitutes markers inside table cell paragraphs", () => {
    const table: TableBlock = {
      kind: "table",
      id: "t1",
      pmStart: 0,
      pmEnd: 30,
      rows: [
        {
          id: "r1",
          cells: [
            {
              id: "c1",
              blocks: [paragraph("p1", 2, [textRun("{{x}}", 3)])],
            },
          ],
        },
      ],
    };
    const [block] = applyTemplatePreviewToBlocks([table], {
      entries: [{ from: 3, to: 8, value: "cell value" }],
      mode: "plain",
    });

    if (block!.kind !== "table") {
      throw new Error("expected table");
    }
    const cellParagraph = block!.rows[0]!.cells[0]!.blocks[0]!;
    expect(runTexts(cellParagraph)).toEqual(["cell value"]);
  });

  test("returns untouched blocks by reference and the same array when nothing matches", () => {
    const touched = paragraph("p1", 0, [textRun("{{x}} text", 1)]);
    const untouched = paragraph("p2", 20, [textRun("plain text", 21)]);

    const unchanged = applyTemplatePreviewToBlocks([touched, untouched], {
      entries: [],
      mode: "plain",
    });
    expect(unchanged[0]).toBe(touched);
    expect(unchanged[1]).toBe(untouched);

    const transformed = applyTemplatePreviewToBlocks([touched, untouched], {
      entries: [{ from: 1, to: 6, value: "v" }],
      mode: "plain",
    });
    expect(transformed[0]).not.toBe(touched);
    expect(transformed[1]).toBe(untouched);
    // The source paragraph is never mutated — clearing the preview is just
    // laying out the original blocks again.
    expect(runTexts(touched)).toEqual(["{{x}} text"]);
  });

  test("substituted values reflow the paragraph instead of keeping the marker's width", () => {
    withFakeTextMeasure(
      () => {
        // 5px per char, 150px wide: the 25-char marker line fits in one
        // 125px line.
        const source = paragraph("p1", 0, [
          textRun("Name: ", 1),
          textRun("{{client.name}}", 7),
          textRun(" end", 22),
        ]);
        const sourceMeasure = measureParagraph(source, 150);
        expect(sourceMeasure.lines).toHaveLength(1);
        expect(sourceMeasure.lines[0]!.width).toBe(125);

        // Short value: the line shrinks to the value's width — no dead
        // space where the marker used to be.
        const [short] = applyTemplatePreviewToBlocks([source], {
          entries: [{ from: 7, to: 22, value: "1234" }],
          mode: "plain",
        });
        const shortMeasure = measureParagraph(short as ParagraphBlock, 150);
        expect(shortMeasure.lines).toHaveLength(1);
        // "Name: " (6) + "1234" (4) + " end" (4) = 14 chars * 5px.
        expect(shortMeasure.lines[0]!.width).toBe(70);

        // Long value: the paragraph wraps onto a second line instead of
        // overlapping the following text.
        const [long] = applyTemplatePreviewToBlocks([source], {
          entries: [
            { from: 7, to: 22, value: "An Unusually Long Company Name Ltd." },
          ],
          mode: "plain",
        });
        const longMeasure = measureParagraph(long as ParagraphBlock, 150);
        expect(longMeasure.lines.length).toBeGreaterThan(1);
      },
      { charWidth: fixedCharWidth(5) },
    );
  });
});

describe("templatePreviewDirtyRange", () => {
  const entryA = { from: 5, to: 12, value: "a" };
  const entryB = { from: 40, to: 55, value: "b" };

  test("returns null when the substituted content is identical", () => {
    expect(templatePreviewDirtyRange([entryA, entryB], [entryA, entryB])).toBe(
      null,
    );
  });

  test("covers only the changed entry", () => {
    expect(
      templatePreviewDirtyRange(
        [entryA, entryB],
        [entryA, { ...entryB, value: "b2" }],
      ),
    ).toEqual({ from: 40, to: 55 });
  });

  test("covers added and removed entries", () => {
    expect(templatePreviewDirtyRange([], [entryA])).toEqual({
      from: 5,
      to: 12,
    });
    expect(templatePreviewDirtyRange([entryA, entryB], [entryB])).toEqual({
      from: 5,
      to: 12,
    });
    expect(templatePreviewDirtyRange([entryA], [entryB])).toEqual({
      from: 5,
      to: 55,
    });
  });
});
