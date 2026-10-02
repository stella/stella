import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { diffNetworkBaseline } from "../apps/web/e2e/helpers/network";
import { prepareComparisonBaseline } from "./network-baseline-scope";

const routeTree = readFileSync(
  new URL("../apps/web/src/routeTree.gen.ts", import.meta.url),
  "utf-8",
);

test("only a validated declaration permits measured growth", () => {
  const old = {
    depth: 1,
    requests: ["GET /old"],
    dbQueries: { "GET /old": 2 },
    responseSizes: { "GET /old": 1024 },
  };
  const results = new Map([
    [
      "/chat",
      {
        depth: 1,
        requests: ["GET /new", "GET /old"],
        requestCounts: { "GET /old": 1, "GET /new": 1 },
        depthChain: [],
        dbQueries: { "GET /old": 2 },
        missingDbQueryCounts: {},
        responseSizes: { "GET /old": 1024 },
        missingResponseSizeCounts: {},
      },
    ],
  ]);
  const common = {
    base: { "/chat": old },
    changedPaths: [],
    baseRouteTree: routeTree,
    routeTree,
  };
  const unchanged = prepareComparisonBaseline({
    ...common,
    declarations: [],
  });
  expect(
    diffNetworkBaseline(unchanged.baseline, results, {
      changedRoutes: unchanged.changedRoutes,
    }).problems.join("\n"),
  ).toContain("New API request");
  const reviewed = prepareComparisonBaseline({
    ...common,
    declarations: [
      {
        route: "/chat",
        reason: "New endpoint",
        budget: { ...old, requests: ["GET /new", "GET /old"] },
      },
    ],
  });
  expect(
    diffNetworkBaseline(reviewed.baseline, results, {
      changedRoutes: reviewed.changedRoutes,
    }).problems,
  ).toEqual([]);
});

test("mutation proof: scoped-route growth still fails its budget assertion", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "network-budget-mutation-"),
  );
  const root = path.join(import.meta.dirname, "..");
  const source = readFileSync(
    path.join(root, "apps/web/e2e/helpers/network.ts"),
    "utf-8",
  );
  const mutant = source.replace(
    "    pushNewRequestProblems({ route, entry, metrics, problems });",
    "    if (!changedRoutes.includes(route)) { pushNewRequestProblems({ route, entry, metrics, problems }); }",
  );
  expect(mutant).not.toBe(source);
  const fixture = {
    baseline: { "/chat": { depth: 1, requests: ["GET /old"] } },
    observed: {
      depth: 1,
      requests: ["GET /new", "GET /old"],
      requestCounts: { "GET /old": 1, "GET /new": 1 },
      depthChain: [],
      dbQueries: {},
      missingDbQueryCounts: {},
      responseSizes: {},
      missingResponseSizeCounts: {},
    },
  };
  expect(
    diffNetworkBaseline(
      fixture.baseline,
      new Map([["/chat", fixture.observed]]),
      { changedRoutes: ["/chat"] },
    ).problems.join("\n"),
  ).toContain("New API request");
  try {
    symlinkSync(
      path.join(root, "apps/web/node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    const file = path.join(directory, "network.ts");
    writeFileSync(file, mutant);
    const result = Bun.spawnSync([
      "bun",
      "-e",
      `import {expect} from "bun:test"; import {diffNetworkBaseline} from ${JSON.stringify(file)}; const fixture = ${JSON.stringify(fixture)}; expect(diffNetworkBaseline(fixture.baseline, new Map([["/chat", fixture.observed]]), {changedRoutes: ["/chat"]}).problems).not.toEqual([]);`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "expect(received).not.toEqual(expected)",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
