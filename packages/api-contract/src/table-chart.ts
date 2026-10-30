import * as v from "valibot";

export const TABLE_CHART_LIMITS = {
  columns: 20,
  rows: 200,
  cellCharacters: 2000,
  headerCharacters: 160,
  tableBytes: 60_000,
  totalCharacters: 40_000,
  titleCharacters: 160,
  points: 500,
} as const;
export const TABLE_CHART_KINDS = ["bar", "line", "pie", "scatter"] as const;
export const TABLE_CHART_ROLES = [
  "x",
  "y",
  "series",
  "label",
  "ignore",
] as const;
export const TABLE_CHART_SORTS = ["none", "ascending", "descending"] as const;

const cellSchema = v.pipe(
  v.string(),
  v.maxLength(TABLE_CHART_LIMITS.cellCharacters),
);
export const tableChartRequestSchema = v.pipe(
  v.strictObject({
    headers: v.pipe(
      v.array(
        v.pipe(cellSchema, v.maxLength(TABLE_CHART_LIMITS.headerCharacters)),
      ),
      v.minLength(2),
      v.maxLength(TABLE_CHART_LIMITS.columns),
    ),
    rows: v.pipe(
      v.array(
        v.pipe(v.array(cellSchema), v.maxLength(TABLE_CHART_LIMITS.columns)),
      ),
      v.minLength(1),
      v.maxLength(TABLE_CHART_LIMITS.rows),
    ),
  }),
  v.check(
    ({ headers, rows }) => rows.every((row) => row.length === headers.length),
    "Table rows must match the headers",
  ),
  v.check(
    ({ headers, rows }) =>
      headers.join("").length +
        rows.reduce((total, row) => total + row.join("").length, 0) <=
      TABLE_CHART_LIMITS.totalCharacters,
    "Table exceeds the chart size limit",
  ),
  // Leave room for repeated headers, question rubrics and the model envelope.
  v.check(
    (table) =>
      new TextEncoder().encode(JSON.stringify(table)).byteLength <=
      TABLE_CHART_LIMITS.tableBytes,
    "Table exceeds the chart byte limit",
  ),
);

export const tableChartPlanSchema = v.pipe(
  v.strictObject({
    kind: v.picklist(TABLE_CHART_KINDS),
    columns: v.pipe(
      v.array(
        v.strictObject({
          index: v.pipe(
            v.number(),
            v.integer(),
            v.minValue(0),
            v.maxValue(TABLE_CHART_LIMITS.columns - 1),
          ),
          role: v.picklist(TABLE_CHART_ROLES),
        }),
      ),
      v.minLength(2),
      v.maxLength(TABLE_CHART_LIMITS.columns),
    ),
    sort: v.picklist(TABLE_CHART_SORTS),
    title: v.pipe(v.string(), v.maxLength(TABLE_CHART_LIMITS.titleCharacters)),
  }),
  v.check(
    ({ columns }) =>
      new Set(columns.map(({ index }) => index)).size === columns.length,
    "Each column needs a unique index",
  ),
  v.check(
    ({ columns }) => columns.every(({ index }) => index < columns.length),
    "Column indices must cover the table",
  ),
  v.check(
    ({ columns }) =>
      columns.filter(({ role }) => role === "x" || role === "label").length ===
        1 &&
      columns.some(({ role }) => role === "y") &&
      columns.filter(({ role }) => role === "series").length <= 1,
    "A chart needs one horizontal or label column and numeric values",
  ),
);
export const tableChartResponseSchema = v.variant("status", [
  v.strictObject({ status: v.literal("ready"), plan: tableChartPlanSchema }),
  v.strictObject({ status: v.literal("unavailable") }),
]);
export type TableChartRequest = v.InferOutput<typeof tableChartRequestSchema>;
export type TableChartPlan = v.InferOutput<typeof tableChartPlanSchema>;
export type TableChartResponse = v.InferOutput<typeof tableChartResponseSchema>;

/** Ambiguous localized numbers require a table, rather than a guessed magnitude. */
export const parseTableChartNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(trimmed)) {
    return null;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
};

/**
 * Every usable plan charts a column whose cells all parse as numbers, so a
 * table without one has no chart to offer.
 */
export const isTableChartable = (table: TableChartRequest): boolean =>
  table.headers.some((_header, index) =>
    table.rows.every((row) => parseTableChartNumber(row[index] ?? "") !== null),
  );

export const isTableChartPlanUsable = (
  plan: TableChartPlan,
  table: TableChartRequest,
): boolean => {
  if (
    !v.safeParse(tableChartPlanSchema, plan).success ||
    plan.columns.length !== table.headers.length
  ) {
    return false;
  }
  const values = plan.columns.filter(({ role }) => role === "y");
  if (table.rows.length * values.length > TABLE_CHART_LIMITS.points) {
    return false;
  }
  const horizontal = plan.columns.find(
    ({ role }) => role === "x" || role === "label",
  );
  if (
    !horizontal ||
    (plan.kind === "scatter" && horizontal.role !== "x") ||
    (plan.kind === "pie" && values.length !== 1)
  ) {
    return false;
  }
  let pieTotal = 0;
  for (const row of table.rows) {
    if (
      horizontal.role === "x" &&
      parseTableChartNumber(row[horizontal.index] ?? "") === null
    ) {
      return false;
    }
    for (const { index } of values) {
      const value = parseTableChartNumber(row[index] ?? "");
      if (value === null || (plan.kind === "pie" && value < 0)) {
        return false;
      }
      if (plan.kind === "pie") {
        pieTotal += value;
      }
    }
  }
  return plan.kind !== "pie" || (Number.isFinite(pieTotal) && pieTotal > 0);
};
