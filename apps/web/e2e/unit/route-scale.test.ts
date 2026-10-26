import { describe, expect, test } from "bun:test";
import { ValiError } from "valibot";

import type { RouteNetworkMetrics } from "../helpers/network";
import type { RouteRenderMetrics } from "../helpers/render-census";
import {
  compareRouteScale as compareMeasuredRouteScale,
  parseRouteScaleLedger,
  RENDER_COMMIT_FLOOR,
  renderCommitAllowance,
  routeScaleCensus,
  routeScaleLedgerMembership,
} from "../helpers/route-scale";
import type { RouteScaleMeasurement } from "../helpers/route-scale";
import { addedLedgerEntries } from "../helpers/route-scale-ledger";

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
const renderMetrics = (): RouteRenderMetrics => ({
  renderers: 1,
  commits: 40,
  dataCommits: 25,
  roundCommits: [15, 30],
});
type CompareOptions = Parameters<typeof compareMeasuredRouteScale>[0];
// Network cases hold renders steady on both worlds.
const compareRouteScale = ({
  renders = { small: renderMetrics(), large: renderMetrics() },
  ...options
}: Omit<CompareOptions, "renders"> & { renders?: CompareOptions["renders"] }) =>
  compareMeasuredRouteScale({ ...options, renders });
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
    ).toThrow("Route-level allowances, and only they, use $route");
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
    expect(addedLedgerEntries(tighter, original)).toEqual([]);
    expect(addedLedgerEntries([], original)).toEqual([]);
    expect(addedLedgerEntries([], null)).toEqual([]);
    expect(addedLedgerEntries(original, null)).toEqual(original);
    expect(addedLedgerEntries(wider, original)).toHaveLength(1);
    const other = routeScaleLedgerMembership(
      JSON.stringify([{ ...allowance, route: "/new" }]),
    );
    expect(addedLedgerEntries(other, original)).toHaveLength(2);
  });
});

describe("matter scale renders", () => {
  // metrics() makes one request, so the route may grow by the floor plus one.
  const allowed = renderCommitAllowance(1);
  const compareRenders = (
    large: Partial<RouteRenderMetrics>,
    ledger: Parameters<typeof compareRouteScale>[0]["ledger"] = [],
  ) =>
    compareRouteScale({
      route,
      small: metrics(),
      large: metrics(),
      renders: {
        small: renderMetrics(),
        large: { ...renderMetrics(), ...large },
      },
      ledger,
    });

  test("the allowance is a floor plus one commit per response", () => {
    expect(allowed).toBe(RENDER_COMMIT_FLOOR + 1);
    const large = metrics();
    large.requestCounts[request] = 6;
    const small = metrics();
    small.requestCounts[request] = 6;
    const base = renderMetrics();
    expect(
      compareMeasuredRouteScale({
        route,
        small,
        large,
        renders: {
          small: base,
          large: { ...base, commits: base.commits + RENDER_COMMIT_FLOOR + 6 },
        },
        ledger: [],
      }).filter((problem) => problem.includes("render")),
    ).toEqual([]);
  });

  test("accepts timing jitter within the allowance and fewer commits", () => {
    const base = renderMetrics();
    expect(
      compareRenders({
        commits: base.commits + allowed,
        dataCommits: base.dataCommits + allowed,
      }),
    ).toEqual([]);
    expect(compareRenders({ commits: 1, dataCommits: 0 })).toEqual([]);
  });

  test("a commit per extra row fails both render dimensions", () => {
    const base = renderMetrics();
    // 100 -> 1000 rows, one commit each.
    const problems = compareRenders({
      commits: base.commits + 900,
      dataCommits: base.dataCommits + 900,
    }).join("\n");
    expect(problems).toContain(
      `renderCommits $route: small=40, large=940, allowed growth=${String(allowed)}`,
    );
    expect(problems).toContain("dataRenderCommits $route: small=25, large=925");
    // One commit over the allowance is already a failure.
    expect(
      compareRenders({ dataCommits: base.dataCommits + allowed + 1 }).join(
        "\n",
      ),
    ).toContain("dataRenderCommits");
  });

  test("a census React never reported to fails instead of comparing zeros", () => {
    for (const missing of [
      { renderers: 0 },
      { commits: 0, dataCommits: 0, roundCommits: [] },
    ]) {
      expect(compareRenders(missing).join("\n")).toContain(
        "large render evidence missing",
      );
    }
  });

  test("a scoped render allowance admits its route, then goes stale", () => {
    const rendersAllowance = {
      route,
      dimension: "dataRenderCommits",
      request: "$route",
      owner: "entities",
      reason: "The grid measures each visible column once after data arrives.",
      max: 30,
    } as const;
    const base = renderMetrics();
    expect(
      compareRenders({ dataCommits: base.dataCommits + 30 }, [
        rendersAllowance,
      ]),
    ).toEqual([]);
    expect(
      compareRenders({ dataCommits: base.dataCommits + 31 }, [
        rendersAllowance,
      ]).join("\n"),
    ).toContain("allowed growth=30");
    expect(compareRenders({}, [rendersAllowance]).join("\n")).toContain(
      "stale scale allowance dataRenderCommits",
    );
  });

  test("render allowances are route-level and exceed the floor", () => {
    const row = {
      route,
      dimension: "renderCommits",
      request: "$route",
      owner: "entities",
      reason: "The grid measures each visible column once after data arrives.",
      max: RENDER_COMMIT_FLOOR + 1,
    };
    expect(parseRouteScaleLedger(JSON.stringify([row]))).toHaveLength(1);
    expect(() =>
      parseRouteScaleLedger(JSON.stringify([{ ...row, request }])),
    ).toThrow("Route-level allowances, and only they, use $route");
    expect(() =>
      parseRouteScaleLedger(
        JSON.stringify([{ ...row, max: RENDER_COMMIT_FLOOR }]),
      ),
    ).toThrow("Render commit allowance must exceed the floor");
  });
});

describe("matter scale census", () => {
  const measured = (): RouteScaleMeasurement => ({
    network: metrics(),
    renders: renderMetrics(),
  });
  const routes = [route, "/$workspaceId/contacts"];
  const complete = () => new Map(routes.map((each) => [each, measured()]));

  test("passes when every enrolled route was measured on both worlds", () => {
    expect(
      routeScaleCensus({
        routes,
        small: complete(),
        large: complete(),
        ledger: [],
      }),
    ).toEqual([]);
  });

  test("a route missing from either world fails the census", () => {
    for (const world of ["small", "large"] as const) {
      const worlds = { small: complete(), large: complete() };
      worlds[world].delete("/$workspaceId/contacts");
      expect(routeScaleCensus({ routes, ...worlds, ledger: [] })).toEqual([
        "Missing paired route measurement: /$workspaceId/contacts",
      ]);
    }
  });

  test("compares renders of every route it walks", () => {
    const large = complete();
    const contacts = measured();
    contacts.renders.commits += 900;
    large.set("/$workspaceId/contacts", contacts);
    expect(
      routeScaleCensus({ routes, small: complete(), large, ledger: [] }).join(
        "\n",
      ),
    ).toContain("/$workspaceId/contacts: renderCommits");
  });
});
