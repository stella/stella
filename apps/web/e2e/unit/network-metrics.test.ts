import { panic } from "better-result";
// Pure-logic tests for the network baseline metrics. These never open a page,
// so they launch no browser and need no dev server or storageState.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  WATERFALL_REQUEST_DELAY_MS,
  type NetworkBaseline,
  type RouteNetworkMetrics,
  browserRequestInterval,
  countsTowardsWaterfall,
  deepestWaterfallSequence,
  diffNetworkBaseline,
  mergeNetworkBaseline,
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

describe("controlled launch waves", () => {
  test("empty input has no levels", () => {
    expect(waterfallDepth([])).toBe(0);
    expect(deepestWaterfallSequence([])).toEqual([]);
  });

  test("a faster response never adds a launch level", () => {
    // Mutation: the old response-overlap rule returns 1 then 2 and must fail.
    for (const end of [100, 80]) {
      const intervals = [
        { start: 0, end, key: "a" },
        { start: 90, end: 200, key: "b" },
      ];
      expect(waterfallDepth(intervals)).toBe(1);
      expect(deepestWaterfallSequence(intervals)).toEqual([["a", "b"]]);
    }
  });

  test("invoices waves keep depth across server times and launch jitter", () => {
    const waves = [
      ["get-session"],
      ["professional-use"],
      ["workspace", "preferences", "billing"],
      ["get-active-member-role"],
      [
        "invoices",
        "contacts",
        "accounts",
        "tax-rates",
        "currencies",
        "templates",
      ],
    ];
    const requestCount = waves.flat().length;
    assertProperty(
      "invoices waves keep depth across server times and launch jitter",
      fc.property(
        fc.array(
          fc.record({
            serverMs: fc.integer({ min: 0, max: 200 }),
            jitterMs: fc.integer({
              min: 0,
              max: WATERFALL_REQUEST_DELAY_MS / 2 - 1,
            }),
            processingMs: fc.integer({ min: 10, max: 100 }),
          }),
          { minLength: requestCount, maxLength: requestCount },
        ),
        (samples) => {
          let offset = 0;
          let waveStart = 0;
          const intervals = waves.flatMap((wave) => {
            const launched = wave.map((key) => {
              const sample = samples.at(offset++);
              if (sample === undefined) {
                panic("generator must supply every request");
              }
              const start = waveStart + sample.jitterMs;
              return {
                start,
                end: start + WATERFALL_REQUEST_DELAY_MS + sample.serverMs,
                key,
                processingMs: sample.processingMs,
              };
            });
            // Includes parsing, query settling, rendering and mounting after the response.
            waveStart = Math.max(
              ...launched.map(({ end, processingMs }) => end + processingMs),
            );
            return launched;
          });
          expect(waterfallDepth(intervals)).toBe(5);
          expect(
            deepestWaterfallSequence(intervals).map((level) =>
              level.toSorted(),
            ),
          ).toEqual(waves.map((wave) => wave.toSorted()));
          expect(
            deepestWaterfallSequence(intervals.toReversed()).map((level) =>
              level.toSorted(),
            ),
          ).toEqual(waves.map((wave) => wave.toSorted()));
          expect(
            waterfallDepth(
              intervals.map((interval) => ({
                ...interval,
                end: interval.end + 10_000,
              })),
            ),
          ).toBe(5);
        },
      ),
    );
  });

  test("arbitrary request graphs preserve launch depth across response speeds", () => {
    assertProperty(
      "arbitrary request graphs preserve launch depth across response speeds",
      fc.property(
        fc.array(
          fc.array(
            fc.record({
              jitterMs: fc.integer({
                min: 0,
                max: WATERFALL_REQUEST_DELAY_MS / 2 - 1,
              }),
              serverMs: fc.integer({ min: 0, max: 200 }),
            }),
            { minLength: 1, maxLength: 8 },
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (waves) => {
          let waveStart = 0;
          const intervals = waves.flatMap((wave) => {
            const launched = wave.map(({ jitterMs, serverMs }) => {
              const start = waveStart + jitterMs;
              return {
                start,
                end: start + WATERFALL_REQUEST_DELAY_MS + serverMs,
              };
            });
            waveStart = Math.max(...launched.map(({ end }) => end)) + 100;
            return launched;
          });
          expect(waterfallDepth(intervals)).toBe(waves.length);
          expect(
            waterfallDepth(
              intervals.map(({ start }) => ({ start, end: start + 1 })),
            ),
          ).toBe(waves.length);
        },
      ),
    );
  });

  test("clusters anchor at the first launch instead of chaining adjacent jitter", () => {
    expect(
      waterfallDepth([
        { start: 0, end: 1000 },
        { start: 100, end: 1100 },
        { start: 200, end: 1200 },
      ]),
    ).toBe(2);
  });

  test("the launch threshold is half the injected request delay", () => {
    const threshold = WATERFALL_REQUEST_DELAY_MS / 2;
    expect(
      deepestWaterfallSequence([
        { start: 0, end: 1000, key: "first" },
        { start: threshold - 1, end: 1000, key: "parallel" },
        { start: threshold, end: 1000, key: "next" },
      ]),
    ).toEqual([["first", "parallel"], ["next"]]);
  });

  test("dependent processing can exceed five milliseconds", () => {
    expect(
      waterfallDepth([
        { start: 0, end: 250 },
        { start: 350, end: 600 },
        { start: 700, end: 950 },
      ]),
    ).toBe(3);
  });

  test("idle prefetch splits after delay plus processing; deepest sequence wins", () => {
    const intervals = [
      { start: 0, end: 250, key: "a" },
      { start: 600, end: 850, key: "b" },
      { start: 1200, end: 1450, key: "c" },
      { start: 3000, end: 3250, key: "prefetch" },
      { start: 3300, end: 3550, key: "prefetch-child" },
    ];
    expect(deepestWaterfallSequence(intervals)).toEqual([["a"], ["b"], ["c"]]);
    expect(waterfallDepth(intervals)).toBe(3);
  });

  test("equal-depth sequences keep the earliest chain", () => {
    expect(
      deepestWaterfallSequence([
        { start: 0, end: 250, key: "first" },
        { start: 300, end: 550, key: "second" },
        { start: 2000, end: 2250, key: "late" },
        { start: 2300, end: 2550, key: "later" },
      ]),
    ).toEqual([["first"], ["second"]]);
  });

  test("keyless requests still contribute levels", () => {
    expect(
      deepestWaterfallSequence([
        { start: 0, end: 250 },
        { start: 300, end: 550 },
      ]),
    ).toEqual([[], []]);
  });
});

describe("countsTowardsWaterfall", () => {
  test("keeps streamed requests in coverage without counting a load round", () => {
    expect(
      countsTowardsWaterfall({
        pathname: "/v1/events",
        resourceType: "eventsource",
        streamed: true,
      }),
    ).toBe(false);
    expect(
      countsTowardsWaterfall({
        pathname: "/v1/chat",
        resourceType: "fetch",
        streamed: true,
      }),
    ).toBe(false);
  });

  test("keeps the version poll in coverage without counting a load round", () => {
    expect(
      countsTowardsWaterfall({
        pathname: "/health",
        resourceType: "fetch",
        streamed: false,
      }),
    ).toBe(false);
  });

  test("counts finite API responses", () => {
    expect(
      countsTowardsWaterfall({
        pathname: "/v1/templates",
        resourceType: "fetch",
        streamed: false,
      }),
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
  requests: [...requests].toSorted(),
  requestCounts,
  depth,
  depthChain: [],
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

  test("a deeper waterfall names the chain that produced it", () => {
    const { problems } = diffNetworkBaseline(
      baseline,
      new Map([
        [
          "/contacts",
          {
            ...metrics(["GET /v1/contacts", "GET /v1/contacts/:id"], 3),
            depthChain: [
              ["GET /v1/contacts"],
              ["GET /v1/contacts/:id", "GET /v1/labels"],
              ["GET /v1/entities"],
            ],
          },
        ],
      ]),
    );
    const deeper = problems.find((problem) =>
      problem.startsWith("Request waterfall got deeper"),
    );

    expect(deeper).toContain("  level 1: GET /v1/contacts\n");
    expect(deeper).toContain(
      "  level 2: GET /v1/contacts/:id, GET /v1/labels\n",
    );
    expect(deeper).toContain("  level 3: GET /v1/entities\n");
    // The actionable hint still closes the message.
    expect(deeper).toContain("network-budgets/<change>.json");
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

describe("merge-base scoped comparison", () => {
  const entry = {
    depth: 1,
    requests: ["GET /v1/contacts"],
    dbQueries: { "GET /v1/contacts": 2 },
    responseSizes: { "GET /v1/contacts": 1024 },
  };
  const baseline = { "/contacts": entry };

  test("new scoped routes are reported while unknown unchanged routes fail", () => {
    const results = new Map([["/new", metrics(["GET /v1/new"], 1)]]);
    const scoped = diffNetworkBaseline(baseline, results, {
      changedRoutes: ["/new"],
      requireAllRoutes: false,
    });
    expect(scoped.problems).toEqual([]);
    expect(scoped.notices.join("\n")).toContain("New scoped route /new");
    expect(
      diffNetworkBaseline(baseline, results, {
        requireAllRoutes: false,
      }).problems.join("\n"),
    ).toContain("New route not in");
  });

  test("only scoped deletions may disappear from coverage", () => {
    expect(
      diffNetworkBaseline(baseline, new Map(), { changedRoutes: ["/contacts"] })
        .problems,
    ).toEqual([]);
    expect(
      diffNetworkBaseline(baseline, new Map()).problems.join("\n"),
    ).toContain("Stale network baseline entry");
  });

  test.each([
    metrics(["GET /v1/contacts", "GET /v1/new"], 1),
    metrics(["GET /v1/contacts"], 4),
    metrics(["GET /v1/contacts"], 1, {}, { "GET /v1/contacts": 3 }),
    metrics(["GET /v1/contacts"], 1, { "GET /v1/contacts": 20 }),
    metrics(
      ["GET /v1/contacts"],
      1,
      {},
      undefined,
      {},
      { "GET /v1/contacts": 100_000 },
    ),
  ])(
    "route changes never exempt existing request, depth, repeat, DB or size budgets",
    (observed) => {
      const results = new Map([["/contacts", observed]]);
      const strict = diffNetworkBaseline(baseline, results);
      expect(strict.problems.length).toBeGreaterThan(0);
      expect(
        diffNetworkBaseline(baseline, results, { changedRoutes: ["/contacts"] })
          .problems,
      ).toEqual(strict.problems);
    },
  );

  test("an intentional increase passes only with the declared budget", () => {
    const observed = metrics(["GET /v1/contacts", "GET /v1/new"], 1);
    const results = new Map([["/contacts", observed]]);
    expect(
      diffNetworkBaseline(baseline, results).problems.join("\n"),
    ).toContain("New API request");
    expect(
      diffNetworkBaseline(
        { "/contacts": { ...entry, requests: observed.requests } },
        results,
      ).problems,
    ).toEqual([]);
  });
});
