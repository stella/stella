import { panic } from "better-result";
import * as v from "valibot";

const reason = v.pipe(v.string(), v.trim(), v.minLength(12));
const dimensionSchema = v.picklist([
  "requestCounts",
  "depth",
  "dbQueries",
  "transactions",
  "responseSizes",
  "renderCommits",
  "dataRenderCommits",
]);
const ROUTE_DIMENSIONS = new Set<string>([
  "depth",
  "renderCommits",
  "dataRenderCommits",
]);

export const RENDER_COMMIT_FLOOR = 8;

const rowSchema = v.strictObject({
  route: v.pipe(v.string(), v.minLength(1)),
  dimension: dimensionSchema,
  request: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.trim(), v.minLength(1)),
  reason,
  max: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type RouteScaleLedgerRow = v.InferOutput<typeof rowSchema>;
const ledgerSchema = v.array(rowSchema);

const rowId = ({ route, dimension, request }: RouteScaleLedgerRow): string =>
  JSON.stringify([route, dimension, request]);

export const parseRouteScaleLedger = (text: string): RouteScaleLedgerRow[] => {
  const rows = v.parse(ledgerSchema, JSON.parse(text));
  const ids = new Set<string>();
  for (const row of rows) {
    const id = rowId(row);
    if (ids.has(id)) {
      panic(`Duplicate route scale allowance: ${id}`);
    }
    if (ROUTE_DIMENSIONS.has(row.dimension) !== (row.request === "$route")) {
      panic(`Route-level allowances, and only they, use $route: ${id}`);
    }
    if (row.dimension === "responseSizes" && row.max <= 2) {
      panic(`Response size allowance must exceed the default factor 2: ${id}`);
    }
    if (
      (row.dimension === "renderCommits" ||
        row.dimension === "dataRenderCommits") &&
      row.max <= RENDER_COMMIT_FLOOR
    ) {
      panic(
        `Render commit allowance must exceed the floor ${String(RENDER_COMMIT_FLOOR)}: ${id}`,
      );
    }
    ids.add(id);
  }
  return rows;
};

export const routeScaleLedgerMembership = (text: string): string[] =>
  parseRouteScaleLedger(text).flatMap((row) =>
    Array.from({ length: row.max }, (_, index) => `${rowId(row)}#${index + 1}`),
  );

export const addedLedgerEntries = (
  current: readonly string[],
  base: readonly string[] | null,
): string[] => {
  if (base === null) {
    return [...current];
  }
  const known = new Set(base);
  return current.filter((entry) => !known.has(entry));
};
