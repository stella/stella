import { panic } from "better-result";
import type { Element } from "hast";
import {
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
} from "streamdown";

export type AnswerTableShape = { rows: number; columns: number };

/** The text formats a table copies or downloads as. */
export type AnswerTableTextFormat = "md" | "csv" | "tsv";

/**
 * The rendered table as text in `format`, by the markdown renderer's own
 * rules, so a copy reads exactly as the renderer's own controls would write it.
 */
export const answerTableText = (
  table: HTMLTableElement,
  format: AnswerTableTextFormat,
): string => {
  const data = extractTableDataFromElement(table);
  switch (format) {
    case "md":
      return tableDataToMarkdown(data);
    case "csv":
      return tableDataToCSV(data);
    case "tsv":
      return tableDataToTSV(data);
    default:
      format satisfies never;
      return panic("Unknown table text format");
  }
};

type TableRow = { row: Element; inHead: boolean };

const tableRows = (element: Element, inHead: boolean): TableRow[] =>
  element.children.flatMap((child) => {
    if (child.type !== "element") {
      return [];
    }
    if (child.tagName === "tr") {
      return [{ row: child, inHead }];
    }
    return tableRows(child, inHead || child.tagName === "thead");
  });

/**
 * How many body rows and columns a parsed markdown table has. The columns
 * are the header row's: GFM fixes a table's width at its delimiter row, so
 * the count holds still while body rows stream in, and rows only grow.
 */
export const answerTableShape = (
  node: Element | undefined,
): AnswerTableShape | null => {
  if (node?.tagName !== "table") {
    return null;
  }
  const rows = tableRows(node, false);
  const header = rows.find(({ inHead }) => inHead) ?? rows.at(0);
  if (header === undefined) {
    return null;
  }
  return {
    rows: rows.filter(({ row, inHead }) => !inHead && row !== header.row)
      .length,
    columns: header.row.children.filter(
      (cell) =>
        cell.type === "element" &&
        (cell.tagName === "th" || cell.tagName === "td"),
    ).length,
  };
};
