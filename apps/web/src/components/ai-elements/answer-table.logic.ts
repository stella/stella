import { panic } from "better-result";
import type { Element } from "hast";
import {
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
} from "streamdown";

export type AnswerTableShape = { rows: number; columns: number };

/** Which edges of a scrolled table have more of it past them. */
export type AnswerTableEdges = {
  above: boolean;
  below: boolean;
  start: boolean;
  end: boolean;
};

type ScrollBox = Pick<
  HTMLElement,
  | "clientHeight"
  | "clientWidth"
  | "scrollHeight"
  | "scrollLeft"
  | "scrollTop"
  | "scrollWidth"
>;

/** Sub-pixel layout leaves this much slack at an edge that is reached. */
const EDGE_SLACK_PX = 1;

/**
 * Where a table's scroller can still go. Sideways it reads inline start and
 * end: a right-to-left scroller runs from 0 at its start to a negative
 * `scrollLeft`, so the distance from the start is the same either way.
 */
export const answerTableEdges = (box: ScrollBox): AnswerTableEdges => {
  const fromStart = Math.abs(box.scrollLeft);
  return {
    above: box.scrollTop > EDGE_SLACK_PX,
    below: box.scrollHeight - box.clientHeight - box.scrollTop > EDGE_SLACK_PX,
    start: fromStart > EDGE_SLACK_PX,
    end: box.scrollWidth - box.clientWidth - fromStart > EDGE_SLACK_PX,
  };
};

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
