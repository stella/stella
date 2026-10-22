import { panic } from "better-result";
import * as v from "valibot";

import type { RouteNetworkMetrics } from "./network";

const reason = v.pipe(v.string(), v.trim(), v.minLength(12));
const dimensionSchema = v.picklist([
  "requestCounts",
  "depth",
  "dbQueries",
  "transactions",
  "responseSizes",
]);
const rowSchema = v.strictObject({
  route: v.pipe(v.string(), v.minLength(1)),
  dimension: dimensionSchema,
  // Depth uses "$route"; every other allowance names one normalized request.
  request: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.trim(), v.minLength(1)),
  reason,
  // Absolute count delta, or response byte multiplier (default: 2).
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
    if ((row.dimension === "depth") !== (row.request === "$route")) {
      panic(`Depth allowances must use $route: ${id}`);
    }
    if (row.dimension === "responseSizes" && row.max <= 2) {
      panic(`Response size allowance must exceed the default factor 2: ${id}`);
    }
    ids.add(id);
  }
  return rows;
};

// One member per budget unit: increasing an existing max adds members too.
export const routeScaleLedgerMembership = (text: string): string[] =>
  parseRouteScaleLedger(text).flatMap((row) =>
    Array.from({ length: row.max }, (_, index) => `${rowId(row)}#${index + 1}`),
  );

type CheckScaleCostOptions = {
  dimension: RouteScaleLedgerRow["dimension"];
  request: string;
  before: number;
  after: number;
};

type CompareRouteScaleOptions = {
  route: string;
  small: RouteNetworkMetrics;
  large: RouteNetworkMetrics;
  ledger: readonly RouteScaleLedgerRow[];
};

export const compareRouteScale = ({
  route,
  small,
  large,
  ledger,
}: CompareRouteScaleOptions): string[] => {
  const problems: string[] = [];
  const allowances = ledger.filter((row) => row.route === route);
  const used = new Set<RouteScaleLedgerRow>();
  const check = ({
    dimension,
    request,
    before,
    after,
  }: CheckScaleCostOptions) => {
    const observed =
      dimension === "responseSizes"
        ? after / Math.max(before, 1024)
        : Math.abs(after - before);
    const defaultMax = dimension === "responseSizes" ? 2 : 0;
    if (observed <= defaultMax) {
      return;
    }
    const allowance = allowances.find(
      (row) => row.dimension === dimension && row.request === request,
    );
    if (allowance !== undefined) {
      used.add(allowance);
      if (observed <= allowance.max) {
        return;
      }
    }
    problems.push(
      `${route}: ${dimension} ${request}: small=${before}, large=${after}, allowed ${dimension === "responseSizes" ? "factor" : "delta"}=${allowance?.max ?? defaultMax}`,
    );
  };

  check({
    dimension: "depth",
    request: "$route",
    before: small.depth,
    after: large.depth,
  });
  const requests = new Set([...small.requests, ...large.requests]);
  for (const request of requests) {
    check({
      dimension: "requestCounts",
      request,
      before: small.requestCounts[request] ?? 0,
      after: large.requestCounts[request] ?? 0,
    });
    for (const [world, metrics] of [
      ["small", small],
      ["large", large],
    ] as const) {
      if (!metrics.requests.includes(request)) {
        continue;
      }
      for (const [dimension, missing] of [
        ["dbQueries", metrics.missingDbQueryCounts],
        ["transactions", metrics.missingTransactionCounts],
        ["responseSizes", metrics.missingResponseSizeCounts],
      ] as const) {
        if ((missing[request] ?? 0) > 0) {
          problems.push(
            `${route}: ${world} ${dimension} evidence missing for ${request}`,
          );
        }
      }
      for (const dimension of [
        "requestCounts",
        "dbQueries",
        "transactions",
      ] as const) {
        if (metrics[dimension][request] === undefined) {
          problems.push(
            `${route}: ${world} ${dimension} evidence absent for ${request}`,
          );
        }
      }
    }
    for (const dimension of [
      "dbQueries",
      "transactions",
      "responseSizes",
    ] as const) {
      const before = small[dimension][request];
      const after = large[dimension][request];
      if (before !== undefined && after !== undefined) {
        check({ dimension, request, before, after });
      } else if (
        dimension === "responseSizes" &&
        (before !== undefined || after !== undefined)
      ) {
        problems.push(
          `${route}: responseSizes evidence differs for ${request}`,
        );
      }
    }
    const smallCosts = small.requestCosts[request] ?? [];
    const largeCosts = large.requestCosts[request] ?? [];
    for (const [world, metrics, costs] of [
      ["small", small, smallCosts],
      ["large", large, largeCosts],
    ] as const) {
      if (
        costs.some(
          ({ dbQueries, transactions }) =>
            dbQueries === null || transactions === null,
        )
      ) {
        problems.push(
          `${route}: ${world} request count evidence incomplete for ${request}`,
        );
      }
      if (costs.length !== (metrics.requestCounts[request] ?? 0)) {
        problems.push(
          `${route}: ${world} request cost evidence incomplete for ${request}`,
        );
      }
    }
    // Normalized keys may represent several ids. Compare every request's cost,
    // so an unchanged maximum cannot hide growth in a cheaper sibling request.
    for (const [dimension, field] of [
      ["dbQueries", "dbQueries"],
      ["transactions", "transactions"],
      ["responseSizes", "responseBytes"],
    ] as const) {
      const before = smallCosts
        .map((cost) => cost[field])
        .filter((value) => value !== null)
        .toSorted((a, b) => a - b);
      const after = largeCosts
        .map((cost) => cost[field])
        .filter((value) => value !== null)
        .toSorted((a, b) => a - b);
      if (before.length !== after.length) {
        problems.push(
          `${route}: ${dimension} sample evidence differs for ${request}`,
        );
      }
      for (const [index, value] of before.entries()) {
        const next = after.at(index);
        if (next !== undefined) {
          check({ dimension, request, before: value, after: next });
        }
      }
    }
  }
  for (const allowance of allowances) {
    if (!used.has(allowance)) {
      problems.push(
        `${route}: stale scale allowance ${allowance.dimension} ${allowance.request} (${allowance.owner}); remove it`,
      );
    }
  }
  return problems;
};
