import { expect, test, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PUBLIC_VISITOR_ROUTE_DEFS,
  type VisitorRoute,
} from "../apps/web/e2e/helpers/public-visitor-route-defs";
import {
  assertSmokeRouteCoverage,
  authenticatedRouteTemplates,
  networkBaselineKey,
  networkBaselineCoverageProblem,
} from "../apps/web/e2e/helpers/smoke-route-coverage";
import { SMOKE_ROUTE_DEFS } from "../apps/web/e2e/helpers/smoke-route-defs";
import { generateRouteTree } from "../apps/web/scripts/generate-route-tree";
import {
  networkBudgetDeclarationProblem,
  prepareComparisonBaseline,
} from "./network-baseline-scope";

const directory = mkdtempSync(path.join(os.tmpdir(), "network-coverage-"));
let routeTree: string;
const entry = { depth: 0, requests: [] };
const baseline = () =>
  Object.fromEntries(
    SMOKE_ROUTE_DEFS.map((def) => [networkBaselineKey(def), entry]),
  );

beforeAll(async () => {
  const output = path.join(directory, "tree.ts");
  await generateRouteTree(output);
  // Revision preparation generates beside route sources before copying the
  // tree. Give this relocated test output the same source-relative imports.
  routeTree = readFileSync(output, "utf-8").replaceAll(
    /from '[^']*\/routes\//gu,
    "from './routes/",
  );
  writeFileSync(output, routeTree);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const validate = (
  value = baseline(),
  declarations: unknown[] = [],
  changedRoutes: string[] = [],
) => {
  assertSmokeRouteCoverage(routeTree);
  const expectedKeys = SMOKE_ROUTE_DEFS.map(networkBaselineKey);
  const problem =
    networkBudgetDeclarationProblem({ expectedKeys, declarations }) ??
    networkBaselineCoverageProblem({
      actualKeys: Object.keys(value),
      expectedKeys,
      changedRoutes,
    });
  if (problem !== null) {
    throw new Error(problem);
  }
};

test("canonical smoke keys and declarations cover the generated authenticated tree", () => {
  validate();
  validate(baseline(), [
    { route: "/contacts", reason: "Reviewed budget", budget: entry },
  ]);
  expect(authenticatedRouteTemplates(routeTree)).toContain(
    "/workspaces/$workspaceId/lists",
  );
});

test("a render-in-place expectation rejects the former lists redirect key", () => {
  const route = SMOKE_ROUTE_DEFS.find(
    (def) => def.template === "/workspaces/$workspaceId/lists",
  );
  expect(route).toBeDefined();
  expect(route?.expectation?.kind).not.toBe("redirectsTo");
  const stale = baseline();
  delete stale["/workspaces/$workspaceId/lists"];
  stale["/workspaces/$workspaceId/lists target"] = entry;
  expect(() => validate(stale)).toThrow(
    'Network baseline route keys differ: missing=["/workspaces/$workspaceId/lists"] stale=["/workspaces/$workspaceId/lists target"]',
  );
});

test("every smoke route rejects a missing key and its opposite redirect mapping", () => {
  for (const def of SMOKE_ROUTE_DEFS) {
    const key = networkBaselineKey(def);
    const missing = Object.fromEntries(
      Object.entries(baseline()).filter(([route]) => route !== key),
    );
    expect(() => validate(missing)).toThrow(
      "Network baseline route keys differ",
    );
    missing[
      def.expectation?.kind === "redirectsTo"
        ? def.template
        : `${def.template} target`
    ] = entry;
    expect(() => validate(missing)).toThrow(
      "Network baseline route keys differ",
    );
  }
});

test("new authenticated routes, stale exclusions and duplicate smoke declarations fail coverage", () => {
  const changed = routeTree.replace(
    "export interface FileRoutesByTo {",
    "export interface FileRoutesByTo {\n  '/new-section': typeof ProtectedNewSectionRoute",
  );
  expect(() => assertSmokeRouteCoverage(changed)).toThrow(
    'missing=["/new-section"]',
  );
  expect(() =>
    assertSmokeRouteCoverage(routeTree, [
      ...SMOKE_ROUTE_DEFS,
      { template: "/stale" },
    ]),
  ).toThrow('stale=["/stale"]');
  expect(() =>
    assertSmokeRouteCoverage(routeTree, [
      ...SMOKE_ROUTE_DEFS,
      ...SMOKE_ROUTE_DEFS,
    ]),
  ).toThrow("declarations must cover each route exactly once");
});

test("unknown generated route forms and missing structural markers fail closed", () => {
  expect(() => authenticatedRouteTemplates("")).toThrow(
    "Could not find FileRoutesByTo",
  );
  expect(() =>
    authenticatedRouteTemplates(
      "export interface FileRoutesByTo {\n  '/x': UnknownType\n}",
    ),
  ).toThrow("Unknown FileRoutesByTo entry");
  expect(() =>
    authenticatedRouteTemplates(
      "export interface FileRoutesByTo {\n  '/x': typeof PublicRoute\n}",
    ),
  ).toThrow("no authenticated routes");
});

test("reviewed declarations cannot retain inactive redirect keys", () => {
  expect(() =>
    validate(baseline(), [
      {
        route: "/workspaces/$workspaceId/lists target",
        reason: "Reviewed budget",
        budget: entry,
      },
    ]),
  ).toThrow("Network budget declaration names an inactive route");
});

test("CLI checks the real route inventory and baseline schema", () => {
  const file = path.join(directory, "baseline.json");
  const run = () =>
    Bun.spawnSync(
      [
        "bun",
        "scripts/network-baseline-scope.ts",
        "validate",
        file,
        "--route-tree",
        path.join(directory, "tree.ts"),
        "--context",
        path.join(directory, "context.json"),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  writeFileSync(path.join(directory, "context.json"), "[]");
  writeFileSync(file, JSON.stringify(baseline()));
  expect(run().exitCode).toBe(0);
  const malformed = baseline();
  malformed["/contacts"] = { depth: -1, requests: [] };
  writeFileSync(file, JSON.stringify(malformed));
  const result = run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "does not match the network baseline schema",
  );
});

test("declarations reject duplicate routes, unknown fields and unrecorded request allowances", () => {
  const declaration = {
    route: "/contacts",
    reason: "Reviewed budget",
    budget: entry,
  };
  for (const declarations of [
    [declaration, declaration],
    [{ ...declaration, reason: " " }],
    [{ ...declaration, extra: true }],
    [{ ...declaration, budget: { ...entry, depth: -1 } }],
    [
      {
        ...declaration,
        budget: { ...entry, requestCounts: { "GET /unrecorded": 1 } },
      },
    ],
    [null],
  ]) {
    const result = Bun.spawnSync(
      [
        "bun",
        "--eval",
        `import { networkBudgetDeclarationProblem } from "./scripts/network-baseline-scope.ts"; networkBudgetDeclarationProblem(${JSON.stringify({ baseline: baseline(), expectedKeys: SMOKE_ROUTE_DEFS.map(networkBaselineKey), declarations })});`,
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toMatch(
      /Invalid network budget declaration|Duplicate network budget declaration/u,
    );
  }
});

test("unknown expectations require an explicit baseline mapping", () => {
  expect(() =>
    networkBaselineKey({
      template: "/contacts",
      expectation: { kind: "unknown" },
    }),
  ).toThrow("Unknown smoke route expectation: unknown");
});

test("real prepared context exempts changed redirects and leaves unrelated stale keys strict", () => {
  const { changedRoutes } = prepareComparisonBaseline({
    base: baseline(),
    changedPaths: ["apps/web/src/routes/_protected.settings/index.tsx"],
    baseRouteTree: routeTree,
    routeTree,
    declarations: [],
  });
  expect(changedRoutes).toEqual(["/settings", "/settings target"]);
  const changedRedirect = baseline();
  delete changedRedirect["/settings target"];
  validate(changedRedirect, [], changedRoutes);
  delete changedRedirect["/workspaces/$workspaceId/lists"];
  changedRedirect["/workspaces/$workspaceId/lists target"] = entry;
  expect(() => validate(changedRedirect, [], changedRoutes)).toThrow(
    'missing=["/workspaces/$workspaceId/lists"] stale=["/workspaces/$workspaceId/lists target"]',
  );
});

test("inherited declarations cannot manufacture a missing prepared baseline key", () => {
  const missing = baseline();
  delete missing["/contacts"];
  expect(() =>
    validate(missing, [
      { route: "/contacts", reason: "Inherited budget", budget: entry },
    ]),
  ).toThrow('missing=["/contacts"]');
});

test("an expectation change needs a matching prepared recording", () => {
  const changedDefs = SMOKE_ROUTE_DEFS.map((def) =>
    def.template === "/workspaces/$workspaceId/lists"
      ? {
          ...def,
          expectation: {
            kind: "redirectsTo",
            to: "/workspaces/$workspaceId/$viewId",
          },
        }
      : def,
  );
  assertSmokeRouteCoverage(routeTree, changedDefs);
  const expectedKeys = changedDefs.map(networkBaselineKey);
  expect(
    networkBaselineCoverageProblem({
      actualKeys: Object.keys(baseline()),
      expectedKeys,
    }),
  ).toBe(
    'Network baseline route keys differ: missing=["/workspaces/$workspaceId/lists target"] stale=["/workspaces/$workspaceId/lists"]',
  );
  const recorded = baseline();
  delete recorded["/workspaces/$workspaceId/lists"];
  recorded["/workspaces/$workspaceId/lists target"] = entry;
  expect(
    networkBaselineCoverageProblem({
      actualKeys: Object.keys(recorded),
      expectedKeys,
    }),
  ).toBeNull();
});

test("light coverage prepares through the shared action before checking under the time cap", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"),
    "utf-8",
  );
  const job = source.split("  ci-checks-rest:")[1]?.split("  ci-tests:")[0];
  expect(job).toBeDefined();
  const prepare = job?.indexOf("name: Prepare route network manifest") ?? -1;
  const coverage = job?.indexOf("name: Route network manifest coverage") ?? -1;
  expect(prepare).toBeGreaterThan(0);
  expect(coverage).toBeGreaterThan(prepare);
  const restore = job?.indexOf("name: Restore route network baseline") ?? -1;
  expect(restore).toBeGreaterThan(coverage);
  const afterCoverage = job?.slice(coverage).split("      - name: ")[1];
  expect(afterCoverage).toStartWith("Restore route network baseline");
  expect(afterCoverage).toContain(
    "!cancelled() && steps.install.outcome == 'success'",
  );
  expect(afterCoverage).toContain(
    "git checkout -- apps/web/e2e/network-baseline.json",
  );
  expect(afterCoverage).toContain("rm -f apps/web/e2e/.network-baseline-*");
  expect(job?.slice(0, prepare)).toContain("fetch-depth: 0");
  const steps = job?.slice(
    prepare,
    job.indexOf("name: Workspace hygiene", coverage),
  );
  expect(steps).toContain("uses: ./.github/actions/prepare-network-baseline");
  expect(steps).toContain("timeout-minutes: 1");
  expect(steps).toContain(
    "steps.network_manifest_prepare.outcome == 'success'",
  );
  expect(steps).toContain("timeout 30s bash -c");
  expect(steps).toContain(
    "--context apps/web/e2e/.network-baseline-context.json",
  );
});

test("cleanup restores the tracked baseline and removes preparation files after partial failure", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "../.github/workflows/ci.yml"),
    "utf-8",
  );
  const step = source
    .split("      - name: Restore route network baseline\n")[1]
    ?.split("      - name: Workspace hygiene")[0];
  const cleanup = step?.split("        run: |\n")[1];
  if (!cleanup) {
    throw new Error("Missing baseline restore step");
  }
  const repository = path.join(directory, "cleanup");
  const e2e = path.join(repository, "apps/web/e2e");
  mkdirSync(e2e, { recursive: true });
  const run = (args: string[]) =>
    Bun.spawnSync(args, { cwd: repository, stderr: "pipe", stdout: "pipe" });
  expect(run(["git", "init", "-q"]).exitCode).toBe(0);
  const baselineFile = path.join(e2e, "network-baseline.json");
  const original = JSON.stringify({ "/contacts": entry });
  writeFileSync(baselineFile, original);
  expect(
    run(["git", "add", "apps/web/e2e/network-baseline.json"]).exitCode,
  ).toBe(0);
  expect(
    run([
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]).exitCode,
  ).toBe(0);
  writeFileSync(baselineFile, JSON.stringify({ "/partial": entry }));
  const metadata = ["base.json", "changed", "context.json", "declarations"].map(
    (name) => path.join(e2e, `.network-baseline-${name}`),
  );
  for (const file of metadata) {
    writeFileSync(file, "partial");
  }
  const unrelated = path.join(e2e, "notes.txt");
  writeFileSync(unrelated, "retain");
  const result = run(["bash", "-e", "-c", cleanup]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(baselineFile, "utf-8")).toBe(original);
  expect(metadata.every((file) => !existsSync(file))).toBe(true);
  expect(readFileSync(unrelated, "utf-8")).toBe("retain");
  expect(run(["git", "diff", "--exit-code"]).exitCode).toBe(0);
});

test("validation accepts a checkout without a network budget declaration directory", () => {
  const repository = path.join(directory, "no-budgets");
  mkdirSync(repository);
  expect(
    existsSync(path.join(repository, "apps/web/e2e/network-budgets")),
  ).toBe(false);
  const file = path.join(repository, "baseline.json");
  writeFileSync(file, JSON.stringify(baseline()));
  writeFileSync(path.join(repository, "context.json"), "[]");
  const result = Bun.spawnSync(
    [
      "bun",
      path.resolve(import.meta.dirname, "network-baseline-scope.ts"),
      "validate",
      file,
      "--route-tree",
      path.join(directory, "tree.ts"),
      "--context",
      path.join(repository, "context.json"),
    ],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("public visitor declarations resolve tools only when the tool route needs them", () => {
  let calls = 0;
  const resolveTool = () => {
    calls += 1;
    return { slug: "contract-review", displayName: "Contract review" };
  };
  const template = { id: "sample", title: "Sample template" };
  const routes = PUBLIC_VISITOR_ROUTE_DEFS.map((def: VisitorRoute) =>
    def.resolve(template, resolveTool),
  );
  expect(calls).toBe(1);
  expect(routes.map((route) => route.path)).toEqual([
    "/knowledge/templates/catalogue",
    "/knowledge/templates/catalogue/general-legal/sample",
    "/knowledge/tools/contract-review",
    "/knowledge/tools/contribute",
  ]);
  expect(routes[2]).toEqual({
    path: "/knowledge/tools/contract-review",
    heading: "Contract review",
    level: 2,
  });
});
