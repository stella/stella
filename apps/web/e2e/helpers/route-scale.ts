import { panic } from "better-result";
import * as v from "valibot";

import type { RouteNetworkMetrics } from "./network";
import type { RouteRenderMetrics } from "./render-census";

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
// Dimensions measured once per route rather than per request.
const ROUTE_DIMENSIONS = new Set<string>([
  "depth",
  "renderCommits",
  "dataRenderCommits",
]);

// The large world holds ten times the small world's rows (100 -> 1000), so a
// commit per row costs 900 extra commits and even a commit per ten rows 90.
// Timing alone moves far less: each released response can land in its own
// task and commit separately instead of batching with a sibling, and a
// Suspense reveal can fall on either side of React's throttle window. The
// allowance is a fixed floor plus one commit per API response of the route.
export const RENDER_COMMIT_FLOOR = 8;
export const renderCommitAllowance = (responses: number): number =>
  RENDER_COMMIT_FLOOR + responses;
const rowSchema = v.strictObject({
  route: v.pipe(v.string(), v.minLength(1)),
  dimension: dimensionSchema,
  // Depth and render commits use "$route"; every other allowance names one
  // normalized request.
  request: v.pipe(v.string(), v.minLength(1)),
  owner: v.pipe(v.string(), v.trim(), v.minLength(1)),
  reason,
  // Absolute count delta, or response byte multiplier (default: 2). Render
  // commit allowances replace the route's computed allowance.
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
  // Render commits may fall freely and grow up to the route's allowance.
  growthAllowance?: number;
};

type CompareRouteScaleOptions = {
  route: string;
  small: RouteNetworkMetrics;
  large: RouteNetworkMetrics;
  renders: { small: RouteRenderMetrics; large: RouteRenderMetrics };
  ledger: readonly RouteScaleLedgerRow[];
};

export const compareRouteScale = ({
  route,
  small,
  large,
  renders,
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
    growthAllowance,
  }: CheckScaleCostOptions) => {
    let observed = Math.abs(after - before);
    let defaultMax = 0;
    let bound = "delta";
    if (dimension === "responseSizes") {
      observed = after / Math.max(before, 1024);
      defaultMax = 2;
      bound = "factor";
    } else if (growthAllowance !== undefined) {
      observed = after - before;
      defaultMax = growthAllowance;
      bound = "growth";
    }
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
      `${route}: ${dimension} ${request}: small=${before}, large=${after}, allowed ${bound}=${allowance?.max ?? defaultMax}`,
    );
  };

  check({
    dimension: "depth",
    request: "$route",
    before: small.depth,
    after: large.depth,
  });
  for (const [world, metrics] of [
    ["small", renders.small],
    ["large", renders.large],
  ] as const) {
    // A census React never reported to counts zero commits on both sides.
    if (metrics.renderers < 1 || metrics.commits < 1) {
      problems.push(
        `${route}: ${world} render evidence missing (renderers=${String(metrics.renderers)}, commits=${String(metrics.commits)})`,
      );
    }
  }
  const growthAllowance = renderCommitAllowance(
    Math.max(
      ...[small, large].map((world) =>
        Object.values(world.requestCounts).reduce(
          (sum, count) => sum + count,
          0,
        ),
      ),
    ),
  );
  check({
    dimension: "renderCommits",
    request: "$route",
    before: renders.small.commits,
    after: renders.large.commits,
    growthAllowance,
  });
  check({
    dimension: "dataRenderCommits",
    request: "$route",
    before: renders.small.dataCommits,
    after: renders.large.dataCommits,
    growthAllowance,
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

export type RouteScaleMeasurement = {
  network: RouteNetworkMetrics;
  renders: RouteRenderMetrics;
};

/**
 * Every enrolled route must have been measured on both worlds; a route the
 * walk skipped is a failure, not a pass.
 */
export const routeScaleCensus = ({
  routes,
  small,
  large,
  ledger,
}: {
  routes: readonly string[];
  small: ReadonlyMap<string, RouteScaleMeasurement>;
  large: ReadonlyMap<string, RouteScaleMeasurement>;
  ledger: readonly RouteScaleLedgerRow[];
}): string[] =>
  routes.flatMap((route) => {
    const before = small.get(route);
    const after = large.get(route);
    if (before === undefined || after === undefined) {
      return [`Missing paired route measurement: ${route}`];
    }
    return compareRouteScale({
      route,
      small: before.network,
      large: after.network,
      renders: { small: before.renders, large: after.renders },
      ledger,
    });
  });
