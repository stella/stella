import { describe, expect, test } from "bun:test";

import type {
  ParagraphBlock,
  TableBlock as LayoutTableBlock,
  TextRun,
} from "../layout-engine/types";
import { toProseDoc } from "../prosemirror/conversion/toProseDoc";
import type {
  Document,
  Paragraph,
  StyleDefinitions,
  Table,
} from "../types/document";
import { toFlowBlocks } from "./toFlowBlocks";

function makeDoc(paragraph: Paragraph, styles?: StyleDefinitions): Document {
  return {
    package: {
      document: { content: [paragraph] },
      ...(styles ? { styles } : {}),
    },
  };
}

function firstParagraph(blocks: unknown[]): ParagraphBlock {
  return blocks.find(
    (block) => (block as ParagraphBlock).kind === "paragraph",
  ) as ParagraphBlock;
}

function firstRun(blocks: unknown[]): TextRun {
  return firstParagraph(blocks).runs[0] as TextRun;
}

function firstTableRun(blocks: unknown[]): TextRun {
  const table = blocks.find(
    (block) => (block as LayoutTableBlock).kind === "table",
  ) as LayoutTableBlock;
  const paragraph = table.rows[0]?.cells[0]?.blocks[0] as ParagraphBlock;
  return paragraph.runs[0] as TextRun;
}

describe("toFlowBlocks style cascade", () => {
  test("paragraph style rFonts reaches runs without explicit font marks", () => {
    const styles: StyleDefinitions = {
      styles: [
        {
          styleId: "Normal",
          type: "paragraph",
          default: true,
          name: "Normal",
          rPr: { fontFamily: { ascii: "Arial Narrow", hAnsi: "Arial Narrow" } },
        },
        {
          styleId: "Clauses",
          type: "paragraph",
          basedOn: "Normal",
          name: "Clauses",
          rPr: { fontFamily: { ascii: "Arial Narrow", hAnsi: "Arial Narrow" } },
        },
      ],
    };
    const paragraph: Paragraph = {
      type: "paragraph",
      formatting: { styleId: "Clauses" },
      content: [
        {
          type: "run",
          content: [{ type: "text", text: "clause one" }],
        },
      ],
    };

    const blocks = toFlowBlocks(
      toProseDoc(makeDoc(paragraph, styles), { styles }),
      {},
    );

    expect(firstRun(blocks).fontFamily).toBe("Arial Narrow");
  });

  test("run with partial rFonts inherits ascii font from paragraph defaults", () => {
    const styles: StyleDefinitions = {
      styles: [
        {
          styleId: "Normal",
          type: "paragraph",
          default: true,
          name: "Normal",
          rPr: { fontFamily: { ascii: "Arial Narrow", hAnsi: "Arial Narrow" } },
        },
      ],
    };
    const paragraph: Paragraph = {
      type: "paragraph",
      formatting: { styleId: "Normal" },
      content: [
        {
          type: "run",
          formatting: { fontFamily: { eastAsia: "Calibri" } },
          content: [{ type: "text", text: "mixed" }],
        },
      ],
    };

    const blocks = toFlowBlocks(
      toProseDoc(makeDoc(paragraph, styles), { styles }),
      {},
    );

    expect(firstRun(blocks).fontFamily).toBe("Arial Narrow");
  });

  test("explicit run formatting toggles override paragraph style defaults", () => {
    const styles: StyleDefinitions = {
      styles: [
        {
          styleId: "Heading",
          type: "paragraph",
          name: "Heading",
          rPr: {
            bold: true,
            italic: true,
            allCaps: true,
          },
        },
      ],
    };
    const paragraph: Paragraph = {
      type: "paragraph",
      formatting: { styleId: "Heading" },
      content: [
        {
          type: "run",
          formatting: {
            bold: false,
            italic: false,
            allCaps: false,
          },
          content: [{ type: "text", text: "Keep mixed case" }],
        },
      ],
    };

    const blocks = toFlowBlocks(
      toProseDoc(makeDoc(paragraph, styles), { styles }),
      {},
    );
    const run = firstRun(blocks);

    expect(run.bold).toBe(false);
    expect(run.italic).toBe(false);
    expect(run.allCaps).toBe(false);
  });

  test("default character style reaches runs without rStyle", () => {
    const styles: StyleDefinitions = {
      docDefaults: { rPr: { fontSize: 22 } },
      styles: [
        {
          styleId: "Normal",
          type: "paragraph",
          default: true,
          name: "Normal",
        },
        {
          styleId: "FontePadrao",
          type: "character",
          default: true,
          name: "Default Paragraph Font",
          rPr: { fontFamily: { ascii: "Cambria", hAnsi: "Cambria" } },
        },
      ],
    };
    const paragraph: Paragraph = {
      type: "paragraph",
      content: [{ type: "run", content: [{ type: "text", text: "plain" }] }],
    };

    const blocks = toFlowBlocks(
      toProseDoc(makeDoc(paragraph, styles), { styles }),
      {},
    );

    expect(firstRun(blocks).fontFamily).toBe("Cambria");
  });

  test("table conditionals without rPr do not override paragraph run defaults", () => {
    const styles: StyleDefinitions = {
      styles: [
        {
          styleId: "Normal",
          type: "paragraph",
          default: true,
          name: "Normal",
          rPr: { fontFamily: { ascii: "Arial", hAnsi: "Arial" } },
        },
        {
          styleId: "FontePadrao",
          type: "character",
          default: true,
          name: "Default Paragraph Font",
          rPr: { fontFamily: { ascii: "Cambria", hAnsi: "Cambria" } },
        },
        {
          styleId: "BandedTable",
          type: "table",
          name: "Banded Table",
          tblStylePr: [
            {
              type: "firstRow",
              tcPr: { shading: { fill: { rgb: "EEEEEE" } } },
            },
          ],
        },
      ],
    };
    const table: Table = {
      type: "table",
      formatting: { styleId: "BandedTable", look: { firstRow: true } },
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  formatting: { styleId: "Normal" },
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "first row" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const blocks = toFlowBlocks(
      toProseDoc(
        {
          package: {
            document: { content: [table] },
            styles,
          },
        },
        { styles },
      ),
      {},
    );

    expect(firstTableRun(blocks).fontFamily).toBe("Arial");
  });

  test("default table style supplies cell margins when table has no style ID", () => {
    const styles: StyleDefinitions = {
      styles: [
        {
          styleId: "TableNormal",
          type: "table",
          default: true,
          name: "Normal Table",
          tblPr: {
            cellMargins: {
              left: { value: 144, type: "dxa" },
              right: { value: 288, type: "dxa" },
            },
          },
        },
      ],
    };
    const table: Table = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const document: Document = {
      package: {
        document: { content: [table] },
        styles,
      },
    };

    const pmDoc = toProseDoc(document, { styles });
    const tableNode = pmDoc.firstChild;

    expect(tableNode?.attrs["cellMargins"]).toEqual({
      left: 144,
      right: 288,
    });

    const tableBlock = toFlowBlocks(pmDoc, {})[0];
    expect(tableBlock?.kind).toBe("table");
    if (tableBlock?.kind === "table") {
      expect(tableBlock.rows[0]?.cells[0]?.padding?.left).toBeCloseTo(9.6, 1);
      expect(tableBlock.rows[0]?.cells[0]?.padding?.right).toBeCloseTo(19.2, 1);
    }
  });

  test("default table style supplies conditional formatting when table has no style ID", () => {
    const styles: StyleDefinitions = {
      styles: [
        {
          styleId: "DefaultGrid",
          type: "table",
          default: true,
          name: "Default Grid",
          tblStylePr: [
            {
              type: "wholeTable",
              tcPr: { shading: { fill: { rgb: "D9EAF7" } } },
              rPr: { bold: true },
            },
          ],
        },
      ],
    };
    const table: Table = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "default styled" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const document: Document = {
      package: {
        document: { content: [table] },
        styles,
      },
    };

    const tableBlock = toFlowBlocks(toProseDoc(document, { styles }), {})[0];
    expect(tableBlock?.kind).toBe("table");
    if (tableBlock?.kind === "table") {
      const cell = tableBlock.rows.at(0)?.cells.at(0);
      const paragraph = cell?.blocks.at(0) as ParagraphBlock | undefined;
      const run = paragraph?.runs.at(0) as TextRun | undefined;

      expect(cell?.background).toBe("#D9EAF7");
      expect(run?.bold).toBe(true);
    }
  });

  test("style-less tables use built-in TableNormal side padding", () => {
    const table: Table = {
      type: "table",
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const document: Document = {
      package: {
        document: { content: [table] },
      },
    };

    const tableBlock = toFlowBlocks(toProseDoc(document), {})[0];
    expect(tableBlock?.kind).toBe("table");
    if (tableBlock?.kind === "table") {
      const padding = tableBlock.rows.at(0)?.cells.at(0)?.padding;
      expect(padding?.top).toBe(0);
      expect(padding?.right).toBeCloseTo(7.2, 1);
      expect(padding?.bottom).toBe(0);
      expect(padding?.left).toBeCloseTo(7.2, 1);
    }
  });

  test("explicit zero cell margins fall through to table defaults", () => {
    const table: Table = {
      type: "table",
      formatting: {
        cellMargins: {
          left: { value: 144, type: "dxa" },
          right: { value: 288, type: "dxa" },
        },
      },
      rows: [
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              formatting: {
                margins: {
                  left: { value: 0, type: "dxa" },
                  right: { value: 0, type: "dxa" },
                },
              },
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "run",
                      content: [{ type: "text", text: "cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const document: Document = {
      package: {
        document: { content: [table] },
      },
    };

    const tableBlock = toFlowBlocks(toProseDoc(document), {})[0];
    expect(tableBlock?.kind).toBe("table");
    if (tableBlock?.kind === "table") {
      const padding = tableBlock.rows.at(0)?.cells.at(0)?.padding;
      expect(padding?.left).toBeCloseTo(9.6, 1);
      expect(padding?.right).toBeCloseTo(19.2, 1);
    }
  });
});
