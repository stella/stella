import { expect } from "@playwright/test";
import type { Page, Request, Response } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Matches apps/web/e2e/playwright.config.ts and helpers/api.ts: the API origin
// the frontend talks to. Only requests to this origin are guarded; everything
// else (the web host, presigned S3 uploads) is noise for a route-shape budget.
const DEFAULT_API_URL = process.env["E2E_API_URL"] ?? "http://localhost:3001";

// eventsource is included on purpose: an SSE stream (chat, live updates) is a
// real API round the route opens, so a route that starts streaming counts as a
// request in the manifest. Excluding it would blind the guard to that call.
const TRACKED_RESOURCE_TYPES = new Set(["fetch", "xhr", "eventsource"]);

// Dev/test-only per-request Drizzle query counter emitted by the API
// (apps/api/src/lib/db-query-counter.ts). Folding it into the baseline makes
// an N+1 regression fail per route+endpoint, not just per HTTP fan-out.
const DB_QUERIES_HEADER = "x-db-queries";

const BASELINE_PATH = path.resolve(
  import.meta.dirname,
  "../network-baseline.json",
);
// Spelled out for error messages so a failing CI run points at the file to edit
// regardless of the cwd the suite ran from.
const BASELINE_RELATIVE = "apps/web/e2e/network-baseline.json";
const WRITE_HINT =
  "run the route-smoke suite with E2E_NETWORK_BASELINE=write and commit the baseline";

// --- collector -------------------------------------------------------------

export type NetworkCapture = {
  requests: {
    method: string;
    pathname: string;
    dbQueries: number | null;
    dbQueryHeaderMissing: boolean;
  }[];
  intervals: { start: number; end: number }[];
};

export type NetworkCollector = {
  trackPage: (page: Page) => () => void;
  capture: () => NetworkCapture;
};

type NetworkCollectorOptions = {
  apiOrigin?: string;
};

type NetworkRecord = {
  method: string;
  pathname: string;
  start: number;
  end: number | null;
  // From the API's dev/test-only `x-db-queries` response header (the
  // per-request Drizzle query counter); null when no response arrived.
  dbQueries: number | null;
  // True only when Playwright saw a response and that response did not expose
  // the dev/test query-count header.
  dbQueryHeaderMissing: boolean;
};

const isTrackedApiRequest = (request: Request, apiOrigin: string): boolean => {
  if (!TRACKED_RESOURCE_TYPES.has(request.resourceType())) {
    return false;
  }
  return new URL(request.url()).origin === apiOrigin;
};

export const createNetworkCollector = (
  options: NetworkCollectorOptions = {},
): NetworkCollector => {
  const apiOrigin = options.apiOrigin ?? new URL(DEFAULT_API_URL).origin;
  const records: NetworkRecord[] = [];
  const byRequest = new Map<Request, NetworkRecord>();

  return {
    trackPage: (page) => {
      const onRequest = (request: Request) => {
        if (!isTrackedApiRequest(request, apiOrigin)) {
          return;
        }
        const record: NetworkRecord = {
          method: request.method(),
          pathname: new URL(request.url()).pathname,
          start: Date.now(),
          end: null,
          dbQueries: null,
          dbQueryHeaderMissing: false,
        };
        records.push(record);
        byRequest.set(request, record);
      };

      const onSettled = (request: Request) => {
        const record = byRequest.get(request);
        if (record) {
          record.end = Date.now();
        }
      };

      const onResponse = (response: Response) => {
        const record = byRequest.get(response.request());
        if (!record) {
          return;
        }
        const header = response.headers()[DB_QUERIES_HEADER];
        if (header !== undefined) {
          record.dbQueries = Number(header);
          return;
        }
        record.dbQueryHeaderMissing = true;
      };

      page.on("request", onRequest);
      page.on("response", onResponse);
      page.on("requestfinished", onSettled);
      page.on("requestfailed", onSettled);

      return () => {
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfinished", onSettled);
        page.off("requestfailed", onSettled);
      };
    },

    capture: () => {
      // A still-pending request can only be the tail of a chain (nothing waited
      // on its response yet), so closing it at "now" never inflates the depth.
      const now = Date.now();
      return {
        requests: records.map(
          ({ method, pathname, dbQueries, dbQueryHeaderMissing }) => ({
            method,
            pathname,
            dbQueries,
            dbQueryHeaderMissing,
          }),
        ),
        intervals: records.map(({ start, end }) => ({
          start,
          end: end ?? now,
        })),
      };
    },
  };
};

// --- pure metrics ----------------------------------------------------------

const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const normalizeApiPath = (pathname: string): string =>
  pathname
    .split("/")
    .map((segment) => (UUID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");

export const requestKey = ({
  method,
  pathname,
}: {
  method: string;
  pathname: string;
}): string => `${method} ${normalizeApiPath(pathname)}`;

// A dependency edge exists only when the next request starts PROMPTLY after
// the previous response: real render-fetch waterfalls dispatch the next call
// within milliseconds of the response that unblocked them. Without this cap,
// an independent idle prefetch firing a second later would coincidentally
// "chain" after whatever happened to finish before it, making the depth vary
// with machine load instead of app structure.
const CHAIN_GAP_MS = 500;

// Longest chain r1..rn where each next request starts after the previous one
// ended, within CHAIN_GAP_MS: the number of causally sequential request
// rounds, i.e. how many times the browser had to wait for a response before
// it could fire the next call. Sorted by start with an O(n^2) longest-chain
// DP; n is a handful of requests per route.
export const waterfallDepth = (
  intervals: { start: number; end: number }[],
): number => {
  const sorted = intervals
    .map((interval) => ({ ...interval, depth: 1 }))
    .sort((a, b) => a.start - b.start);

  let best = 0;
  for (const [index, current] of sorted.entries()) {
    for (let prevIndex = 0; prevIndex < index; prevIndex++) {
      const prev = sorted[prevIndex];
      if (
        prev !== undefined &&
        current.start >= prev.end &&
        current.start - prev.end <= CHAIN_GAP_MS
      ) {
        current.depth = Math.max(current.depth, prev.depth + 1);
      }
    }
    best = Math.max(best, current.depth);
  }
  return best;
};

// --- baseline machinery ----------------------------------------------------

export type RouteNetworkMetrics = {
  // Observed request keys, unique + sorted.
  requests: string[];
  // Per request key, how many times it was observed.
  requestCounts: Record<string, number>;
  // Depth over ALL observed intervals, including duplicate keys.
  depth: number;
  // Per request key, the max `x-db-queries` observed this run. Keys whose
  // responses carried no header (auth-mounted endpoints, dropped responses)
  // are absent.
  dbQueries: Record<string, number>;
  // Per request key, how many completed responses omitted `x-db-queries`.
  missingDbQueryCounts: Record<string, number>;
};

export type NetworkBaselineEntry = {
  depth: number;
  requests: string[];
  // Optional so baselines written before request multiplicity existed still parse.
  requestCounts?: Record<string, number>;
  // Optional so baselines written before the counter existed still parse.
  dbQueries?: Record<string, number>;
};

export type NetworkBaseline = Record<string, NetworkBaselineEntry>;

export const summarizeCapture = (
  capture: NetworkCapture,
): RouteNetworkMetrics => {
  const dbQueries: Record<string, number> = {};
  const missingDbQueryCounts: Record<string, number> = {};
  const requestCounts: Record<string, number> = {};
  for (const request of capture.requests) {
    const key = requestKey(request);
    requestCounts[key] = (requestCounts[key] ?? 0) + 1;
    if (request.dbQueryHeaderMissing) {
      missingDbQueryCounts[key] = (missingDbQueryCounts[key] ?? 0) + 1;
    }
    if (request.dbQueries === null || Number.isNaN(request.dbQueries)) {
      continue;
    }
    dbQueries[key] = Math.max(dbQueries[key] ?? 0, request.dbQueries);
  }
  return {
    requests: Object.keys(requestCounts).sort(),
    requestCounts: Object.fromEntries(
      Object.entries(requestCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    depth: waterfallDepth(capture.intervals),
    dbQueries,
    missingDbQueryCounts: Object.fromEntries(
      Object.entries(missingDbQueryCounts).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };
};

export type NetworkBaselineDiff = {
  problems: string[];
  notices: string[];
};

const pushNewRequestProblems = ({
  route,
  entry,
  metrics,
  problems,
}: {
  route: string;
  entry: NetworkBaselineEntry;
  metrics: RouteNetworkMetrics;
  problems: string[];
}) => {
  const baselineKeys = new Set(entry.requests);
  const added = metrics.requests.filter((key) => !baselineKeys.has(key));
  if (added.length === 0) {
    return;
  }
  problems.push(
    `New API request(s) on ${route}:\n${added
      .map((key) => `    ${key}`)
      .join(
        "\n",
      )}\n  This route now calls an endpoint it did not before. If that is\n` +
      `  intentional, ${WRITE_HINT}.`,
  );
};

// Under load, independent PARALLEL requests can serialize just enough to land
// inside CHAIN_GAP_MS and bump the measured depth by one with no change to
// the request manifest (a quiet CI runner rarely reproduces this; a busy dev
// machine does). Mirrors dbQueryAllowance's role: tolerate one level of
// measurement jitter before treating a depth increase as a real regression.
const DEPTH_JITTER_ALLOWANCE = 1;

const pushWaterfallDepthProblems = ({
  route,
  entry,
  metrics,
  problems,
}: {
  route: string;
  entry: NetworkBaselineEntry;
  metrics: RouteNetworkMetrics;
  problems: string[];
}) => {
  if (metrics.depth <= entry.depth + DEPTH_JITTER_ALLOWANCE) {
    return;
  }
  problems.push(
    `Request waterfall got deeper on ${route}: ${entry.depth} -> ${metrics.depth} (already tolerating +${DEPTH_JITTER_ALLOWANCE} for parallel-request jitter)\n` +
      `  Each extra level is one more sequential network round the user waits\n` +
      `  through before the page can finish. Usually the fix is to start the\n` +
      `  query in the route loader (ensureRouteQueryData / prefetchRouteQuery in\n` +
      `  apps/web/src/lib/react-query.ts) or lift it so it fires in parallel\n` +
      `  instead of after another request resolves. If the extra round is\n` +
      `  genuinely required, ${WRITE_HINT}.`,
  );
};

const pushRequestCountProblems = ({
  route,
  entry,
  metrics,
  problems,
}: {
  route: string;
  entry: NetworkBaselineEntry;
  metrics: RouteNetworkMetrics;
  problems: string[];
}) => {
  const baselineRequestCounts = requestCountBudget(entry);
  for (const [key, observed] of Object.entries(metrics.requestCounts)) {
    const budget = baselineRequestCounts[key];
    if (budget === undefined || observed <= budget) {
      continue;
    }
    problems.push(
      `API request repeated on ${route}: ${key} ran ${budget} -> ${observed} times\n` +
        `  Duplicate route requests usually come from duplicate mounts,\n` +
        `  normalized UUID fan-out, or a cache key/refetch policy that lets\n` +
        `  the same endpoint fire twice. Reuse the in-flight query or, if\n` +
        `  the duplicate is genuinely required, ${WRITE_HINT}.`,
    );
  }
};

const pushDbQueryProblems = ({
  route,
  entry,
  metrics,
  problems,
}: {
  route: string;
  entry: NetworkBaselineEntry;
  metrics: RouteNetworkMetrics;
  problems: string[];
}) => {
  const baselineDb = entry.dbQueries ?? {};
  for (const key of Object.keys(baselineDb)) {
    if (metrics.missingDbQueryCounts[key] === undefined) {
      continue;
    }
    problems.push(
      `DB query count missing on ${route}: ${key}\n` +
        `  This request has a committed DB-query budget, but the response did\n` +
        `  not expose the x-db-queries header. Restore the dev/test query\n` +
        `  counter before trusting this route's N+1 budget.`,
    );
  }
  for (const [key, observed] of Object.entries(metrics.dbQueries)) {
    const budget = baselineDb[key];
    if (budget === undefined || observed <= dbQueryAllowance(budget)) {
      continue;
    }
    problems.push(
      `DB queries per request grew on ${route}: ${key} ran ${budget} -> ${observed} queries\n` +
        `  The endpoint now issues more SQL for the same page — the classic\n` +
        `  cause is an N+1 (a per-row query inside a loop or a lazy relation\n` +
        `  loaded per item). Batch it (joins, IN lists, relation preloading)\n` +
        `  or, if the extra queries are genuinely required, ${WRITE_HINT}.`,
    );
  }
};

const pushImprovementNotices = ({
  route,
  entry,
  metrics,
  notices,
}: {
  route: string;
  entry: NetworkBaselineEntry;
  metrics: RouteNetworkMetrics;
  notices: string[];
}) => {
  const observedKeys = new Set(metrics.requests);
  const missing = entry.requests.filter((key) => !observedKeys.has(key));
  if (missing.length > 0) {
    notices.push(
      `Baseline request(s) not observed on ${route} (late/conditional, not a failure):\n${missing
        .map((key) => `    ${key}`)
        .join("\n")}`,
    );
  }
  if (metrics.depth >= entry.depth) {
    return;
  }
  notices.push(
    `Waterfall shallower on ${route}: ${entry.depth} -> ${metrics.depth} (improvement; refresh the baseline to tighten the budget).`,
  );
};

// A request's SQL count is not perfectly deterministic: better-auth
// occasionally piggybacks a session-expiry refresh, and caches shift counts by
// a query or two. An actual N+1 scales with collection size (tens of extra
// queries), so a small absolute+relative allowance keeps the guard flake-free
// without masking the failure mode it exists for.
export const dbQueryAllowance = (budget: number): number =>
  budget + Math.max(2, Math.ceil(budget * 0.15));

const requestCountBudget = (
  entry: NetworkBaselineEntry,
): Record<string, number> => {
  const budget = Object.fromEntries(entry.requests.map((key) => [key, 1]));
  if (entry.requestCounts === undefined) {
    return budget;
  }
  return { ...budget, ...entry.requestCounts };
};

// The guard is deliberately one-directional: it only fails when a route grows a
// NEW request or a DEEPER waterfall. A request that disappears or a shallower
// waterfall is an improvement, never a failure — a late/conditional call that
// happens to not fire on a given run must never flake CI. Those show up as
// notices suggesting a deliberate baseline refresh instead.
export const diffNetworkBaseline = (
  baseline: NetworkBaseline | null,
  results: Map<string, RouteNetworkMetrics>,
): NetworkBaselineDiff => {
  const problems: string[] = [];
  const notices: string[] = [];

  if (baseline === null) {
    problems.push(
      `Network baseline file is missing (${BASELINE_RELATIVE}).\n` +
        `  To create it, ${WRITE_HINT}.`,
    );
    return { problems, notices };
  }

  for (const [route, metrics] of results) {
    const entry = baseline[route];
    if (entry === undefined) {
      problems.push(
        `New route not in the network baseline: ${route}\n` +
          `  A newly smoked route has no budget yet — ${WRITE_HINT}.`,
      );
      continue;
    }

    pushNewRequestProblems({ route, entry, metrics, problems });
    pushWaterfallDepthProblems({ route, entry, metrics, problems });
    pushRequestCountProblems({ route, entry, metrics, problems });

    // DB-count budgets only fail on exceed: a lower count is common (cache
    // hits, timing) and re-noticing it every run would be noise; tightening
    // happens via a deliberate rewrite.
    pushDbQueryProblems({ route, entry, metrics, problems });
    pushImprovementNotices({ route, entry, metrics, notices });
  }

  for (const route of Object.keys(baseline)) {
    if (!results.has(route)) {
      problems.push(
        `Stale network baseline entry (route not visited this run): ${route}\n` +
          `  The smoke route set is deterministic, so a baseline route that never\n` +
          `  ran means the route was renamed or removed — prune it: ${WRITE_HINT}.`,
      );
    }
  }

  return { problems, notices };
};

const readNetworkBaseline = (): NetworkBaseline | null => {
  if (!existsSync(BASELINE_PATH)) {
    return null;
  }
  const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  if (!isNetworkBaseline(parsed)) {
    throw new Error(`Invalid network baseline shape in ${BASELINE_RELATIVE}`);
  }
  return parsed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNumberRecord = (value: unknown): value is Record<string, number> =>
  isRecord(value) &&
  Object.values(value).every((item) => typeof item === "number");

const isNetworkBaselineEntry = (
  value: unknown,
): value is NetworkBaselineEntry => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value["depth"] === "number" &&
    isStringArray(value["requests"]) &&
    (value["requestCounts"] === undefined ||
      isNumberRecord(value["requestCounts"])) &&
    (value["dbQueries"] === undefined || isNumberRecord(value["dbQueries"]))
  );
};

const isNetworkBaseline = (value: unknown): value is NetworkBaseline =>
  isRecord(value) && Object.values(value).every(isNetworkBaselineEntry);

// Some requests are timing-conditional: they fire only when an idle prefetch
// lands inside the route's settle window (e.g. a views warmup racing a 250ms
// settle). A single-run snapshot would miss them and a later run would then
// fail the one-directional check as a "new request". `write` therefore MERGES
// into the existing baseline: requests accumulate as a union and depth takes
// the max, so repeated write runs converge on the full envelope of observable
// behavior. Routes absent from this run (renamed/removed) are dropped — the
// walk deterministically visits every smoked route.
export const mergeNetworkBaseline = (
  existing: NetworkBaseline | null,
  results: Map<string, RouteNetworkMetrics>,
): NetworkBaseline => {
  const merged: NetworkBaseline = {};
  for (const route of [...results.keys()].sort()) {
    const metrics = results.get(route);
    if (metrics === undefined) {
      continue;
    }
    const previous = existing?.[route];
    const previousRequests = previous?.requests ?? [];
    const requestCounts: Record<string, number> = {};
    for (const source of [
      previous ? requestCountBudget(previous) : {},
      metrics.requestCounts,
    ]) {
      for (const [key, count] of Object.entries(source)) {
        requestCounts[key] = Math.max(requestCounts[key] ?? 0, count);
      }
    }
    const dbQueries: Record<string, number> = {};
    for (const source of [previous?.dbQueries ?? {}, metrics.dbQueries]) {
      for (const [key, count] of Object.entries(source)) {
        dbQueries[key] = Math.max(dbQueries[key] ?? 0, count);
      }
    }
    merged[route] = {
      depth: Math.max(metrics.depth, previous?.depth ?? 0),
      requests: [...new Set([...metrics.requests, ...previousRequests])].sort(),
      requestCounts: Object.fromEntries(
        Object.entries(requestCounts).sort(([a], [b]) => a.localeCompare(b)),
      ),
      dbQueries: Object.fromEntries(
        Object.entries(dbQueries).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }
  return merged;
};

const snapshotNetworkBaseline = (
  results: Map<string, RouteNetworkMetrics>,
): NetworkBaseline => mergeNetworkBaseline(null, results);

// Sorted route keys + sorted/deduped request arrays + trailing newline keeps
// the committed file diff-stable across runs.
const writeNetworkBaseline = (baseline: NetworkBaseline) => {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
};

export const assertNetworkBaseline = (
  results: Map<string, RouteNetworkMetrics>,
) => {
  const mode = process.env["E2E_NETWORK_BASELINE"];

  // `write` merges into the existing baseline (safe default: budgets only
  // widen); `rewrite` snapshots from scratch — use it after a perf fix to
  // tighten depths, then re-run `write` a few times to re-accumulate
  // timing-conditional requests.
  if (mode === "write" || mode === "rewrite") {
    const existing = mode === "write" ? readNetworkBaseline() : null;
    const baseline =
      existing === null
        ? snapshotNetworkBaseline(results)
        : mergeNetworkBaseline(existing, results);
    writeNetworkBaseline(baseline);
    console.log(
      `[network-baseline] ${mode === "write" && existing !== null ? "merged" : "wrote"} ${results.size} route(s) to ${BASELINE_RELATIVE}`,
    );
    return;
  }

  const { problems, notices } = diffNetworkBaseline(
    readNetworkBaseline(),
    results,
  );

  for (const notice of notices) {
    console.log(`[network-baseline] ${notice}`);
  }

  expect(
    problems,
    problems.length === 0
      ? "network baseline"
      : `Network baseline check failed:\n\n${problems.join("\n\n")}`,
  ).toEqual([]);
};
