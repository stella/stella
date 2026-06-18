import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import { CellSelection } from "prosemirror-tables";

import { schema, singletonManager } from "../../schema";

const createTableStateWithNullBorders = () => {
  const doc = schema.node("doc", null, [
    schema.node("table", null, [
      schema.node("tableRow", null, [
        schema.node("tableCell", { borders: null }, [
          schema.node("paragraph", null, [schema.text("A")]),
        ]),
        schema.node("tableCell", { borders: null }, [
          schema.node("paragraph", null, [schema.text("B")]),
        ]),
      ]),
    ]),
  ]);

  const cursorPos = { value: null as number | null };
  doc.descendants((node, pos) => {
    if (cursorPos.value !== null || node.text !== "A") {
      return;
    }
    cursorPos.value = pos;
    return false;
  });

  if (cursorPos.value === null) {
    throw new Error("Expected table cell text position");
  }

  return EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, cursorPos.value),
  });
};

const runTableCommand = (
  state: EditorState,
  commandName: string,
  ...values: unknown[]
) => {
  const commandFactory = singletonManager.getCommand(commandName);
  if (!commandFactory) {
    throw new Error(`Missing command: ${commandName}`);
  }

  let nextState = state;
  const handled = commandFactory(...values)(state, (tr: Transaction) => {
    nextState = state.apply(tr);
  });

  expect(handled).toBe(true);
  return nextState;
};

const firstTableCell = (doc: PMNode) => {
  const cell = { value: null as PMNode | null };
  doc.descendants((node) => {
    if (cell.value !== null || node.type.name !== "tableCell") {
      return;
    }
    cell.value = node;
    return false;
  });

  if (cell.value === null) {
    throw new Error("Expected table cell");
  }

  return cell.value;
};

describe("table border commands", () => {
  test("setTableBorderColor creates borders on a cell with null borders", () => {
    const state = runTableCommand(
      createTableStateWithNullBorders(),
      "setTableBorderColor",
      "#336699",
    );

    expect(firstTableCell(state.doc).attrs["borders"]).toMatchObject({
      bottom: { color: { rgb: "336699" }, size: 4, style: "single" },
      left: { color: { rgb: "336699" }, size: 4, style: "single" },
      right: { color: { rgb: "336699" }, size: 4, style: "single" },
      top: { color: { rgb: "336699" }, size: 4, style: "single" },
    });
  });

  test("setTableBorderWidth creates borders on a cell with null borders", () => {
    const state = runTableCommand(
      createTableStateWithNullBorders(),
      "setTableBorderWidth",
      12,
    );

    expect(firstTableCell(state.doc).attrs["borders"]).toMatchObject({
      bottom: { color: { rgb: "000000" }, size: 12, style: "single" },
      left: { color: { rgb: "000000" }, size: 12, style: "single" },
      right: { color: { rgb: "000000" }, size: 12, style: "single" },
      top: { color: { rgb: "000000" }, size: 12, style: "single" },
    });
  });

  test("setCellBorder creates a single border on a cell with null borders", () => {
    const state = runTableCommand(
      createTableStateWithNullBorders(),
      "setCellBorder",
      "left",
      { color: { rgb: "AA0000" }, size: 8, style: "single" },
      false,
    );

    expect(firstTableCell(state.doc).attrs["borders"]).toMatchObject({
      left: { color: { rgb: "AA0000" }, size: 8, style: "single" },
    });
  });

  test("setAllTableBorders creates borders on a cell with null borders", () => {
    const state = runTableCommand(
      createTableStateWithNullBorders(),
      "setAllTableBorders",
      { color: { rgb: "00AA00" }, size: 6, style: "single" },
    );

    expect(firstTableCell(state.doc).attrs["borders"]).toMatchObject({
      bottom: { color: { rgb: "00AA00" }, size: 6, style: "single" },
      left: { color: { rgb: "00AA00" }, size: 6, style: "single" },
      right: { color: { rgb: "00AA00" }, size: 6, style: "single" },
      top: { color: { rgb: "00AA00" }, size: 6, style: "single" },
    });
  });
});

const createRowTable = (rowCount: number): EditorState => {
  const rows = Array.from({ length: rowCount }, (_, i) =>
    schema.node("tableRow", null, [
      schema.node("tableCell", { borders: null }, [
        schema.node("paragraph", null, [schema.text(`R${i}`)]),
      ]),
    ]),
  );
  const doc = schema.node("doc", null, [schema.node("table", null, rows)]);
  return EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, 1),
  });
};

const cellPositions = (doc: PMNode): number[] => {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "tableCell") {
      positions.push(pos);
    }
  });
  return positions;
};

const countNodes = (doc: PMNode, typeName: string): number => {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === typeName) {
      count += 1;
    }
  });
  return count;
};

const selectCells = (
  state: EditorState,
  anchorCellPos: number,
  headCellPos: number,
): EditorState =>
  state.apply(
    state.tr.setSelection(
      CellSelection.create(state.doc, anchorCellPos, headCellPos),
    ),
  );

// eigenpal/docx-editor#783 — deleting a table row must remove every row a
// CellSelection spans (not just the anchor row), and drop the whole table when
// the selection covers all rows. (Folio has no tracked table-row deletion, so
// only the plain path is ported.)
describe("deleteRow with a multi-row CellSelection (#783)", () => {
  test("deletes every row the selection spans", () => {
    let state = createRowTable(3);
    const cells = cellPositions(state.doc);
    state = selectCells(state, cells[0]!, cells[1]!); // rows 0 and 1
    state = runTableCommand(state, "deleteRow");

    expect(countNodes(state.doc, "tableRow")).toBe(1);
    expect(countNodes(state.doc, "table")).toBe(1);
  });

  test("drops the whole table when the selection covers all rows", () => {
    let state = createRowTable(2);
    const cells = cellPositions(state.doc);
    state = selectCells(state, cells[0]!, cells[1]!); // all rows
    state = runTableCommand(state, "deleteRow");

    expect(countNodes(state.doc, "table")).toBe(0);
  });

  test("replaces a sole table with an empty paragraph instead of emptying the doc", () => {
    // The doc holds only the table; deleting every row must keep a valid block
    // (an empty doc violates the `block+` schema) rather than a bare delete.
    let state = createRowTable(2);
    const cells = cellPositions(state.doc);
    state = selectCells(state, cells[0]!, cells[1]!);
    state = runTableCommand(state, "deleteRow");

    expect(countNodes(state.doc, "table")).toBe(0);
    expect(countNodes(state.doc, "paragraph")).toBe(1);
    expect(state.doc.childCount).toBe(1);
    expect(() => state.doc.check()).not.toThrow();
  });

  test("adjusts a spanning cell's rowspan when one of its rows is deleted", () => {
    // row0: [A (rowspan 2), B]   row1: [C]   row2: [D, E]
    // A spans rows 0-1; deleting row 1 must reduce A's rowspan to 1, not orphan it.
    const cell = (text: string, attrs: Record<string, unknown> = {}) =>
      schema.node("tableCell", { borders: null, ...attrs }, [
        schema.node("paragraph", null, [schema.text(text)]),
      ]);
    const doc = schema.node("doc", null, [
      schema.node("table", null, [
        schema.node("tableRow", null, [cell("A", { rowspan: 2 }), cell("B")]),
        schema.node("tableRow", null, [cell("C")]),
        schema.node("tableRow", null, [cell("D"), cell("E")]),
      ]),
    ]);
    // Caret inside C (row 1).
    let cPos = 0;
    doc.descendants((node, pos) => {
      if (cPos === 0 && node.isText && node.text === "C") {
        cPos = pos;
      }
    });
    let state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, cPos),
    });
    state = runTableCommand(state, "deleteRow");

    expect(countNodes(state.doc, "tableRow")).toBe(2);
    let spanningCell: PMNode | null = null;
    state.doc.descendants((node) => {
      if (node.type.name === "tableCell" && node.textContent === "A") {
        spanningCell = node;
      }
    });
    expect(spanningCell).not.toBeNull();
    expect((spanningCell as unknown as PMNode).attrs["rowspan"]).toBe(1);
  });
});
