import type { Cell, Styles } from "@silurus/ooxml/xlsx";
import { describe, expect, test } from "bun:test";

import {
  buildSpreadsheetCellText,
  toSpreadsheetCellReference,
} from "@/api/lib/files/office-evidence-xlsx";

const styles = {
  borders: [],
  cellXfs: [
    {
      alignH: null,
      alignV: null,
      borderId: 0,
      fillId: 0,
      fontId: 0,
      numFmtId: 9,
      wrapText: false,
    },
  ],
  dxfs: [],
  fills: [],
  fonts: [],
  numFmts: [],
} satisfies Styles;

describe("Office spreadsheet evidence", () => {
  test("uses one-based worksheet coordinates", () => {
    expect(toSpreadsheetCellReference({ col: 1, row: 1 })).toBe("A1");
    expect(toSpreadsheetCellReference({ col: 27, row: 3 })).toBe("AA3");
  });

  test("matches the formatted value shown by the spreadsheet viewer", () => {
    const cell = {
      col: 2,
      formula: "B1/4",
      row: 2,
      styleIndex: 0,
      value: { number: 0.25, type: "number" },
    } as const satisfies Cell;

    expect(
      buildSpreadsheetCellText({
        cell,
        date1904: false,
        sharedStrings: [],
        styles,
      }),
    ).toBe("B2: =B1/4 → 25%");
  });

  test("rejects a missing shared-string reference", () => {
    const cell = {
      col: 1,
      row: 1,
      value: { si: 4, type: "shared" },
    } as const satisfies Cell;

    expect(() =>
      buildSpreadsheetCellText({
        cell,
        date1904: false,
        sharedStrings: [],
        styles,
      }),
    ).toThrow("Spreadsheet cell references a missing shared string");
  });
});
