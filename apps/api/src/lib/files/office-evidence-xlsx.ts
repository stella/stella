import type { Cell, SharedString, Styles } from "@silurus/ooxml/xlsx";
import { panic, TaggedError } from "better-result";
import * as SSF from "ssf";

class OfficeEvidenceXlsxError extends TaggedError("OfficeEvidenceXlsxError")<{
  message: string;
}> {}

const toSpreadsheetColumnName = (columnIndex: number): string => {
  if (!Number.isSafeInteger(columnIndex) || columnIndex < 1) {
    throw new OfficeEvidenceXlsxError({
      message: "Spreadsheet cell has an invalid column index",
    });
  }
  let current = columnIndex;
  let name = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCodePoint(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
};

export const toSpreadsheetCellReference = (
  cell: Pick<Cell, "col" | "row">,
): string => {
  if (!Number.isSafeInteger(cell.row) || cell.row < 1) {
    throw new OfficeEvidenceXlsxError({
      message: "Spreadsheet cell has an invalid row index",
    });
  }
  return `${toSpreadsheetColumnName(cell.col)}${String(cell.row)}`;
};

const formatNumericCell = ({
  date1904,
  number,
  styleIndex = 0,
  styles,
}: {
  date1904: boolean;
  number: number;
  styleIndex: number | undefined;
  styles: Styles;
}): string => {
  const cellXf = styleIndex >= 0 ? styles.cellXfs.at(styleIndex) : undefined;
  const numFmtId = cellXf?.numFmtId ?? 0;
  const customFormat = styles.numFmts.find(
    (candidate) => candidate.numFmtId === numFmtId,
  );
  return SSF.format(customFormat?.formatCode ?? numFmtId, number, {
    date1904,
  });
};

const cellValueText = (
  cell: Cell,
  sharedStrings: readonly SharedString[],
  styles: Styles,
  date1904: boolean,
): string => {
  switch (cell.value.type) {
    case "bool":
      return cell.value.bool ? "TRUE" : "FALSE";
    case "empty":
      return "";
    case "error":
      return cell.value.error;
    case "number":
      return formatNumericCell({
        date1904,
        number: cell.value.number,
        styleIndex: cell.styleIndex,
        styles,
      });
    case "shared": {
      const shared =
        cell.value.si >= 0 ? sharedStrings.at(cell.value.si) : undefined;
      if (!shared) {
        throw new OfficeEvidenceXlsxError({
          message: "Spreadsheet cell references a missing shared string",
        });
      }
      return shared.text;
    }
    case "text":
      return cell.value.text;
    default: {
      cell.value satisfies never;
      return panic(`Unhandled value: ${String(cell.value)}`);
    }
  }
};

const normalizeText = (value: string): string =>
  value.replace(/\s+/gu, " ").trim();

export const buildSpreadsheetCellText = ({
  cell,
  date1904,
  sharedStrings,
  styles,
}: {
  cell: Cell;
  date1904: boolean;
  sharedStrings: readonly SharedString[];
  styles: Styles;
}): string => {
  const reference = toSpreadsheetCellReference(cell);
  const value = normalizeText(
    cellValueText(cell, sharedStrings, styles, date1904),
  );
  if (cell.formula) {
    const formula = cell.formula.startsWith("=")
      ? cell.formula
      : `=${cell.formula}`;
    return value
      ? `${reference}: ${formula} → ${value}`
      : `${reference}: ${formula}`;
  }
  return value ? `${reference}: ${value}` : "";
};
