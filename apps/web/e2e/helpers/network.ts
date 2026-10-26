import { expect, test } from "@playwright/test";
import type { Page, Request, Response } from "@playwright/test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { sleep as ownerSleep } from "@stll/concurrency/sleep";

import { createNetworkRoundController } from "./network-rounds";
import { networkBaselineCoverageProblem } from "./smoke-route-coverage";

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
// Spelled out for diagnostics regardless of the suite working directory.
const BASELINE_RELATIVE = "apps/web/e2e/network-baseline.json";
const WRITE_HINT =
  "declare an intentional increase in apps/web/e2e/network-budgets/<change>.json; main records the shared baseline";

const NETWORK_ROUND_POLL_MS = 10;

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
  // Scheduled release rounds; only measurement navigations install the barrier.
  depthChain: string[][];
};

export type NetworkCollector = {
  trackPage: (page: Page) => () => void;
  measureRounds: (page: Page) => Promise<void>;
  finishRounds: () => void;
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
  sleep = ownerSleep,
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

type NetworkRecord = {
  method: string;
  pathname: string;
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

const BACKGROUND_POLL_PATHS = new Set(["/health"]);

type WaterfallRequest = {
  pathname: string;
  resourceType: string;
};

/** Background work remains budgeted, but cannot affect route-load depth. */
export const countsTowardsWaterfall = ({
  pathname,
  resourceType,
}: WaterfallRequest): boolean =>
  resourceType !== "eventsource" && !BACKGROUND_POLL_PATHS.has(pathname);

const requestDetails = (request: Request): WaterfallRequest => ({
  pathname: new URL(request.url()).pathname,
  resourceType: request.resourceType(),
});

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
  const rounds = createNetworkRoundController<Request>();
  const released = new Set<Request>();

  const markActivity = () => {
    lastActivityAt = Date.now();
  };

  return {
    measureRounds: async (page) => {
      await page.route(
        (url) => url.origin === apiOrigin,
        async (route) => {
          const request = route.request();
          if (
            !isTrackedApiRequest(request, apiOrigin) ||
            !countsTowardsWaterfall(requestDetails(request)) ||
            rounds.loaded
          ) {
            await route.continue();
            return;
          }
          rounds.arrive({
            token: request,
            key: requestKey({
              method: request.method(),
              pathname: new URL(request.url()).pathname,
            }),
            now: Date.now(),
          });
          // finishRounds can mark the controller loaded while this handler
          // awaits, so read it fresh on every iteration.
          const loaded = () => rounds.loaded;
          while (!released.delete(request) && !loaded()) {
            for (const token of rounds.release(Date.now())) {
              released.add(token);
            }
            if (released.has(request)) {
              continue;
            }
            // The page abandoned the request while it was held: it never
            // reaches the network, so stop waiting and do not continue it.
            if (!rounds.holds(request)) {
              return;
            }
            await ownerSleep(NETWORK_ROUND_POLL_MS);
          }
          await route.continue();
        },
      );
    },
    finishRounds: () => {
      rounds.finish();
    },
    trackPage: (page) => {
      const onRequest = (request: Request) => {
        if (!isTrackedApiRequest(request, apiOrigin)) {
          return;
        }
        const record: NetworkRecord = {
          method: request.method(),
          pathname: new URL(request.url()).pathname,
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
        if (countsTowardsWaterfall(requestDetails(request))) {
          rounds.complete(request, Date.now());
        }
        const record = byRequest.get(request);
        if (record) {
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
          // Streams never finish; headers establish that the channel opened.
          if (countsTowardsWaterfall(requestDetails(response.request()))) {
            rounds.complete(response.request(), Date.now());
          }
          return;
        }
        pendingBodyReads.push(readResponseBytes(response, record));
      };

      page.on("request", onRequest);
      page.on("response", onResponse);
      page.on("requestfinished", onSettled);
      page.on("requestfailed", onSettled);

      return () => {
        rounds.finish();
        released.clear();
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("requestfinished", onSettled);
        page.off("requestfailed", onSettled);
      };
    },

    waitForQuiet: async (quietOptions) =>
      waitForQuietPeriod({
        ...quietOptions,
        getLastActivityAt: () => (rounds.pending ? Date.now() : lastActivityAt),
      }),

    capture: async () => {
      await Promise.all(pendingBodyReads);
      return {
        depthChain: rounds.rounds,
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

// --- baseline machinery ----------------------------------------------------

export type RouteNetworkMetrics = {
  // Observed request keys, unique + sorted.
  requests: string[];
  // Per request key, how many times it was observed.
  requestCounts: Record<string, number>;
  // Number of nonempty barrier releases, including duplicate request keys.
  depth: number;
  // The request keys behind `depth`, one entry per level in launch order (see
  // round controller). Diagnostic only: never written to the baseline.
  depthChain: string[][];
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

export const NETWORK_DEPTH_METHOD = "round-barrier-v1";

export type NetworkBaselineEntry = {
  depth: number;
  // Missing on recordings made before depth method versioning.
  depthMethod?: string;
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
  const depthChain = capture.depthChain;
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
    requests: Object.keys(requestCounts).toSorted(),
    requestCounts: Object.fromEntries(
      Object.entries(requestCounts).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    depth: depthChain.length,
    depthChain,
    dbQueries,
    missingDbQueryCounts: Object.fromEntries(
      Object.entries(missingDbQueryCounts).toSorted(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
    responseSizes: Object.fromEntries(
      Object.entries(responseSizes).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    missingResponseSizeCounts: Object.fromEntries(
      Object.entries(missingResponseSizeCounts).toSorted(([a], [b]) =>
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
  changedRoutes?: readonly string[];
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

// One line per level of the deepest sequence. Several keys on a level means
// those requests launched in the same measured wave.
const formatDepthChain = (depthChain: string[][]): string => {
  if (!depthChain.some((keys) => keys.length > 0)) {
    return "";
  }
  return `${depthChain
    .map((keys, index) => `  level ${index + 1}: ${keys.join(", ")}`)
    .join("\n")}\n`;
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
    `Request waterfall got deeper on ${route}: ${entry.depth} -> ${metrics.depth}\n${formatDepthChain(metrics.depthChain)}` +
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
  if (
    entry.depthMethod !== NETWORK_DEPTH_METHOD ||
    metrics.depth >= entry.depth
  ) {
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
  {
    requireAllRoutes = true,
    changedRoutes = [],
  }: DiffNetworkBaselineOptions = {},
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
      if (changedRoutes.includes(route)) {
        notices.push(`New scoped route ${route}: ${JSON.stringify(metrics)}`);
        continue;
      }
      problems.push(
        `New route not in the network baseline: ${route}\n` +
          `  A newly smoked route has no budget yet — ${WRITE_HINT}.`,
      );
      continue;
    }

    if (changedRoutes.includes(route)) {
      notices.push(`Changed scoped route ${route}: ${JSON.stringify(metrics)}`);
    }
    pushNewRequestProblems({ route, entry, metrics, problems });
    if (entry.depthMethod === NETWORK_DEPTH_METHOD) {
      pushWaterfallDepthProblems({ route, entry, metrics, problems });
    } else {
      notices.push(
        `Waterfall depth method differs on ${route}: ${entry.depthMethod ?? "unversioned"} -> ${NETWORK_DEPTH_METHOD}; observed depth ${metrics.depth} (baseline ${entry.depth}). Depth is informational until main records the current method.`,
      );
    }
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
      if (!results.has(route) && !changedRoutes.includes(route)) {
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
    (value["depthMethod"] === undefined ||
      typeof value["depthMethod"] === "string") &&
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
// the max within the same method, so repeated write runs converge on the full envelope of observable
// behavior. Routes absent from this run (renamed/removed) are dropped — the
// walk deterministically visits every smoked route.
export const mergeNetworkBaseline = (
  existing: NetworkBaseline | null,
  results: Map<string, RouteNetworkMetrics>,
): NetworkBaseline => {
  const merged: NetworkBaseline = {};
  for (const route of [...results.keys()].toSorted()) {
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
      depth: Math.max(
        metrics.depth,
        previous?.depthMethod === NETWORK_DEPTH_METHOD ? previous.depth : 0,
      ),
      depthMethod: NETWORK_DEPTH_METHOD,
      requests: [
        ...new Set([...metrics.requests, ...previousRequests]),
      ].toSorted(),
      requestCounts: Object.fromEntries(
        Object.entries(requestCounts).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
      dbQueries: Object.fromEntries(
        Object.entries(dbQueries).toSorted(([a], [b]) => a.localeCompare(b)),
      ),
      // Rounded up to the next KiB here (the writer), not at measurement time,
      // so the raw max observed across write runs is what gets rounded once.
      responseSizes: Object.fromEntries(
        Object.entries(responseSizes)
          .map(([key, bytes]) => [key, roundUpToKiB(bytes)] as const)
          .toSorted(([a], [b]) => a.localeCompare(b)),
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

const readChangedRoutes = (): string[] => {
  const file = path.join(
    import.meta.dirname,
    "..",
    ".network-baseline-context.json",
  );
  if (!existsSync(file)) {
    return [];
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (route: unknown): route is string =>
        typeof route === "string" && route.startsWith("/"),
    )
  ) {
    throw new Error("Invalid network baseline comparison context");
  }
  return parsed;
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
    { ...options, changedRoutes: readChangedRoutes() },
  );

  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) {
    // Measurements contain route/request keys. Render inert fenced JSON so
    // route names cannot inject markdown or mentions into the summary.
    appendFileSync(
      summary,
      `\n### Network comparison\n\n\`\`\`json\n${JSON.stringify({ problems, notices }).replaceAll("`", "\\u0060")}\n\`\`\`\n`,
    );
  }
  if (notices.length > 0) {
    test.info().attachments.push({
      name: "network-comparison.json",
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ problems, notices }, null, 2)),
    });
    console.log(
      `[network-baseline] ${notices.length} informational notice(s); full notes in network-comparison.json in the test artifact.`,
    );
  }

  expect(
    problems,
    problems.length === 0
      ? "network baseline"
      : `Network baseline check failed:\n\n${problems.join("\n\n")}`,
  ).toEqual([]);
};

export const assertNetworkBaselineCoverage = (expectedRoutes: string[]) => {
  const problem = networkBaselineCoverageProblem({
    actualKeys: Object.keys(readNetworkBaseline() ?? {}),
    expectedKeys: expectedRoutes,
    changedRoutes: readChangedRoutes(),
  });
  expect(
    problem,
    `network baseline route keys in ${BASELINE_RELATIVE}`,
  ).toBeNull();
};
