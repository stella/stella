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

import {
  diffNetworkBaseline,
  mergeNetworkBaseline,
} from "../apps/web/e2e/helpers/network";
import { generateRevisionRouteTree } from "../apps/web/scripts/network-baseline-route-tree";
import { prepareComparisonBaseline } from "./network-baseline-scope";

const routeTree = await (async () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "network-comparison-tree-"),
  );
  const repository = path.join(import.meta.dirname, "..");
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repository,
  });
  expect(revision.exitCode).toBe(0);
  const output = path.join(directory, "route-tree.ts");
  try {
    await generateRevisionRouteTree({
      repository,
      revision: revision.stdout.toString().trim(),
      output,
    });
    return readFileSync(output, "utf-8");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
})();

test("successive write recordings retain declarations and timing-conditional peaks", () => {
  const requests = ["GET /conditional", "GET /observed"];
  const declared = prepareComparisonBaseline({
    base: {},
    changedPaths: [],
    baseRouteTree: routeTree,
    routeTree,
    declarations: [
      {
        route: "/chat",
        reason: "Additional endpoint",
        budget: {
          depth: 4,
          requests,
          requestCounts: { "GET /conditional": 3, "GET /observed": 2 },
          dbQueries: { "GET /conditional": 8, "GET /observed": 4 },
          responseSizes: { "GET /conditional": 8192, "GET /observed": 4096 },
        },
      },
    ],
  }).baseline;
  let published = declared;
  for (const observedRequests of [requests, ["GET /observed"], []]) {
    const seed = prepareComparisonBaseline({
      base: published,
      changedPaths: [],
      baseRouteTree: routeTree,
      routeTree,
      declarations: [],
    }).baseline;
    published = mergeNetworkBaseline(
      seed,
      new Map([
        [
          "/chat",
          {
            depth: 1,
            requests: observedRequests,
            requestCounts: Object.fromEntries(
              observedRequests.map((key) => [key, 1]),
            ),
            depthChain: [],
            dbQueries: Object.fromEntries(
              observedRequests.map((key) => [key, 1]),
            ),
            missingDbQueryCounts: {},
            responseSizes: Object.fromEntries(
              observedRequests.map((key) => [key, 1024]),
            ),
            missingResponseSizeCounts: {},
          },
        ],
      ]),
    );
    expect(published).toEqual(declared);
  }
});

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
    // The relocated module must retain the shared coverage owner's import.
    const relocated = mutant.replace('"./smoke-route-coverage"', () =>
      JSON.stringify(
        path.join(root, "apps/web/e2e/helpers/smoke-route-coverage.ts"),
      ),
    );
    writeFileSync(file, relocated);
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
}, 60_000);
