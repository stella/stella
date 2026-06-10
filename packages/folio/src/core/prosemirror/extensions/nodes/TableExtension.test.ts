import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

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

describe("table border presets", () => {
  const firstTable = (doc: PMNode) => {
    const table = { value: null as PMNode | null };
    doc.descendants((node) => {
      if (table.value !== null || node.type.name !== "table") {
        return;
      }
      table.value = node;
      return false;
    });

    if (table.value === null) {
      throw new Error("Expected table");
    }

    return table.value;
  };

  const allCells = (doc: PMNode) => {
    const cells: PMNode[] = [];
    doc.descendants((node) => {
      if (node.type.name === "tableCell") {
        cells.push(node);
      }
      return true;
    });
    return cells;
  };

  const wordDefaultBorder = {
    style: "single",
    size: 4,
    space: 0,
    color: { auto: true },
  };

  test("'all' sets w:tblBorders on the table and bakes every cell", () => {
    const state = runTableCommand(
      createTableStateWithNullBorders(),
      "setTableBorderPreset",
      "all",
    );

    expect(firstTable(state.doc).attrs["borders"]).toEqual({
      top: wordDefaultBorder,
      bottom: wordDefaultBorder,
      left: wordDefaultBorder,
      right: wordDefaultBorder,
      insideH: wordDefaultBorder,
      insideV: wordDefaultBorder,
    });

    const cells = allCells(state.doc);
    expect(cells.length).toBe(2);
    for (const cell of cells) {
      expect(cell.attrs["borders"]).toEqual({
        top: wordDefaultBorder,
        bottom: wordDefaultBorder,
        left: wordDefaultBorder,
        right: wordDefaultBorder,
      });
    }
  });

  test("'none' replaces existing borders with explicit none on all sides", () => {
    const withBorders = runTableCommand(
      createTableStateWithNullBorders(),
      "setTableBorderPreset",
      "all",
    );
    const state = runTableCommand(withBorders, "setTableBorderPreset", "none");

    const none = { style: "none" };
    expect(firstTable(state.doc).attrs["borders"]).toEqual({
      top: none,
      bottom: none,
      left: none,
      right: none,
      insideH: none,
      insideV: none,
    });
    for (const cell of allCells(state.doc)) {
      expect(cell.attrs["borders"]).toEqual({
        top: none,
        bottom: none,
        left: none,
        right: none,
      });
    }
  });
});
