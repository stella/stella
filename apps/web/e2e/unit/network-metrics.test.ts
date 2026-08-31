// Pure-logic tests for the network baseline metrics. These never open a page,
// so they launch no browser and need no dev server or storageState.
import { describe, expect, test } from "bun:test";

import {
  type NetworkBaseline,
  type RouteNetworkMetrics,
  browserRequestInterval,
  countsTowardsWaterfall,
  diffNetworkBaseline,
  mergeNetworkBaseline,
  mergeResampledMetrics,
  normalizeApiPath,
  responseSizeAllowance,
  waitForQuietPeriod,
  waterfallDepth,
} from "../helpers/network";

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID_UPPER = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";

describe("normalizeApiPath", () => {
  test("leaves a plain path untouched", () => {
    expect(normalizeApiPath("/v1/contacts")).toBe("/v1/contacts");
  });

  test("replaces a UUID segment mid-path", () => {
    expect(normalizeApiPath(`/v1/contacts/${UUID}`)).toBe("/v1/contacts/:id");
  });

  test("replaces every UUID segment", () => {
    expect(normalizeApiPath(`/v1/entities/${UUID}/entity/${UUID}`)).toBe(
      "/v1/entities/:id/entity/:id",
    );
  });

  test("matches uppercase hex", () => {
    expect(normalizeApiPath(`/v1/files/${UUID_UPPER}`)).toBe("/v1/files/:id");
  });
});

describe("waterfallDepth", () => {
  test("empty input is 0", () => {
    expect(waterfallDepth([])).toBe(0);
  });

  test("fully parallel requests are one round", () => {
    expect(
      waterfallDepth([
        { start: 0, end: 10 },
        { start: 1, end: 9 },
        { start: 2, end: 8 },
      ]),
    ).toBe(1);
  });

  test("distinct non-overlapping waves are separate rounds", () => {
    expect(
      waterfallDepth([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 20, end: 30 },
      ]),
    ).toBe(3);
  });

  test("mixed overlap counts only distinct waves", () => {
    expect(
      waterfallDepth([
        { start: 0, end: 100 },
        { start: 2, end: 12 },
        { start: 100, end: 120 },
      ]),
    ).toBe(2);
  });

  test("a long parallel request prevents false chains through fast replies", () => {
    expect(
      waterfallDepth([
        { start: 0, end: 500 },
        { start: 2, end: 10 },
        { start: 10, end: 20 },
        { start: 20, end: 30 },
      ]),
    ).toBe(1);
  });

  test("a faster response can raise the reading by one", () => {
    // Pins the asymmetry the route-smoke resampling exists for: the same two
    // requests read as one round or two depending only on how quickly the
    // first one answered. Any change that makes this deterministic can drop
    // WATERFALL_DEPTH_RESAMPLES.
    const overlapping = [
      { start: 0, end: 100 },
      { start: 90, end: 200 },
    ];
    const firstAnsweredFaster = [
      { start: 0, end: 80 },
      { start: 90, end: 200 },
    ];

    expect(waterfallDepth(overlapping)).toBe(1);
    expect(waterfallDepth(firstAnsweredFaster)).toBe(2);
  });

  test("resampling keeps the shallowest depth but every other regression", () => {
    const first: RouteNetworkMetrics = {
      requests: ["GET /v1/a", "GET /v1/new"],
      requestCounts: { "GET /v1/a": 2, "GET /v1/new": 1 },
      depth: 4,
      dbQueries: { "GET /v1/a": 40 },
      missingDbQueryCounts: { "GET /v1/new": 1 },
      responseSizes: { "GET /v1/a": 90_000 },
      missingResponseSizeCounts: {},
    };
    const shallower: RouteNetworkMetrics = {
      requests: ["GET /v1/a"],
      requestCounts: { "GET /v1/a": 1 },
      depth: 3,
      dbQueries: { "GET /v1/a": 4 },
      missingDbQueryCounts: {},
      responseSizes: { "GET /v1/a": 1000 },
      missingResponseSizeCounts: { "GET /v1/a": 1 },
    };

    expect(mergeResampledMetrics(first, shallower)).toEqual({
      requests: ["GET /v1/a", "GET /v1/new"],
      requestCounts: { "GET /v1/a": 2, "GET /v1/new": 1 },
      depth: 3,
      dbQueries: { "GET /v1/a": 40 },
      missingDbQueryCounts: { "GET /v1/new": 1 },
      responseSizes: { "GET /v1/a": 90_000 },
      missingResponseSizeCounts: { "GET /v1/a": 1 },
    });
  });

  test("an independent late request does not chain", () => {
    // A quiet gap between launches makes this an idle prefetch, not another
    // route-load round.
    expect(
      waterfallDepth([
        { start: 0, end: 10 },
        { start: 800, end: 900 },
      ]),
    ).toBe(1);
  });

  test("a strict chain of n requests is depth n", () => {
    const chain = Array.from({ length: 6 }, (_, index) => ({
      start: index * 20,
      end: index * 20 + 20,
    }));

    expect(waterfallDepth(chain)).toBe(6);
  });

  test("a stalled parallel burst is still one round", () => {
    const burst = [
      { start: 0, end: 40 },
      { start: 1, end: 55 },
      { start: 2, end: 30 },
    ];
    const underLoad = burst.map(({ start, end }) => ({
      start,
      end: end * 20,
    }));

    expect(waterfallDepth(burst)).toBe(1);
    expect(waterfallDepth(underLoad)).toBe(1);
  });

  test("a slower response cannot close an idle gap into an extra level", () => {
    // The CI failure shape: an idle prefetch launched after a quiet gap is its
    // own observation sequence. A response that grows under load may now run
    // past that launch, and must not thereby fold the prefetch into the route's
    // round count.
    const observed = [
      { start: 0, end: 10 },
      { start: 600, end: 610 },
      { start: 615, end: 625 },
    ];
    const underLoad = [
      { start: 0, end: 150 },
      { start: 600, end: 610 },
      { start: 615, end: 625 },
    ];

    expect(waterfallDepth(observed)).toBe(2);
    expect(waterfallDepth(underLoad)).toBe(2);
  });

  test("a chain whose parent outruns the sequence gap opens a new sequence", () => {
    // The documented sensitivity cost of reading launch times: telling this
    // apart from an idle prefetch would need the parent's duration, and every
    // rule that reads response ends loses load-monotonicity.
    expect(
      waterfallDepth([
        { start: 0, end: 600 },
        { start: 600, end: 610 },
      ]),
    ).toBe(1);
  });

  // Deterministic LCG so the properties replay the same timelines every run.
  const pseudoRandom = (seed: number) => {
    let state = seed;
    return () => {
      state = (state * 48_271) % 2_147_483_647;
      return state;
    };
  };

  // Launch gaps deliberately straddle the 500ms observation-sequence boundary.
  // A generator whose starts all sit a few ms apart never reaches that branch,
  // which is how the previous formulation's non-monotonicity survived a
  // property test.
  const STARTS = [0, 2, 75, 77, 150, 225, 900, 905, 1600, 1610, 1612];

  test("a slower response never deepens a waterfall", () => {
    for (let seed = 1; seed <= 256; seed++) {
      const nextRandom = pseudoRandom(seed);
      const intervals = STARTS.map((start) => ({
        start,
        end: start + 1 + (nextRandom() % 100),
      }));
      const underLoad = intervals.map(({ start, end }) => ({
        start,
        end: end + (nextRandom() % 1000),
      }));

      expect(waterfallDepth(underLoad)).toBeLessThanOrEqual(
        waterfallDepth(intervals),
      );
    }
  });

  test("a uniformly slower runner never deepens a waterfall", () => {
    for (let seed = 1; seed <= 256; seed++) {
      const nextRandom = pseudoRandom(seed);
      const intervals = STARTS.map((start) => ({
        start,
        end: start + 1 + (nextRandom() % 300),
      }));
      const scale = 1 + (nextRandom() % 10);
      const underLoad = intervals.map(({ start, end }) => ({
        start: start * scale,
        end: end * scale,
      }));

      expect(waterfallDepth(underLoad)).toBeLessThanOrEqual(
        waterfallDepth(intervals),
      );
    }
  });

  test("interval order cannot change launch rounds", () => {
    const intervals = [
      { start: 0, end: 10 },
      { start: 2, end: 12 },
      { start: 12, end: 20 },
      { start: 15, end: 25 },
      { start: 25, end: 35 },
    ];

    expect(waterfallDepth(intervals)).toBe(3);
    expect(waterfallDepth(intervals.toReversed())).toBe(3);
  });
});

describe("countsTowardsWaterfall", () => {
  test("keeps streamed requests in coverage without counting a load round", () => {
    expect(
      countsTowardsWaterfall({ resourceType: "eventsource", streamed: true }),
    ).toBe(false);
    expect(
      countsTowardsWaterfall({ resourceType: "fetch", streamed: true }),
    ).toBe(false);
  });

  test("counts finite API responses", () => {
    expect(
      countsTowardsWaterfall({ resourceType: "fetch", streamed: false }),
    ).toBe(true);
  });
});

describe("browserRequestInterval", () => {
  const timing = (
    startTime: number,
    responseEnd: number,
  ): Parameters<typeof browserRequestInterval>[0] => ({
    startTime,
    domainLookupStart: -1,
    domainLookupEnd: -1,
    connectStart: -1,
    secureConnectionStart: -1,
    connectEnd: -1,
    requestStart: -1,
    responseStart: -1,
    responseEnd,
  });

  test("resolves the relative response end against the epoch start", () => {
    expect(browserRequestInterval(timing(1_700_000_000_000, 42))).toEqual({
      start: 1_700_000_000_000,
      end: 1_700_000_000_042,
    });
  });

  test("rejects an unavailable response end", () => {
    expect(browserRequestInterval(timing(1_700_000_000_000, -1))).toBeNull();
  });

  test("rejects an unavailable start", () => {
    expect(browserRequestInterval(timing(-1, 42))).toBeNull();
  });
});

describe("waitForQuietPeriod", () => {
  test("observes the minimum window before returning idle", async () => {
    let current = 100;
    const result = await waitForQuietPeriod({
      getLastActivityAt: () => 0,
      idleMs: 500,
      minimumObservationMs: 1000,
      timeoutMs: 1000,
      now: () => current,
      sleep: async (durationMs) => {
        current += durationMs;
      },
    });

    expect(result).toBe("idle");
    expect(current).toBe(1100);
  });

  test("restarts the idle window when new activity arrives", async () => {
    let current = 0;
    let lastActivityAt = 0;
    const result = await waitForQuietPeriod({
      getLastActivityAt: () => lastActivityAt,
      idleMs: 500,
      minimumObservationMs: 1000,
      timeoutMs: 2000,
      now: () => current,
      sleep: async (durationMs) => {
        current += durationMs;
        if (current === 1000) {
          lastActivityAt = 800;
        }
      },
    });

    expect(result).toBe("idle");
    expect(current).toBe(1300);
  });

  test("caps a route that never becomes quiet", async () => {
    let current = 0;
    let lastActivityAt = 0;
    const result = await waitForQuietPeriod({
      getLastActivityAt: () => lastActivityAt,
      idleMs: 500,
      minimumObservationMs: 1000,
      timeoutMs: 1000,
      now: () => current,
      sleep: async (durationMs) => {
        current += durationMs;
        lastActivityAt = current;
      },
    });

    expect(result).toBe("timeout");
    expect(current).toBe(1000);
  });
});

const metrics = (
  requests: string[],
  depth: number,
  dbQueries: Record<string, number> = {},
  requestCounts: Record<string, number> = Object.fromEntries(
    requests.map((request) => [request, 1]),
  ),
  missingDbQueryCounts: Record<string, number> = {},
  responseSizes: Record<string, number> = {},
  missingResponseSizeCounts: Record<string, number> = {},
): RouteNetworkMetrics => ({
  requests: [...requests].sort(),
  requestCounts,
  depth,
  dbQueries,
  missingDbQueryCounts,
  responseSizes,
  missingResponseSizeCounts,
});

describe("diffNetworkBaseline", () => {
  const baseline: NetworkBaseline = {
    "/contacts": { depth: 2, requests: ["GET /v1/contacts"] },
  };

  test("missing baseline file is a single problem", () => {
    const { problems, notices } = diffNetworkBaseline(
      null,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 2)]]),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("missing");
    expect(notices).toEqual([]);
  });

  test("matching route produces no problems", () => {
    const { problems, notices } = diffNetworkBaseline(
      baseline,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 2)]]),
    );
    expect(problems).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("a new route is a problem", () => {
    const { problems } = diffNetworkBaseline(
      baseline,
      new Map([
        ["/contacts", metrics(["GET /v1/contacts"], 2)],
        ["/todos", metrics(["GET /v1/todos"], 1)],
      ]),
    );
    expect(problems.some((p) => p.includes("New route"))).toBe(true);
  });

  test("a new API request is a problem", () => {
    const { problems } = diffNetworkBaseline(
      baseline,
      new Map([
        ["/contacts", metrics(["GET /v1/contacts", "GET /v1/contacts/:id"], 2)],
      ]),
    );
    expect(problems.some((p) => p.includes("GET /v1/contacts/:id"))).toBe(true);
  });

  test("a waterfall at the committed depth passes", () => {
    const { problems } = diffNetworkBaseline(
      baseline,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 2)]]),
    );
    expect(problems).toEqual([]);
  });

  test("a single extra level is a problem", () => {
    const { problems } = diffNetworkBaseline(
      baseline,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 3)]]),
    );
    expect(problems.some((p) => p.includes("2 -> 3"))).toBe(true);
  });

  test("a repeated API request is a problem", () => {
    const { problems } = diffNetworkBaseline(
      baseline,
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, {}, { "GET /v1/contacts": 2 }),
        ],
      ]),
    );
    expect(problems.some((p) => p.includes("1 -> 2"))).toBe(true);
  });

  test("a repeated API request within an explicit budget passes", () => {
    const { problems } = diffNetworkBaseline(
      {
        "/contacts": {
          depth: 2,
          requests: ["GET /v1/contacts"],
          requestCounts: { "GET /v1/contacts": 2 },
        },
      },
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, {}, { "GET /v1/contacts": 2 }),
        ],
      ]),
    );
    expect(problems).toEqual([]);
  });

  test("a stale baseline entry is a problem", () => {
    const { problems } = diffNetworkBaseline(baseline, new Map());
    expect(problems.some((p) => p.includes("Stale"))).toBe(true);
  });

  test("a shard checks only the routes it observed", () => {
    const { problems } = diffNetworkBaseline(baseline, new Map(), {
      requireAllRoutes: false,
    });
    expect(problems).toEqual([]);
  });

  test("a missing request is a notice, not a problem", () => {
    const { problems, notices } = diffNetworkBaseline(
      baseline,
      new Map([["/contacts", metrics([], 1)]]),
    );
    expect(problems).toEqual([]);
    expect(notices.some((n) => n.includes("GET /v1/contacts"))).toBe(true);
  });

  test("a shallower waterfall is a notice, not a problem", () => {
    const { problems, notices } = diffNetworkBaseline(
      baseline,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 1)]]),
    );
    expect(problems).toEqual([]);
    expect(notices.some((n) => n.includes("shallower"))).toBe(true);
  });

  const dbBaseline: NetworkBaseline = {
    "/contacts": {
      depth: 2,
      requests: ["GET /v1/contacts"],
      dbQueries: { "GET /v1/contacts": 5 },
    },
  };

  test("a grown db-query count is a problem", () => {
    const { problems } = diffNetworkBaseline(
      dbBaseline,
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, { "GET /v1/contacts": 9 }),
        ],
      ]),
    );
    expect(problems.some((p) => p.includes("5 -> 9"))).toBe(true);
  });

  test("db growth within the allowance passes", () => {
    // allowance(5) = 5 + max(2, ceil(0.75)) = 7; session-refresh noise, not N+1.
    const { problems } = diffNetworkBaseline(
      dbBaseline,
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, { "GET /v1/contacts": 7 }),
        ],
      ]),
    );
    expect(problems).toEqual([]);
  });

  test("a lower db-query count passes silently", () => {
    const { problems } = diffNetworkBaseline(
      dbBaseline,
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, { "GET /v1/contacts": 2 }),
        ],
      ]),
    );
    expect(problems).toEqual([]);
  });

  test("an observed request with a missing db-query count is a problem", () => {
    const { problems } = diffNetworkBaseline(
      dbBaseline,
      new Map([
        [
          "/contacts",
          metrics(
            ["GET /v1/contacts"],
            2,
            {},
            { "GET /v1/contacts": 1 },
            { "GET /v1/contacts": 1 },
          ),
        ],
      ]),
    );
    expect(problems.some((p) => p.includes("DB query count missing"))).toBe(
      true,
    );
  });

  test("a request without a response is not a missing db-query count", () => {
    const { problems } = diffNetworkBaseline(
      dbBaseline,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 2)]]),
    );
    expect(problems).toEqual([]);
  });

  test("an unobserved request with a db-query budget is only a notice", () => {
    const { problems, notices } = diffNetworkBaseline(
      dbBaseline,
      new Map([["/contacts", metrics([], 1)]]),
    );
    expect(problems).toEqual([]);
    expect(notices.some((n) => n.includes("GET /v1/contacts"))).toBe(true);
  });

  test("a db count for a key without a budget is not a problem", () => {
    const { problems } = diffNetworkBaseline(
      dbBaseline,
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, {
            "GET /v1/contacts": 5,
            "GET /health": 3,
          }),
        ],
      ]),
    );
    expect(problems).toEqual([]);
  });

  const sizeBaseline: NetworkBaseline = {
    "/contacts": {
      depth: 2,
      requests: ["GET /v1/contacts"],
      responseSizes: { "GET /v1/contacts": 1024 },
    },
  };
  const sizeMetrics = (bytes: number, missing: Record<string, number> = {}) =>
    metrics(
      ["GET /v1/contacts"],
      2,
      {},
      undefined,
      {},
      { "GET /v1/contacts": bytes },
      missing,
    );

  test("a grown response size beyond the allowance is a problem", () => {
    // responseSizeAllowance(1024) = ceil(1024 * 1.2) = 1229.
    const { problems } = diffNetworkBaseline(
      sizeBaseline,
      new Map([["/contacts", sizeMetrics(1300)]]),
    );
    expect(problems.some((p) => p.includes("Response payload grew"))).toBe(
      true,
    );
  });

  test("response-size growth within the +20% allowance passes", () => {
    expect(responseSizeAllowance(1024)).toBe(1229);
    const { problems } = diffNetworkBaseline(
      sizeBaseline,
      new Map([["/contacts", sizeMetrics(1200)]]),
    );
    expect(problems).toEqual([]);
  });

  test("a smaller response size passes silently", () => {
    const { problems } = diffNetworkBaseline(
      sizeBaseline,
      new Map([["/contacts", sizeMetrics(10)]]),
    );
    expect(problems).toEqual([]);
  });

  test("a response size for a key without a budget is not a problem", () => {
    const { problems } = diffNetworkBaseline(
      sizeBaseline,
      new Map([
        [
          "/contacts",
          metrics(
            ["GET /v1/contacts"],
            2,
            {},
            undefined,
            {},
            { "GET /v1/contacts": 1024, "GET /health": 50 },
          ),
        ],
      ]),
    );
    expect(problems).toEqual([]);
  });

  test("a missing response size for a budgeted key is a problem", () => {
    const { problems } = diffNetworkBaseline(
      sizeBaseline,
      new Map([
        [
          "/contacts",
          metrics(
            ["GET /v1/contacts"],
            2,
            {},
            undefined,
            {},
            {},
            { "GET /v1/contacts": 1 },
          ),
        ],
      ]),
    );
    expect(problems.some((p) => p.includes("Response size missing"))).toBe(
      true,
    );
  });

  test("a request without a measured size is not a missing response-size count", () => {
    // Mirrors "a request without a response is not a missing db-query count":
    // no measurement attempt (e.g. a streamed response, excluded entirely by
    // network.ts's isStreamedResponse) is not the same as a failed one.
    const { problems } = diffNetworkBaseline(
      sizeBaseline,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 2)]]),
    );
    expect(problems).toEqual([]);
  });
});

describe("mergeNetworkBaseline", () => {
  test("no existing baseline yields a snapshot", () => {
    const merged = mergeNetworkBaseline(
      null,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 2)]]),
    );
    expect(merged).toEqual({
      "/contacts": {
        depth: 2,
        requests: ["GET /v1/contacts"],
        requestCounts: { "GET /v1/contacts": 1 },
        dbQueries: {},
        responseSizes: {},
      },
    });
  });

  test("requests accumulate as a union and depth takes the max", () => {
    const existing: NetworkBaseline = {
      "/contacts": { depth: 3, requests: ["GET /v1/contacts"] },
    };
    const merged = mergeNetworkBaseline(
      existing,
      new Map([["/contacts", metrics(["GET /v1/views/:id"], 2)]]),
    );
    expect(merged).toEqual({
      "/contacts": {
        depth: 3,
        requests: ["GET /v1/contacts", "GET /v1/views/:id"],
        requestCounts: {
          "GET /v1/contacts": 1,
          "GET /v1/views/:id": 1,
        },
        dbQueries: {},
        responseSizes: {},
      },
    });
  });

  test("request counts merge to the per-key max", () => {
    const existing: NetworkBaseline = {
      "/contacts": {
        depth: 2,
        requests: ["GET /v1/contacts"],
        requestCounts: { "GET /v1/contacts": 2 },
      },
    };
    const merged = mergeNetworkBaseline(
      existing,
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, {}, { "GET /v1/contacts": 3 }),
        ],
      ]),
    );
    expect(merged["/contacts"]?.requestCounts).toEqual({
      "GET /v1/contacts": 3,
    });
  });

  test("db-query counts merge to the per-key max", () => {
    const existing: NetworkBaseline = {
      "/contacts": {
        depth: 2,
        requests: ["GET /v1/contacts"],
        dbQueries: { "GET /v1/contacts": 5, "GET /health": 0 },
      },
    };
    const merged = mergeNetworkBaseline(
      existing,
      new Map([
        [
          "/contacts",
          metrics(["GET /v1/contacts"], 2, { "GET /v1/contacts": 3 }),
        ],
      ]),
    );
    expect(merged["/contacts"]?.dbQueries).toEqual({
      "GET /health": 0,
      "GET /v1/contacts": 5,
    });
  });

  test("response sizes merge to the per-key max, rounded up to the next KiB", () => {
    const existing: NetworkBaseline = {
      "/contacts": {
        depth: 2,
        requests: ["GET /v1/contacts"],
        responseSizes: { "GET /v1/contacts": 2048, "GET /health": 1024 },
      },
    };
    const merged = mergeNetworkBaseline(
      existing,
      new Map([
        [
          "/contacts",
          metrics(
            ["GET /v1/contacts"],
            2,
            {},
            undefined,
            {},
            { "GET /v1/contacts": 3000 },
          ),
        ],
      ]),
    );
    expect(merged["/contacts"]?.responseSizes).toEqual({
      "GET /health": 1024,
      // 3000 raw bytes rounds up to 3072 (3 KiB), same width as the writer
      // rounds a brand-new measurement to.
      "GET /v1/contacts": 3072,
    });
  });

  test("a brand-new response size is rounded up to the next KiB", () => {
    const merged = mergeNetworkBaseline(
      null,
      new Map([
        [
          "/contacts",
          metrics(
            ["GET /v1/contacts"],
            2,
            {},
            undefined,
            {},
            { "GET /v1/contacts": 1 },
          ),
        ],
      ]),
    );
    expect(merged["/contacts"]?.responseSizes).toEqual({
      "GET /v1/contacts": 1024,
    });
  });

  test("merge records the raw observed depth", () => {
    const existing: NetworkBaseline = {
      "/contacts": { depth: 2, requests: ["GET /v1/contacts"] },
    };
    const merged = mergeNetworkBaseline(
      existing,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 3)]]),
    );
    expect(merged["/contacts"]?.depth).toBe(3);
  });

  test("routes absent from the run are dropped", () => {
    const existing: NetworkBaseline = {
      "/removed": { depth: 1, requests: ["GET /v1/gone"] },
    };
    const merged = mergeNetworkBaseline(
      existing,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 1)]]),
    );
    expect(Object.keys(merged)).toEqual(["/contacts"]);
  });
});
