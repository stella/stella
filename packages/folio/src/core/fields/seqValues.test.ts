import { describe, expect, test } from "bun:test";

import type {
  FieldRun,
  FlowBlock,
  ParagraphBlock,
  TableBlock,
} from "../layout-engine/types";
import { buildSeqValues } from "./seqValues";

const seq = (pmStart: number, instruction: string): FieldRun => ({
  kind: "field",
  fieldType: "OTHER",
  instruction,
  pmStart,
});

const para = (id: string, fields: FieldRun[]): ParagraphBlock => ({
  kind: "paragraph",
  id,
  runs: fields,
});

describe("buildSeqValues", () => {
  test("counts per identifier independently in document order", () => {
    const blocks: FlowBlock[] = [
      para("p1", [seq(10, "SEQ Figure"), seq(20, "SEQ Table")]),
      para("p2", [seq(30, "SEQ Figure")]),
      para("p3", [seq(40, "SEQ Figure \\* ROMAN"), seq(50, "SEQ Table")]),
    ];

    const values = buildSeqValues(blocks);

    expect(values.get(10)).toBe(1); // Figure 1
    expect(values.get(30)).toBe(2); // Figure 2
    expect(values.get(40)).toBe(3); // Figure 3 (format applied later by evaluator)
    expect(values.get(20)).toBe(1); // Table 1
    expect(values.get(50)).toBe(2); // Table 2
  });

  test("\\r resets the counter and \\c repeats without advancing", () => {
    const blocks: FlowBlock[] = [
      para("p1", [seq(10, "SEQ Figure")]), // 1
      para("p2", [seq(20, "SEQ Figure \\r 5")]), // reset to 5
      para("p3", [seq(30, "SEQ Figure \\c")]), // repeat 5
      para("p4", [seq(40, "SEQ Figure")]), // 6
    ];

    const values = buildSeqValues(blocks);

    expect(values.get(10)).toBe(1);
    expect(values.get(20)).toBe(5);
    expect(values.get(30)).toBe(5);
    expect(values.get(40)).toBe(6);
  });

  test("counts SEQ fields inside table cells in document order", () => {
    const table: TableBlock = {
      kind: "table",
      id: "t",
      columnWidths: [120],
      rows: [
        {
          id: "r0",
          cells: [
            { id: "c0", blocks: [para("cap0", [seq(10, "SEQ Figure")])] },
          ],
        },
        {
          id: "r1",
          cells: [
            { id: "c1", blocks: [para("cap1", [seq(20, "SEQ Figure")])] },
          ],
        },
      ],
    };
    const blocks: FlowBlock[] = [table, para("after", [seq(30, "SEQ Figure")])];

    const values = buildSeqValues(blocks);

    expect(values.get(10)).toBe(1);
    expect(values.get(20)).toBe(2);
    expect(values.get(30)).toBe(3);
  });
});
