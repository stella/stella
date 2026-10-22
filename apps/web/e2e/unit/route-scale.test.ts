import { describe, expect, test } from "bun:test";
import { ValiError } from "valibot";

import { addedEntries } from "../../../../scripts/ledger-membership";
import type { RouteNetworkMetrics } from "../helpers/network";
import {
  compareRouteScale,
  parseRouteScaleLedger,
  routeScaleLedgerMembership,
} from "../helpers/route-scale";

const request = "GET /v1/entities";
const route = "/$workspaceId/entities";
const metrics = (): RouteNetworkMetrics => ({
  requests: [request],
  requestCounts: { [request]: 1 },
  depth: 1,
  depthChain: [[request]],
  dbQueries: { [request]: 3 },
  missingDbQueryCounts: {},
  transactions: { [request]: 1 },
  missingTransactionCounts: {},
  responseSizes: { [request]: 2048 },
  missingResponseSizeCounts: {},
  requestCosts: {
    [request]: [{ dbQueries: 3, transactions: 1, responseBytes: 2048 }],
  },
});
const compare = (large: RouteNetworkMetrics) =>
  compareRouteScale({ route, small: metrics(), large, ledger: [] });
const allowance = {
  route,
  dimension: "dbQueries",
  request,
  owner: "entities",
  reason: "The entity projection requires a separate query per page.",
  max: 2,
} as const;

describe("matter scale cost", () => {
  test("accepts equal counters and bounded page bytes", () => {
    const large = metrics();
    large.responseSizes[request] = 4096;
    expect(compare(large)).toEqual([]);
  });
  for (const dimension of [
    "requestCounts",
    "dbQueries",
    "transactions",
  ] as const) {
    test(`detects ${dimension} growth and shrinkage`, () => {
      for (const delta of [-1, 1, 9]) {
        const large = metrics();
        const before = large[dimension][request];
        expect(before).toBeDefined();
        large[dimension][request] = (before ?? 0) + delta;
        expect(compare(large).join("\n")).toContain(dimension);
      }
    });
  }
  test("detects deeper navigation and an unbounded response", () => {
    const large = metrics();
    large.depth = 2;
    large.responseSizes[request] = 20_480;
    expect(compare(large).join("\n")).toContain("depth");
    expect(compare(large).join("\n")).toContain("responseSizes");
  });
  test("allows small metadata differences within the byte floor", () => {
    const small = metrics();
    const large = metrics();
    small.responseSizes[request] = 10;
    large.responseSizes[request] = 2048;
    expect(compareRouteScale({ route, small, large, ledger: [] })).toEqual([]);
    large.responseSizes[request] = 2049;
    expect(
      compareRouteScale({ route, small, large, ledger: [] }).join("\n"),
    ).toContain("responseSizes");
  });
  test("detects additional normalized request keys", () => {
    const large = metrics();
    large.requests.push("GET /v1/contacts");
    large.requestCounts["GET /v1/contacts"] = 9;
    expect(compare(large).join("\n")).toContain(
      "requestCounts GET /v1/contacts",
    );
  });
  test("rejects missing count headers and unread bodies", () => {
    const large = metrics();
    large.missingDbQueryCounts[request] = 1;
    large.missingTransactionCounts[request] = 1;
    large.missingResponseSizeCounts[request] = 1;
    expect(
      compare(large).filter((problem) => problem.includes("evidence missing")),
    ).toHaveLength(3);
    large.dbQueries = {};
    large.transactions = {};
    expect(
      compare(large).filter((problem) => problem.includes("evidence absent")),
    ).toHaveLength(2);
  });
  test("rejects identically absent response counts even when a sibling has evidence", () => {
    const small = metrics();
    const large = metrics();
    for (const world of [small, large]) {
      world.requestCounts[request] = 2;
      world.requestCosts[request]?.push({
        dbQueries: null,
        transactions: null,
        responseBytes: null,
      });
    }
    expect(
      compareRouteScale({ route, small, large, ledger: [] }).filter((problem) =>
        problem.includes("request count evidence incomplete"),
      ),
    ).toHaveLength(2);
  });
  test("examines every request when the normalized maximum stays fixed", () => {
    const small = metrics();
    const large = metrics();
    for (const world of [small, large]) {
      world.requestCounts[request] = 2;
      world.dbQueries[request] = 10;
      world.transactions[request] = 10;
      world.responseSizes[request] = 20_480;
      world.requestCosts[request]?.push({
        dbQueries: 10,
        transactions: 10,
        responseBytes: 20_480,
      });
    }
    large.requestCosts[request] = [
      { dbQueries: 9, transactions: 9, responseBytes: 19_000 },
      { dbQueries: 10, transactions: 10, responseBytes: 20_480 },
    ];
    const problems = compareRouteScale({
      route,
      small,
      large,
      ledger: [],
    }).join("\n");
    for (const dimension of ["dbQueries", "transactions", "responseSizes"]) {
      expect(problems).toContain(dimension);
    }
  });
  test("enforces scoped allowances, their maxima, and removal after improvement", () => {
    const large = metrics();
    large.dbQueries[request] = 5;
    const ledger = [allowance];
    expect(
      compareRouteScale({ route, small: metrics(), large, ledger }),
    ).toEqual([]);
    large.dbQueries[request] = 6;
    expect(
      compareRouteScale({ route, small: metrics(), large, ledger }).join("\n"),
    ).toContain("allowed delta=2");
    expect(
      compareRouteScale({
        route,
        small: metrics(),
        large: metrics(),
        ledger,
      }).join("\n"),
    ).toContain("stale scale allowance");
    expect(
      compareRouteScale({
        route: "/other",
        small: metrics(),
        large: metrics(),
        ledger,
      }),
    ).toEqual([]);
  });
});

describe("scale ledger", () => {
  test("requires an owner, reason, unique scope, and a meaningful bound", () => {
    expect(parseRouteScaleLedger("[]")).toEqual([]);
    for (const row of [
      { ...allowance, owner: "" },
      { ...allowance, reason: " " },
      { ...allowance, max: 0 },
    ]) {
      expect(() => parseRouteScaleLedger(JSON.stringify([row]))).toThrow(
        ValiError,
      );
    }
    expect(() =>
      parseRouteScaleLedger(
        JSON.stringify([{ ...allowance, dimension: "responseSizes", max: 2 }]),
      ),
    ).toThrow("Response size allowance must exceed");
    expect(() =>
      parseRouteScaleLedger(
        JSON.stringify([{ ...allowance, dimension: "depth" }]),
      ),
    ).toThrow("Depth allowances must use");
    expect(() =>
      parseRouteScaleLedger(JSON.stringify([allowance, allowance])),
    ).toThrow("Duplicate route scale allowance");
  });
  test("membership permits removal and rejects additions or widening", () => {
    const original = routeScaleLedgerMembership(JSON.stringify([allowance]));
    const tighter = routeScaleLedgerMembership(
      JSON.stringify([{ ...allowance, max: 1 }]),
    );
    const wider = routeScaleLedgerMembership(
      JSON.stringify([{ ...allowance, max: 3 }]),
    );
    expect(addedEntries(tighter, original)).toEqual([]);
    expect(addedEntries([], original)).toEqual([]);
    expect(addedEntries(wider, original)).toHaveLength(1);
    const other = routeScaleLedgerMembership(
      JSON.stringify([{ ...allowance, route: "/new" }]),
    );
    expect(addedEntries(other, original)).toHaveLength(2);
  });
});
