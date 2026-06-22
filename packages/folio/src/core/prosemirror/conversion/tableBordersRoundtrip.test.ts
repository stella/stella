/**
 * Round-trip coverage for table-level borders (w:tblBorders).
 *
 * - Inline tblBorders parsed from DOCX must survive toProseDoc → fromProseDoc
 *   unchanged, including explicit "none" entries that negate style borders.
 * - The whole-table border presets ("All borders" / "No borders") must update
 *   the table model so serialization writes the full w:tblBorders.
 */
import { describe, expect, test } from "bun:test";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";

import { serializeTable } from "../../docx/serializer/tableSerializer";
import type { Document, Table, TableBorders } from "../../types/document";
import { schema, singletonManager } from "../schema";
import { fromProseDoc } from "./fromProseDoc";
import { toProseDoc } from "./toProseDoc";

const singleBorder = {
  style: "single",
  size: 8,
  space: 0,
  color: { rgb: "FF0000" },
};

const makeDocumentWithTableBorders = (borders: TableBorders): Document => ({
  package: {
    document: {
      content: [
        {
          type: "table",
          formatting: { borders },
          rows: [
            {
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
              ],
            },
          ],
        },
      ],
    },
  },
});

const expectFirstTable = (document: Document): Table => {
  const table = document.package.document.content.at(0);
  expect(table?.type).toBe("table");
  if (table?.type !== "table") {
    throw new Error("Expected table");
  }
  return table;
};

const stateWithCursorInFirstCell = (pmDoc: PMNode): EditorState => {
  const cursorPos = { value: null as number | null };
  pmDoc.descendants((node, pos) => {
    if (cursorPos.value !== null || node.type.name !== "tableCell") {
      return cursorPos.value === null;
    }
    cursorPos.value = pos + 2;
    return false;
  });

  if (cursorPos.value === null) {
    throw new Error("Expected a table cell position");
  }

  return EditorState.create({
    doc: pmDoc,
    schema,
    selection: TextSelection.create(pmDoc, cursorPos.value),
  });
};

const applyTableBorderPreset = (
  state: EditorState,
  preset: "all" | "none",
): EditorState => {
  const commandFactory = singletonManager.getCommand("setTableBorderPreset");
  if (!commandFactory) {
    throw new Error("Missing command: setTableBorderPreset");
  }

  let nextState = state;
  const handled = commandFactory(preset)(state, (tr: Transaction) => {
    nextState = state.apply(tr);
  });
  expect(handled).toBe(true);
  return nextState;
};

describe("w:tblBorders round-trip", () => {
  test("inline table borders survive toProseDoc → fromProseDoc unchanged", () => {
    const borders: TableBorders = {
      top: singleBorder,
      bottom: singleBorder,
      left: { style: "dashed", size: 4, color: { auto: true } },
      right: { style: "dashed", size: 4, color: { auto: true } },
      insideH: { style: "none" },
      insideV: { style: "nil" },
    };
    const document = makeDocumentWithTableBorders(borders);

    const roundTripped = fromProseDoc(toProseDoc(document), document);

    expect(expectFirstTable(roundTripped).formatting?.borders).toEqual(borders);
  });

  test("explicit none borders are serialized so style borders stay negated", () => {
    const borders: TableBorders = {
      top: { style: "none" },
      bottom: { style: "none" },
      left: { style: "none" },
      right: { style: "none" },
      insideH: { style: "none" },
      insideV: { style: "none" },
    };
    const document = makeDocumentWithTableBorders(borders);
    const roundTripped = fromProseDoc(toProseDoc(document), document);

    const xml = serializeTable(expectFirstTable(roundTripped));
    expect(xml).toContain(
      '<w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>',
    );
  });

  test("'all' preset overrides loaded borders and serializes Word's default spec", () => {
    const document = makeDocumentWithTableBorders({
      top: { style: "none" },
      bottom: { style: "none" },
    });
    const pmDoc = toProseDoc(document);
    const state = applyTableBorderPreset(
      stateWithCursorInFirstCell(pmDoc),
      "all",
    );

    const roundTripped = fromProseDoc(state.doc, document);
    const table = expectFirstTable(roundTripped);

    const wordDefault = {
      style: "single",
      size: 4,
      space: 0,
      color: { auto: true },
    };
    expect(table.formatting?.borders).toEqual({
      top: wordDefault,
      bottom: wordDefault,
      left: wordDefault,
      right: wordDefault,
      insideH: wordDefault,
      insideV: wordDefault,
    });

    const xml = serializeTable(table);
    expect(xml).toContain(
      '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>',
    );
    expect(xml).toContain(
      '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>',
    );
  });

  test("'none' preset overrides loaded borders with explicit none entries", () => {
    const document = makeDocumentWithTableBorders({
      top: singleBorder,
      bottom: singleBorder,
      left: singleBorder,
      right: singleBorder,
      insideH: singleBorder,
      insideV: singleBorder,
    });
    const pmDoc = toProseDoc(document);
    const state = applyTableBorderPreset(
      stateWithCursorInFirstCell(pmDoc),
      "none",
    );

    const roundTripped = fromProseDoc(state.doc, document);
    const table = expectFirstTable(roundTripped);

    const none = { style: "none" };
    expect(table.formatting?.borders).toEqual({
      top: none,
      bottom: none,
      left: none,
      right: none,
      insideH: none,
      insideV: none,
    });

    const xml = serializeTable(table);
    expect(xml).toContain(
      '<w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>',
    );
    // Cells carry matching explicit tcBorders so the override also wins
    // against any per-cell borders the document had before.
    expect(xml).toContain(
      '<w:tcBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/></w:tcBorders>',
    );
  });
});
