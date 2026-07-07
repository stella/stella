// Pure-logic tests for the network baseline metrics. These never open a page,
// so they launch no browser and need no dev server or storageState.
import { expect, test } from "@playwright/test";

import {
  type NetworkBaseline,
  type RouteNetworkMetrics,
  diffNetworkBaseline,
  mergeNetworkBaseline,
  normalizeApiPath,
  waterfallDepth,
} from "../helpers/network";

const UUID = "11111111-2222-4333-8444-555555555555";
const UUID_UPPER = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";

test.describe("normalizeApiPath", () => {
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

test.describe("waterfallDepth", () => {
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

  test("a strict chain is n rounds", () => {
    expect(
      waterfallDepth([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 20, end: 30 },
      ]),
    ).toBe(3);
  });

  test("mixed overlap counts only the sequential rounds", () => {
    // Two parallel at the start, then one that waits for both.
    expect(
      waterfallDepth([
        { start: 0, end: 10 },
        { start: 0, end: 12 },
        { start: 12, end: 20 },
      ]),
    ).toBe(2);
  });

  test("an independent late request does not chain", () => {
    // Gap between the first response and the late request exceeds the causal
    // window, so this is an idle prefetch, not a waterfall round.
    expect(
      waterfallDepth([
        { start: 0, end: 10 },
        { start: 800, end: 900 },
      ]),
    ).toBe(1);
  });

  test("a pending tail (end = now) extends the chain by one", () => {
    const now = 1000;
    expect(
      waterfallDepth([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 20, end: now },
      ]),
    ).toBe(3);
  });
});

const metrics = (
  requests: string[],
  depth: number,
  dbQueries: Record<string, number> = {},
): RouteNetworkMetrics => ({
  requests: [...requests].sort(),
  depth,
  dbQueries,
});

test.describe("diffNetworkBaseline", () => {
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

  test("a deeper waterfall is a problem", () => {
    const { problems } = diffNetworkBaseline(
      baseline,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 3)]]),
    );
    expect(problems.some((p) => p.includes("2 -> 3"))).toBe(true);
  });

  test("a stale baseline entry is a problem", () => {
    const { problems } = diffNetworkBaseline(baseline, new Map());
    expect(problems.some((p) => p.includes("Stale"))).toBe(true);
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
});

test.describe("mergeNetworkBaseline", () => {
  test("no existing baseline yields a snapshot", () => {
    const merged = mergeNetworkBaseline(
      null,
      new Map([["/contacts", metrics(["GET /v1/contacts"], 2)]]),
    );
    expect(merged).toEqual({
      "/contacts": { depth: 2, requests: ["GET /v1/contacts"], dbQueries: {} },
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
        dbQueries: {},
      },
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
