import { panic } from "better-result";
import type { Element, ElementContent } from "hast";
import * as v from "valibot";

import {
  isTableChartPlanUsable,
  parseTableChartNumber,
  type TableChartPlan,
  type TableChartRequest,
  tableChartRequestSchema,
} from "@stll/api-contract/table-chart";
import type { TableChartPoint } from "@stll/ui/table-chart";

const cellText = (node: ElementContent): string => {
  switch (node.type) {
    case "text":
      return node.value;
    case "element":
      if (node.tagName === "br") {
        return "\n";
      }
      if (node.tagName === "img") {
        return node.properties.alt ?? "";
      }
      return node.children.map(cellText).join("");
    case "comment":
    case "raw":
      return "";
    default:
      node satisfies never;
      return panic("Unexpected parsed table node");
  }
};

/** Read parsed text, preserving inline formatting and excluding markup syntax. */
export const chartTableFromNode = (
  node: Element | undefined,
): TableChartRequest | null => {
  if (!node || node.tagName !== "table") {
    return null;
  }
  const rows: string[][] = [];
  const visit = (element: Element) => {
    if (element.tagName === "tr") {
      rows.push(
        element.children.flatMap((child) =>
          child.type === "element" &&
          (child.tagName === "th" || child.tagName === "td")
            ? [child.children.map(cellText).join("").trim()]
            : [],
        ),
      );
      return;
    }
    for (const child of element.children) {
      if (child.type === "element") {
        visit(child);
      }
    }
  };
  visit(node);
  const parsed = v.safeParse(tableChartRequestSchema, {
    headers: rows.at(0),
    rows: rows.slice(1),
  });
  return parsed.success ? parsed.output : null;
};

type TableChartPointsOptions = {
  table: TableChartRequest;
  plan: TableChartPlan;
  locale: string;
};

export const tableChartPoints = ({
  table,
  plan,
  locale,
}: TableChartPointsOptions): TableChartPoint[] => {
  if (!isTableChartPlanUsable(plan, table)) {
    return [];
  }
  const horizontal = plan.columns.find(
    ({ role }) => role === "x" || role === "label",
  );
  if (!horizontal) {
    return [];
  }
  const series = plan.columns.find(({ role }) => role === "series");
  const values = plan.columns.filter(({ role }) => role === "y");
  const points: TableChartPoint[] = [];
  const categoryPositions = new Map<string, number>();
  const collator = new Intl.Collator(locale, { numeric: true });
  const direction = plan.sort === "descending" ? -1 : 1;
  const rows =
    plan.sort === "none"
      ? table.rows
      : table.rows.toSorted((a, b) => {
          const first = a.at(horizontal.index) ?? "";
          const second = b.at(horizontal.index) ?? "";
          const numericFirst = parseTableChartNumber(first);
          const numericSecond = parseTableChartNumber(second);
          return (
            direction *
            (horizontal.role === "x" &&
            numericFirst !== null &&
            numericSecond !== null
              ? numericFirst - numericSecond
              : collator.compare(first, second))
          );
        });
  for (const row of rows) {
    const label = row.at(horizontal.index) ?? "";
    let categoryX = categoryPositions.get(label);
    if (categoryX === undefined) {
      categoryX = categoryPositions.size;
      categoryPositions.set(label, categoryX);
    }
    for (const column of values) {
      const y = parseTableChartNumber(row.at(column.index) ?? "");
      if (y === null) {
        return panic("Validated chart value must be numeric");
      }
      const x = horizontal.role === "x" ? parseTableChartNumber(label) : null;
      const seriesLabel = series ? row.at(series.index) : undefined;
      const valueLabel = table.headers.at(column.index) ?? "";
      points.push({
        label,
        x:
          horizontal.role === "x"
            ? (x ?? panic("Validated chart coordinate must be numeric"))
            : categoryX,
        y,
        ...(seriesLabel || values.length > 1
          ? {
              series: [seriesLabel, values.length > 1 ? valueLabel : undefined]
                .filter(Boolean)
                .join(" / "),
            }
          : {}),
      });
    }
  }
  return points;
};
