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

// The API sends real-time channels (chat streaming, workspace events, the
// autocomplete stream) as `text/event-stream` connections that stay open for
// the life of the page instead of returning a fixed payload. Their "size" is
// unbounded by design, so the response-size dimension excludes them entirely
// rather than budgeting a snapshot of however many bytes happened to have
// streamed by the time the `response` event fired.
const STREAMED_RESPONSE_CONTENT_TYPE = "text/event-stream";

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
    // Response body size in bytes; null for a streamed response (excluded by
    // content-type, see STREAMED_RESPONSE_CONTENT_TYPE) or one whose body
    // Playwright never resolved (see responseBytesUnavailable).
    responseBytes: number | null;
    // True only when Playwright saw a non-streamed response and reading its
    // body failed (e.g. aborted/redirected mid-navigation).
    responseBytesUnavailable: boolean;
  }[];
  // Intervals for finite API responses only. Streams remain in `requests` so
  // request coverage sees them, but they do not represent a route-load round:
  // the page does not wait for an EventSource to finish before it can settle.
  intervals: { start: number; end: number }[];
};

export type NetworkCollector = {
  trackPage: (page: Page) => () => void;
  // Waits until tracked API activity has been quiet for the requested window.
  // Long-lived SSE streams do not block this: only their request/response
  // events count as activity, not the open connection itself.
  waitForQuiet: (options: NetworkQuietOptions) => Promise<"idle" | "timeout">;
  // Async: waits for in-flight response-body reads so response sizes are
  // populated before the caller summarizes the capture.
  capture: () => Promise<NetworkCapture>;
};

export type NetworkQuietOptions = {
  idleMs: number;
  minimumObservationMs: number;
  timeoutMs: number;
};

type WaitForQuietPeriodOptions = NetworkQuietOptions & {
  getLastActivityAt: () => number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
};

// Kept independent of Playwright so the timing state machine can be exercised
// deterministically with a fake clock. The timeout is a cap, matching the old
// settle window; reaching it allows capture instead of hanging on polling.
export const waitForQuietPeriod = async ({
  getLastActivityAt,
  idleMs,
  minimumObservationMs,
  timeoutMs,
  now = Date.now,
  sleep = async (durationMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, durationMs);
    }),
}: WaitForQuietPeriodOptions): Promise<"idle" | "timeout"> => {
  const startedAt = now();
  const timeoutAt = startedAt + timeoutMs;

  while (true) {
    const current = now();
    const idleAt = Math.max(
      startedAt + minimumObservationMs,
      Math.max(startedAt, getLastActivityAt()) + idleMs,
    );
    if (current >= idleAt) {
      return "idle";
    }
    if (current >= timeoutAt) {
      return "timeout";
    }
    await sleep(Math.min(idleAt, timeoutAt) - current);
  }
};

type NetworkCollectorOptions = {
  apiOrigin?: string;
};

// Playwright does not export its resource-timing shape as a named type, so it
// is derived from the method that produces it.
type ResourceTiming = ReturnType<Request["timing"]>;

// The browser reports -1 for a value it never recorded (a request that failed
// before the response, or an engine that does not populate the field).
const TIMING_UNAVAILABLE = -1;

// Depth is measured from timestamps taken inside the browser's network stack,
// not from when this process handles the corresponding CDP event. The driver
// competes with the browser and every other shard on a CI runner, so delayed
// event delivery used to merge real launch waves on busy runs and expose them
// again on fast runs. `startTime` is epoch ms; `responseEnd` is relative to it.
export const browserRequestInterval = (
  timing: ResourceTiming,
): { start: number; end: number } | null => {
  if (timing.startTime <= 0 || timing.responseEnd === TIMING_UNAVAILABLE) {
    return null;
  }
  return {
    start: timing.startTime,
    end: timing.startTime + timing.responseEnd,
  };
};

type NetworkRecord = {
  method: string;
  pathname: string;
  resourceType: string;
  start: number;
  end: number | null;
  streamed: boolean;
  // Browser-measured interval, present once the request settles and the
  // network stack times it. Untimed requests retain both driver timestamps,
  // so an interval is never assembled from two different clocks.
  browserInterval: { start: number; end: number } | null;
  // From the API's dev/test-only `x-db-queries` response header (the
  // per-request Drizzle query counter); null when no response arrived.
  dbQueries: number | null;
  // True only when Playwright saw a response and that response did not expose
  // the dev/test query-count header.
  dbQueryHeaderMissing: boolean;
  // Response body length in bytes; null until the async body read resolves,
  // and permanently null for a streamed (SSE) response.
  responseBytes: number | null;
  responseBytesUnavailable: boolean;
};

/** Streams are covered as requests, but never form a route-load waterfall. */
export const countsTowardsWaterfall = ({
  resourceType,
  streamed,
}: Pick<NetworkRecord, "resourceType" | "streamed">): boolean =>
  resourceType !== "eventsource" && !streamed;

const isTrackedApiRequest = (request: Request, apiOrigin: string): boolean => {
  if (!TRACKED_RESOURCE_TYPES.has(request.resourceType())) {
    return false;
  }
  return new URL(request.url()).origin === apiOrigin;
};

const isStreamedResponse = (response: Response): boolean =>
  (response.headers()["content-type"] ?? "")
    .toLowerCase()
    .includes(STREAMED_RESPONSE_CONTENT_TYPE);

// Playwright's body() rejects for a response that never finishes (aborted or
// redirected mid-navigation); that is a legitimate outcome here, not a bug in
// the collector, so it is caught and recorded rather than left to reject the
// whole route walk.
const readResponseBytes = async (
  response: Response,
  record: NetworkRecord,
): Promise<void> => {
  try {
    const body = await response.body();
    record.responseBytes = body.length;
  } catch {
    record.responseBytesUnavailable = true;
  }
};

export const createNetworkCollector = (
  collectorOptions: NetworkCollectorOptions = {},
): NetworkCollector => {
  const apiOrigin =
    collectorOptions.apiOrigin ?? new URL(DEFAULT_API_URL).origin;
  const records: NetworkRecord[] = [];
  const byRequest = new Map<Request, NetworkRecord>();
  // Body reads are async (Playwright must finish downloading the response),
  // so capture() awaits these before reading responseBytes off the records.
  const pendingBodyReads: Promise<void>[] = [];
  let lastActivityAt = Date.now();

  const markActivity = () => {
    lastActivityAt = Date.now();
  };

  return {
    trackPage: (page) => {
      const onRequest = (request: Request) => {
        if (!isTrackedApiRequest(request, apiOrigin)) {
          return;
        }
        const record: NetworkRecord = {
          method: request.method(),
          pathname: new URL(request.url()).pathname,
          resourceType: request.resourceType(),
          start: Date.now(),
          end: null,
          streamed: request.resourceType() === "eventsource",
          browserInterval: null,
          dbQueries: null,
          dbQueryHeaderMissing: false,
          responseBytes: null,
          responseBytesUnavailable: false,
        };
        records.push(record);
        byRequest.set(request, record);
        markActivity();
      };

      const onSettled = (request: Request) => {
        const record = byRequest.get(request);
        if (record) {
          record.end = Date.now();
          // `responseEnd` becomes available when the request finishes.
          record.browserInterval = browserRequestInterval(request.timing());
          markActivity();
        }
      };

      const onResponse = (response: Response) => {
        const record = byRequest.get(response.request());
        if (!record) {
          return;
        }
        markActivity();
        const header = response.headers()[DB_QUERIES_HEADER];
        if (header !== undefined) {
          record.dbQueries = Number(header);
        } else {
          record.dbQueryHeaderMissing = true;
        }

        if (isStreamedResponse(response)) {
          record.streamed = true;
          return;
        }
        pendingBodyReads.push(readResponseBytes(response, record));
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

    waitForQuiet: async (quietOptions) =>
      waitForQuietPeriod({
        ...quietOptions,
        getLastActivityAt: () => lastActivityAt,
      }),

    capture: async () => {
      await Promise.all(pendingBodyReads);
      // A still-pending request can only be the tail of a chain (nothing waited
      // on its response yet), so closing it at "now" never inflates the depth.
      const now = Date.now();
      return {
        requests: records.map(
          ({
            method,
            pathname,
            dbQueries,
            dbQueryHeaderMissing,
            responseBytes,
            responseBytesUnavailable,
          }) => ({
            method,
            pathname,
            dbQueries,
            dbQueryHeaderMissing,
            responseBytes,
            responseBytesUnavailable,
          }),
        ),
        intervals: records
          .filter(countsTowardsWaterfall)
          .map(
            ({ browserInterval, start, end }) =>
              browserInterval ?? { start, end: end ?? now },
          ),
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

// A request launched this long after the previous LAUNCH starts a new
// observation sequence, not another route-load round: an idle prefetch that
// fires once the route has settled is not a level the user waits through. The
// split reads start times only, so how long a response takes can never move an
// observation boundary.
//
// Reading launch times rather than the gap since the previous response ENDED is
// what buys load-monotonicity, and it costs sensitivity: a dependent request
// whose parent took longer than this gap opens a new sequence instead of
// counting a level. The three properties are not simultaneously satisfiable —
// separating a dependent request from an idle prefetch requires knowing how long
// the parent ran, and any rule that reads response ends lets a response growing
// under load close a gap it used to exceed, which is exactly the failure this
// metric had. Under-counting a slow chain is the safer of the two errors for a
// guard whose baselines are only ever compared upward.
const REQUEST_SEQUENCE_GAP_MS = 500;

// Depth = the most consecutive busy blocks inside any one observation sequence,
// where a busy block is a maximal run of requests whose intervals overlap. Two
// requests that were in flight at the same instant are never counted as two
// levels, so this is a lower bound on true causal depth: a request that depends
// on a fast response stays hidden behind an unrelated slow one.
//
// Load-monotonicity is the property the guard rests on: neither a slower
// response nor a uniformly stretched timeline can raise the result. The
// converse does not hold: a FASTER response ends a busy block earlier, so an
// unrelated request that used to overlap it now launches after it and reads
// as one more level. A single lucky sample therefore over-reads by one on a
// route that did not change, which is why the route-smoke suite re-measures a
// route before treating a deeper reading as a regression
// (`WATERFALL_DEPTH_RESAMPLES`). Timing alone cannot separate a dependent
// launch from a coincidentally later one; sampling is the honest fix. Two
// rules buy the monotonicity that does hold:
//   1. The sequence split reads LAUNCH times only. Segment boundaries therefore
//      cannot move when responses take longer, and a uniform slowdown widens
//      launch gaps, which only splits a sequence further.
//   2. Coverage (`busyUntil`) is a running max over every end seen so far and is
//      never rewound at a boundary. A still-in-flight long request keeps masking
//      the requests that overlap it even across a split, so a split can only
//      lower the count, never unmask a chain hiding behind that request.
// The previous formulation broke rule 1: it counted rounds through a counter
// that reset on a gap measured from the END of the previous round, so a response
// that grew under load could close that gap, skip the reset, and carry the count
// forward into a deeper reading with no change to the route at all.
export const waterfallDepth = (
  intervals: { start: number; end: number }[],
): number => {
  const sorted = intervals.toSorted((a, b) => a.start - b.start);
  const first = sorted.at(0);
  if (first === undefined) {
    return 0;
  }

  let best = 1;
  let blocksInSequence = 1;
  let previousStart = first.start;
  let busyUntil = first.end;

  for (const interval of sorted.slice(1)) {
    const launchGap = interval.start - previousStart;
    previousStart = interval.start;

    if (launchGap > REQUEST_SEQUENCE_GAP_MS) {
      blocksInSequence = 1;
    } else if (interval.start >= busyUntil) {
      blocksInSequence += 1;
      best = Math.max(best, blocksInSequence);
    }
    busyUntil = Math.max(busyUntil, interval.end);
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
  // Per request key, the max response body size (bytes) observed this run.
  // Streamed (SSE) responses and keys whose body never resolved are absent.
  responseSizes: Record<string, number>;
  // Per request key, how many non-streamed responses failed to yield a body.
  missingResponseSizeCounts: Record<string, number>;
};

export type NetworkBaselineEntry = {
  depth: number;
  requests: string[];
  // Optional so baselines written before request multiplicity existed still parse.
  requestCounts?: Record<string, number>;
  // Optional so baselines written before the counter existed still parse.
  dbQueries?: Record<string, number>;
  // Optional so baselines written before the response-size dimension existed
  // still parse. Bytes, rounded up to the next KiB by the writer.
  responseSizes?: Record<string, number>;
};

export type NetworkBaseline = Record<string, NetworkBaselineEntry>;

export const summarizeCapture = (
  capture: NetworkCapture,
): RouteNetworkMetrics => {
  const dbQueries: Record<string, number> = {};
  const missingDbQueryCounts: Record<string, number> = {};
  const responseSizes: Record<string, number> = {};
  const missingResponseSizeCounts: Record<string, number> = {};
  const requestCounts: Record<string, number> = {};
  for (const request of capture.requests) {
    const key = requestKey(request);
    requestCounts[key] = (requestCounts[key] ?? 0) + 1;
    if (request.dbQueryHeaderMissing) {
      missingDbQueryCounts[key] = (missingDbQueryCounts[key] ?? 0) + 1;
    }
    if (request.dbQueries !== null && !Number.isNaN(request.dbQueries)) {
      dbQueries[key] = Math.max(dbQueries[key] ?? 0, request.dbQueries);
    }
    if (request.responseBytesUnavailable) {
      missingResponseSizeCounts[key] =
        (missingResponseSizeCounts[key] ?? 0) + 1;
    }
    if (
      request.responseBytes !== null &&
      !Number.isNaN(request.responseBytes)
    ) {
      responseSizes[key] = Math.max(
        responseSizes[key] ?? 0,
        request.responseBytes,
      );
    }
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
    responseSizes: Object.fromEntries(
      Object.entries(responseSizes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    missingResponseSizeCounts: Object.fromEntries(
      Object.entries(missingResponseSizeCounts).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };
};

export type NetworkBaselineDiff = {
  problems: string[];
  notices: string[];
};

type DiffNetworkBaselineOptions = {
  requireAllRoutes?: boolean;
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
  if (metrics.depth <= entry.depth) {
    return;
  }
  problems.push(
    `Request waterfall got deeper on ${route}: ${entry.depth} -> ${metrics.depth}\n` +
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

const pushResponseSizeProblems = ({
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
  const baselineSizes = entry.responseSizes ?? {};
  for (const key of Object.keys(baselineSizes)) {
    if (metrics.missingResponseSizeCounts[key] === undefined) {
      continue;
    }
    problems.push(
      `Response size missing on ${route}: ${key}\n` +
        `  This request has a committed response-size budget, but Playwright\n` +
        `  could not read the response body (aborted or redirected mid-\n` +
        `  navigation is the usual cause). Re-run the suite; if it persists,\n` +
        `  investigate before trusting this route's payload-size budget.`,
    );
  }
  for (const [key, observed] of Object.entries(metrics.responseSizes)) {
    const budget = baselineSizes[key];
    if (budget === undefined || observed <= responseSizeAllowance(budget)) {
      continue;
    }
    problems.push(
      `Response payload grew on ${route}: ${key} ran ${formatBytes(budget)} -> ${formatBytes(observed)}\n` +
        `  The endpoint now returns more bytes for the same page — the classic\n` +
        `  cause is a handler returning full rows instead of the minimal\n` +
        `  projection callers actually use ("Return minimal data" in\n` +
        `  AGENTS.md). Trim the response shape or, if the extra payload is\n` +
        `  genuinely required, ${WRITE_HINT}.`,
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

// Response bodies wobble run to run: generated ids, timestamps, and
// locale-formatted numbers all shift byte counts by a few percent without
// signaling a real regression. +20% headroom absorbs that jitter while still
// catching an endpoint that starts returning full rows instead of the
// minimal projection the repo convention requires.
const RESPONSE_SIZE_ALLOWANCE_MULTIPLIER = 1.2;

export const responseSizeAllowance = (budgetBytes: number): number =>
  Math.ceil(budgetBytes * RESPONSE_SIZE_ALLOWANCE_MULTIPLIER);

const BYTES_PER_KIB = 1024;

// Budgets are stored rounded up to the next KiB so a one-byte jitter in a
// freshly written baseline does not immediately eat into the +20% allowance
// above it.
const roundUpToKiB = (bytes: number): number =>
  Math.ceil(bytes / BYTES_PER_KIB) * BYTES_PER_KIB;

const formatBytes = (bytes: number): string =>
  `${(bytes / BYTES_PER_KIB).toFixed(1)} KiB`;

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
  { requireAllRoutes = true }: DiffNetworkBaselineOptions = {},
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
    // Same one-directional policy as DB-query budgets: a smaller payload is
    // never a failure, only a growth beyond the allowance is.
    pushResponseSizeProblems({ route, entry, metrics, problems });
    pushImprovementNotices({ route, entry, metrics, notices });
  }

  if (requireAllRoutes) {
    for (const route of Object.keys(baseline)) {
      if (!results.has(route)) {
        problems.push(
          `Stale network baseline entry (route not visited this run): ${route}\n` +
            `  The smoke route set is deterministic, so a baseline route that never\n` +
            `  ran means the route was renamed or removed — prune it: ${WRITE_HINT}.`,
        );
      }
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

// How many extra measurements a route gets when its first sample reads deeper
// than the committed budget. Depth is a timing lower bound that a fast sample
// can over-read by one (see `waterfallDepth`); a real extra round shows up in
// every sample, jitter does not. Only suspected regressions pay for the extra
// navigations.
export const WATERFALL_DEPTH_RESAMPLES = 2;

/** Committed depth budget for a route, or null when it has no baseline entry. */
export const baselineWaterfallDepth = (route: string): number | null =>
  readNetworkBaseline()?.[route]?.depth ?? null;

const maxPerKey = (
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> => {
  const merged: Record<string, number> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = Math.max(merged[key] ?? 0, value);
  }
  return Object.fromEntries(
    Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
  );
};

/**
 * Fold a re-measurement into the metrics of one route. Depth takes the
 * minimum, because only jitter can push a sample above the true depth. Every
 * other dimension takes the union or per-key maximum, so a regression the
 * first sample caught (a new request, an N+1, an oversized body) survives a
 * later sample that happened to read shallower.
 */
export const mergeResampledMetrics = (
  current: RouteNetworkMetrics,
  candidate: RouteNetworkMetrics,
): RouteNetworkMetrics => ({
  requests: [...new Set([...current.requests, ...candidate.requests])].sort(),
  requestCounts: maxPerKey(current.requestCounts, candidate.requestCounts),
  depth: Math.min(current.depth, candidate.depth),
  dbQueries: maxPerKey(current.dbQueries, candidate.dbQueries),
  missingDbQueryCounts: maxPerKey(
    current.missingDbQueryCounts,
    candidate.missingDbQueryCounts,
  ),
  responseSizes: maxPerKey(current.responseSizes, candidate.responseSizes),
  missingResponseSizeCounts: maxPerKey(
    current.missingResponseSizeCounts,
    candidate.missingResponseSizeCounts,
  ),
});

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
    (value["dbQueries"] === undefined || isNumberRecord(value["dbQueries"])) &&
    (value["responseSizes"] === undefined ||
      isNumberRecord(value["responseSizes"]))
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
    const responseSizes: Record<string, number> = {};
    for (const source of [
      previous?.responseSizes ?? {},
      metrics.responseSizes,
    ]) {
      for (const [key, bytes] of Object.entries(source)) {
        responseSizes[key] = Math.max(responseSizes[key] ?? 0, bytes);
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
      // Rounded up to the next KiB here (the writer), not at measurement time,
      // so the raw max observed across write runs is what gets rounded once.
      responseSizes: Object.fromEntries(
        Object.entries(responseSizes)
          .map(([key, bytes]) => [key, roundUpToKiB(bytes)] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
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
  options: DiffNetworkBaselineOptions = {},
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
    options,
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

export const assertNetworkBaselineCoverage = (expectedRoutes: string[]) => {
  const baseline = readNetworkBaseline();
  expect(
    baseline === null ? [] : Object.keys(baseline).sort(),
    `network baseline route keys in ${BASELINE_RELATIVE}`,
  ).toEqual(expectedRoutes.toSorted());
};
