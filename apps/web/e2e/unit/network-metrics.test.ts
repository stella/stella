// Pure-logic tests for the network baseline metrics. These never open a page,
// so they launch no browser and need no dev server or storageState.
import { describe, expect, test } from "bun:test";

import { NETWORK_DEPTH_METHOD as SCOPE_NETWORK_DEPTH_METHOD } from "../../../../scripts/network-baseline-scope";
import {
  countDuplicateGets,
  diffNetworkBaseline,
  mergeNetworkBaseline,
  NETWORK_DEPTH_METHOD,
  type NetworkBaseline,
  normalizeApiPath,
  responseSizeAllowance,
  type RouteNetworkMetrics,
  summarizeCapture,
  waitForQuietPeriod,
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

describe("duplicate resource reads", () => {
  const request = (url: string, startedAt: number, method = "GET") => ({
    method,
    url: `http://localhost:3001${url}`,
    startedAt,
  });

  test("counts every excess GET in the inclusive two-second window", () => {
    expect(
      countDuplicateGets([
        request("/v1/chat/threads?limit=20", 0),
        request("/v1/chat/threads?limit=20", 2000),
        request("/v1/chat/threads?limit=20", 2001),
        request("/v1/chat/threads?limit=20", 4002),
      ]),
    ).toEqual({ "GET /v1/chat/threads?limit=20": 2 });
  });

  test("normalizes query ordering while keeping resources and query values distinct", () => {
    expect(
      countDuplicateGets([
        request(`/v1/tasks/${UUID}?limit=10&cursor=a`, 0),
        request(`/v1/tasks/${UUID}?cursor=a&limit=10`, 10),
        request(`/v1/tasks/${UUID_UPPER}?cursor=a&limit=10`, 20),
        request(`/v1/tasks/${UUID}?cursor=b&limit=10`, 30),
        request(`/v1/tasks/${UUID}?cursor=a&limit=20`, 40),
      ]),
    ).toEqual({ [`GET /v1/tasks/${UUID}?cursor=a&limit=10`]: 1 });
  });

  test("capture summaries retain exact duplicate diagnostics", () => {
    const duplicateGetCounts = countDuplicateGets([
      request("/v1/organization-settings/ai-availability", 0),
      request("/v1/organization-settings/ai-availability", 100),
    ]);
    expect(
      summarizeCapture({ requests: [], depthChain: [], duplicateGetCounts })
        .duplicateGetCounts,
    ).toEqual({ "GET /v1/organization-settings/ai-availability": 1 });
  });

  test("does not count writes or reads outside the window", () => {
    expect(
      countDuplicateGets([
        request("/v1/tasks", 0, "POST"),
        request("/v1/tasks", 1, "POST"),
        request("/v1/tasks", 2),
        request("/v1/tasks", 2003),
      ]),
    ).toEqual({});
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
    "/contacts": {
      depth: 2,
      depthMethod: NETWORK_DEPTH_METHOD,
      requests: ["GET /v1/contacts"],
    },
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

  test.each([undefined, "timing-v1"])(
    "a different depth method reports depth only and retains every other budget (%s)",
    (depthMethod) => {
      const entry = {
        depth: 1,
        ...(depthMethod === undefined ? {} : { depthMethod }),
        requests: ["GET /v1/contacts"],
        requestCounts: { "GET /v1/contacts": 1 },
        dbQueries: { "GET /v1/contacts": 1 },
        responseSizes: { "GET /v1/contacts": 1024 },
      };
      const depthOnly = diffNetworkBaseline(
        { "/contacts": entry },
        new Map([["/contacts", metrics(entry.requests, 5)]]),
      );
      expect(depthOnly.problems).toEqual([]);
      expect(depthOnly.notices.join("\n")).toContain(
        "observed depth 5 (baseline 1)",
      );
      expect(depthOnly.notices.join("\n")).toContain("method differs");
      const increased = diffNetworkBaseline(
        { "/contacts": entry },
        new Map([
          [
            "/contacts",
            metrics(
              ["GET /v1/contacts", "GET /v1/new"],
              5,
              { "GET /v1/contacts": 20 },
              { "GET /v1/contacts": 3, "GET /v1/new": 1 },
              {},
              { "GET /v1/contacts": 100_000 },
            ),
          ],
        ]),
      );
      expect(increased.problems).toHaveLength(4);
      expect(
        increased.problems.some((problem) => problem.includes("waterfall")),
      ).toBe(false);
    },
  );

  test("duplicate GETs fail even when endpoint repeat budgets permit them", () => {
    const key = "GET /v1/contacts";
    const { problems } = diffNetworkBaseline(
      {
        "/contacts": {
          depth: 2,
          depthMethod: NETWORK_DEPTH_METHOD,
          requests: [key],
          requestCounts: { [key]: 2 },
        },
      },
      new Map([
        [
          "/contacts",
          {
            ...metrics([key], 2, {}, { [key]: 2 }),
            duplicateGetCounts: { [key]: 1 },
          },
        ],
      ]),
    );
    expect(problems).toHaveLength(1);
    expect(problems.at(0)).toContain("Duplicate API GET on /contacts");
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
          depthMethod: NETWORK_DEPTH_METHOD,
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

test("declarations use the depth method the route smoke measures", () => {
  // The baseline scope script runs install-free, so it keeps its own copy.
  expect(SCOPE_NETWORK_DEPTH_METHOD).toBe(NETWORK_DEPTH_METHOD);
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
        depthMethod: NETWORK_DEPTH_METHOD,
        requests: ["GET /v1/contacts"],
        requestCounts: { "GET /v1/contacts": 1 },
        dbQueries: {},
        responseSizes: {},
      },
    });
  });

  test.each([undefined, "timing-v1"])(
    "recording replaces incompatible depth and retains other budgets (%s)",
    (depthMethod) => {
      const previous = {
        depth: 9,
        ...(depthMethod === undefined ? {} : { depthMethod }),
        requests: ["GET /v1/contacts"],
        requestCounts: { "GET /v1/contacts": 3 },
        dbQueries: { "GET /v1/contacts": 7 },
        responseSizes: { "GET /v1/contacts": 4096 },
      };
      const recorded = mergeNetworkBaseline(
        { "/contacts": previous },
        new Map([["/contacts", metrics(previous.requests, 2)]]),
      );
      expect(recorded["/contacts"]).toEqual({
        ...previous,
        depth: 2,
        depthMethod: NETWORK_DEPTH_METHOD,
      });
    },
  );

  test("a lower timing sample never tightens a declared depth", () => {
    // A declaration is stamped with the current method when it is applied.
    const declared: NetworkBaseline = {
      "/views": {
        depth: 9,
        depthMethod: NETWORK_DEPTH_METHOD,
        requests: ["GET /v1/views/:id"],
      },
    };
    const recorded = mergeNetworkBaseline(
      declared,
      new Map([["/views", metrics(["GET /v1/views/:id"], 6)]]),
    );
    expect(recorded["/views"]?.depth).toBe(9);
    // A later, ordinary sample within the declared budget still passes.
    const { problems } = diffNetworkBaseline(
      recorded,
      new Map([["/views", metrics(["GET /v1/views/:id"], 7)]]),
    );
    expect(problems).toEqual([]);
  });

  test("requests accumulate as a union and depth takes the max", () => {
    const existing: NetworkBaseline = {
      "/contacts": {
        depth: 3,
        depthMethod: NETWORK_DEPTH_METHOD,
        requests: ["GET /v1/contacts"],
      },
    };
    const merged = mergeNetworkBaseline(
      existing,
      new Map([["/contacts", metrics(["GET /v1/views/:id"], 2)]]),
    );
    expect(merged).toEqual({
      "/contacts": {
        depth: 3,
        depthMethod: NETWORK_DEPTH_METHOD,
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
        depthMethod: NETWORK_DEPTH_METHOD,
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
        depthMethod: NETWORK_DEPTH_METHOD,
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
        depthMethod: NETWORK_DEPTH_METHOD,
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
      "/contacts": {
        depth: 2,
        depthMethod: NETWORK_DEPTH_METHOD,
        requests: ["GET /v1/contacts"],
      },
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
    depthMethod: NETWORK_DEPTH_METHOD,
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
