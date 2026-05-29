import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";

import type { Document, Table } from "../../types/document";
import { toProseDoc } from "./toProseDoc";

function makeDoc(table: Table): Document {
  return { package: { document: { content: [table] } } };
}

function firstTable(pmDoc: PMNode): PMNode {
  let table: PMNode | undefined;
  pmDoc.descendants((node) => {
    if (node.type.name === "table") {
      table = node;
      return false;
    }
    return true;
  });
  if (!table) {
    throw new Error("expected converted doc to contain a table");
  }
  return table;
}

describe("toProseDoc — literal empty <w:tr/> rows", () => {
  test("renders a fallback cell spanning the table width", () => {
    const doc = makeDoc({
      type: "table",
      columnWidths: [2400, 2400, 2400],
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
                    { type: "run", content: [{ type: "text", text: "A" }] },
                  ],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "run", content: [{ type: "text", text: "B" }] },
                  ],
                },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "run", content: [{ type: "text", text: "C" }] },
                  ],
                },
              ],
            },
          ],
        },
        { type: "tableRow", cells: [] },
      ],
    });

    const table = firstTable(toProseDoc(doc));

    expect(table.childCount).toBe(2);
    const emptyRow = table.child(1);
    expect(emptyRow.childCount).toBe(1);
    expect(emptyRow.child(0).attrs["colspan"]).toBe(3);
  });

  test("falls back to colspan 1 when the table has no grid columns", () => {
    const doc = makeDoc({
      type: "table",
      rows: [{ type: "tableRow", cells: [] }],
    });

    const table = firstTable(toProseDoc(doc));
    const row = table.child(0);

    expect(row.childCount).toBe(1);
    expect(row.child(0).attrs["colspan"]).toBe(1);
  });

  test("derives fallback colspan from later rows when the first row is empty", () => {
    const doc = makeDoc({
      type: "table",
      rows: [
        { type: "tableRow", cells: [] },
        {
          type: "tableRow",
          cells: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [] }],
            },
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [] }],
            },
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [] }],
            },
          ],
        },
      ],
    });

    const table = firstTable(toProseDoc(doc));
    const emptyRow = table.child(0);

    expect(emptyRow.childCount).toBe(1);
    expect(emptyRow.child(0).attrs["colspan"]).toBe(3);
  });
});
