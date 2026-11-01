import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { changedBrowserSuiteSpecs } from "./ci-browser-suite-selection";
import {
  BROWSER_SUITES,
  type BrowserSuite,
  browserSuite,
  browserSuiteConfig,
  BrowserSuiteDeclarationError,
  browserSuiteRunInputs,
  browserSuiteSpecs,
  browserSuiteTestDir,
  ciBrowserSuiteLegs,
  directlyChangedSuiteSpecs,
  legSuiteSpecs,
  packageDirectory,
  parseCiBrowserSuiteLegs,
  playwrightConfigOf,
  type RegisteredSuite,
} from "./ci-browser-suites";
import {
  browserInvocations,
  type CensusIo,
  type Invocation,
  type Manifest,
  repositoryIo,
} from "./ci-browser-suites.test-support";
import { markdownReaders } from "./ci-package-scope";
import {
  type ChangedFileScope,
  computeChangedFileScope,
  DEFAULT_DETECTORS,
} from "./ci-plan-scope";
import { ROUTE_SMOKE_SPEC_PATH } from "./detect-route-smoke-changes";
import { GEOMETRY_SPEC_PATH, selectedE2ePlan } from "./e2e-spec-shards";
import { compareCodeUnit } from "./e2e-spec-shards-core";
import { type Context, evaluate, type Value } from "./github-expression";
import { lexShell } from "./install-free-ci";
import { selectGeometrySpecs } from "./ui-playground-selection";
import { planUiPlaygroundMatrix } from "./ui-playground-shards";

markdownReaders();

const ROOT = path.resolve(import.meta.dirname, "..");
const io = repositoryIo(ROOT);
const census = browserInvocations(io);
const STEP = v.looseObject({
  id: v.optional(v.string()),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.unknown())),
});
const workflow = v.parse(
  v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({
        if: v.optional(v.string()),
        outputs: v.optional(v.record(v.string(), v.string())),
        steps: v.optional(v.array(STEP)),
      }),
    ),
  }),
  Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8"),
  ),
);

const jobOf = (name: string) =>
  workflow.jobs[name] ?? expect.unreachable(`Missing job ${name}`);
const planOutput = (name: string) =>
  jobOf("ci-plan").outputs?.[name] ?? expect.unreachable(`Missing ${name}`);

const claims = (suite: BrowserSuite, invocation: Invocation) =>
  suite.job === invocation.job &&
  suite.package === invocation.package &&
  suite.script === invocation.script &&
  JSON.stringify([...(suite.filters ?? [])].toSorted(compareCodeUnit)) ===
    JSON.stringify(invocation.filters);

const unclaimed = ({ invocations, problems }: typeof census) => [
  ...problems,
  ...invocations
    .filter(
      (invocation) =>
        BROWSER_SUITES.filter((suite) => claims(suite, invocation)).length !==
        1,
    )
    .map(({ job, step, package: name, script, filters }) =>
      `${job} / ${step}: ${name} ${script} ${filters.join(" ")}`.trim(),
    ),
];

const runsOf = (suite: BrowserSuite) =>
  census.invocations.filter((invocation) => claims(suite, invocation));

// The paths a ci-browser selector step diffs before it admits its suites.
const selectorInputs = (selector: string): readonly string[] => {
  const step = (jobOf("ci-browser").steps ?? []).find(
    ({ id }) => id === selector,
  );
  return lexShell(step?.run ?? "").flatMap((event) => {
    if (event.type !== "command") {
      return [];
    }
    const boundary = event.words.indexOf("--");
    return event.words.includes("diff") && boundary !== -1
      ? event.words.slice(boundary + 1)
      : [];
  });
};

const pullRequestScope = (files: readonly string[]) =>
  computeChangedFileScope(
    {
      changedFiles: files,
      comparisonBase: "",
      scopeUnknown: false,
      eventName: "pull_request",
      suiteDepth: "fast",
      heavyOnly: false,
      prTitle: "",
      armed: false,
    },
    { ...DEFAULT_DETECTORS, landingDeploy: () => false },
  );

// The scope outputs this census reads (package checks, browser scope,
// production e2e inputs) decide by directory and package, so one spec
// stands for every spec of its directory.
const scopeByDirectory = new Map<string, ChangedFileScope>();
const specScope = (spec: string): ChangedFileScope => {
  const directory = path.posix.dirname(spec);
  const known = scopeByDirectory.get(directory);
  if (known !== undefined) {
    return known;
  }
  const scope = pullRequestScope([spec]);
  scopeByDirectory.set(directory, scope);
  return scope;
};

const heavyProofJobs = (): readonly string[] => {
  const step = (jobOf("ci-plan").steps ?? []).find(({ id }) => id === "suites");
  return v.parse(
    v.array(v.string()),
    JSON.parse(v.parse(v.string(), step?.env?.["HEAVY_PROOF_JOBS"])),
  );
};

// An expression's value as the workflow compares it: "true", "false", or
// the string it produced; anything else reads as "unknown".
const truth = (source: string, context: Context): string => {
  const result = evaluate(source, context);
  if (typeof result === "string") {
    return result;
  }
  return typeof result === "boolean" ? String(result) : "unknown";
};

const scopeValues = (prefix: string, scope: ChangedFileScope) =>
  Object.fromEntries(
    Object.entries(scope).map(([name, value]) => [`${prefix}${name}`, value]),
  );

type PlanInputs = {
  scope: ChangedFileScope;
  playgroundSpecs?: readonly string[];
  legs?: string;
};

// What ci-plan and the ci-browser job decide for a pull request.
const pullRequestBrowserJob = ({
  scope,
  playgroundSpecs = [],
  legs = "[]",
}: PlanInputs) => {
  const values: Record<string, Value> = {
    "github.event_name": "pull_request",
    "steps.completed-depth.outputs.run_required": "true",
    "steps.completed-depth.outputs.pr_heavy_suites": "run",
    "steps.completed-depth.outputs.normal_completion": "",
    "steps.check.outputs.trusted": "true",
    "steps.depth.outputs.suite_depth": "fast",
    "steps.depth.outputs.queue_depth": "full",
    "steps.pilot-queue-plan.outputs.queue_jobs": "[]",
    "steps.e2e-pr-plan.outputs.selection_required": "false",
    "steps.ui-playground-plan.outputs.specs": JSON.stringify(playgroundSpecs),
    "steps.browser-suite-plan.outputs.legs": legs,
    ...scopeValues("steps.changed-files.outputs.", scope),
  };
  const browserRequired = truth(planOutput("ci_browser_required"), { values });
  const gateRequired = truth(planOutput("pr_heavy_gate_required"), { values });
  const job = truth(jobOf("ci-browser").if ?? "", {
    values: {
      "github.event_name": "pull_request",
      "inputs.pr_depth_only": false,
      "needs.ci-plan.result": "success",
      "needs.ci-plan.outputs.run_required": "true",
      "needs.ci-plan.outputs.coverage_profile": "normal-v1",
      "needs.ci-plan.outputs.pilot_fast_jobs": "[]",
      "needs.ci-plan.outputs.ci_browser_required": browserRequired,
      "needs.pr-heavy-gate.result":
        gateRequired === "true" ? "success" : "skipped",
    },
    status: { cancelled: false },
  });
  return { browserRequired, gateRequired, job };
};

const jobRuns = (
  job: string,
  event: "pull_request" | "merge_group",
  outputs: Record<string, Value>,
) =>
  truth(jobOf(job).if ?? "", {
    values: {
      "github.event_name": event,
      "inputs.pr_depth_only": false,
      "inputs.heavy_only": false,
      "needs.ci-plan.result": "success",
      "needs.pr-heavy-gate.result":
        event === "pull_request" ? "success" : "skipped",
      "needs.web-build.result": "success",
      "needs.heavy-web-build.result": "skipped",
      ...Object.fromEntries(
        Object.entries(outputs).map(([name, value]) => [
          `needs.ci-plan.outputs.${name}`,
          value,
        ]),
      ),
    },
    status: { always: true, cancelled: false, success: true, failure: false },
  });

const PLAN_DEFAULTS = {
  run_required: "true",
  trusted: "true",
  heavy_proof: "true",
  armed_delta: "false",
  coverage_profile: "normal-v1",
  pilot_fast_jobs: "[]",
  queue_depth: "full",
  marketing_screenshots_required: "true",
} as const;

test("every Playwright run ci.yml reaches belongs to exactly one browser suite", () => {
  expect(census.invocations.length).toBeGreaterThan(0);
  expect(unclaimed(census)).toEqual([]);
  for (const suite of BROWSER_SUITES) {
    expect(runsOf(suite).length, suite.id).toBeGreaterThan(0);
    expect(packageDirectory(suite.package, ROOT), suite.id).toBeDefined();
    expect(workflow.jobs[suite.job], suite.id).toBeDefined();
    for (const input of browserSuiteRunInputs(suite, ROOT)) {
      expect(existsSync(path.join(ROOT, input)), `${suite.id} ${input}`).toBe(
        true,
      );
    }
  }
});

// Each overlay adds one Playwright run of a shape the census must see.
const overlayIo = (
  files: Record<string, unknown>,
  manifests: Record<string, Manifest> = {},
): CensusIo => ({
  yaml: (file) => (file in files ? files[file] : io.yaml(file)),
  manifest: (directory) => manifests[directory] ?? io.manifest(directory),
  packages: () => [...io.packages(), ...Object.keys(manifests)],
});
const withRouteSmokeStep = (step: Record<string, unknown>) => {
  const ci = v.parse(
    v.looseObject({ jobs: v.record(v.string(), v.looseObject({})) }),
    io.yaml(".github/workflows/ci.yml"),
  );
  const routeSmoke = v.parse(
    v.looseObject({ steps: v.array(v.unknown()) }),
    ci.jobs["route-smoke"],
  );
  return {
    ...ci,
    jobs: {
      ...ci.jobs,
      "route-smoke": { ...routeSmoke, steps: [...routeSmoke.steps, step] },
    },
  };
};

test.each([
  {
    shape: "a package script",
    step: { name: "New", run: "bun --filter @stll/web test:e2e:soak" },
    expected: "route-smoke / New: @stll/web test:e2e:soak",
  },
  {
    shape: "a working directory",
    step: {
      name: "New",
      "working-directory": "apps/web",
      run: "bun run test:e2e:soak",
    },
    expected: "route-smoke / New: @stll/web test:e2e:soak",
  },
  {
    shape: "bun run --cwd",
    step: { name: "New", run: "bun run --cwd apps/web test:e2e:soak" },
    expected: "route-smoke / New: @stll/web test:e2e:soak",
  },
  {
    shape: "bunx playwright",
    step: {
      name: "New",
      run: "cd apps/web\nbunx playwright test -c e2e/playwright.soak.config.ts",
    },
    expected: "route-smoke / New: @stll/web playwright test",
  },
  {
    shape: "npx playwright",
    step: { name: "New", run: "npx playwright test" },
    expected: "route-smoke / New: stella playwright test",
  },
  {
    shape: "an unrecognised Playwright command",
    step: { name: "New", run: "node node_modules/playwright/cli.js test" },
    expected: "route-smoke / New: mentions Playwright without a recognised run",
  },
])("the census sees a suite started by $shape", ({ step, expected }) => {
  const mutated = browserInvocations(
    overlayIo({ ".github/workflows/ci.yml": withRouteSmokeStep(step) }),
  );
  const rootName = io.manifest(".")?.name ?? ".";
  expect(unclaimed(mutated)).toEqual([
    expected.replace("stella", () => rootName),
  ]);
});

test("the census follows root scripts, reusable workflows and composite actions", () => {
  const rootManifest = io.manifest(".") ?? expect.unreachable("No manifest");
  const ci = withRouteSmokeStep({
    name: "Root",
    run: "bun run test:browser-root",
  });
  const mutated = browserInvocations(
    overlayIo(
      {
        ".github/workflows/ci.yml": {
          ...ci,
          jobs: {
            ...ci.jobs,
            "new-reusable": { uses: "./.github/workflows/new-browser.yml" },
          },
        },
        ".github/workflows/new-browser.yml": {
          jobs: {
            check: {
              steps: [
                { name: "Composite", uses: "./.github/actions/new-browser" },
              ],
            },
          },
        },
        ".github/actions/new-browser/action.yml": {
          runs: {
            using: "composite",
            steps: [
              { name: "Inner", run: "bun --filter @stll/web test:e2e:soak" },
            ],
          },
        },
      },
      {
        ".": {
          ...rootManifest,
          scripts: {
            ...rootManifest.scripts,
            "test:browser-root": "playwright test -c e2e/root.config.ts",
          },
        },
      },
    ),
  );
  const rootName = rootManifest.name ?? ".";
  expect(unclaimed(mutated).toSorted(compareCodeUnit)).toEqual(
    [
      `route-smoke / Root: ${rootName} test:browser-root`,
      "new-reusable / .github/workflows/new-browser.yml#check › Composite › Inner: @stll/web test:e2e:soak",
    ].toSorted(compareCodeUnit),
  );
});

test("registered spec filters are exactly what the workflow passes", () => {
  for (const suite of BROWSER_SUITES) {
    for (const run of runsOf(suite)) {
      expect(run.filters, `${suite.id} ${run.step}`).toEqual(
        [...("filters" in suite ? suite.filters : [])].toSorted(
          compareCodeUnit,
        ),
      );
    }
  }
});

test.each(BROWSER_SUITES.map(({ id }) => id))(
  "the merge-group browser suite %s runs on a pull request that changes it",
  (id) => {
    const suite = browserSuite(id);
    const heavy = heavyProofJobs();
    const productionConfig = browserSuiteConfig(
      browserSuite("production"),
      ROOT,
    );
    const specs = browserSuiteSpecs(suite, ROOT);
    const runs = runsOf(suite);
    const { pr } = suite;
    switch (pr.kind) {
      case "ci-browser-leg": {
        expect(specs.length, suite.id).toBeGreaterThan(0);
        for (const run of runs) {
          expect(run.stepIf, suite.id).toContain(`matrix.suite == '${pr.leg}'`);
          expect(run.run, suite.id).toContain(
            `ci-browser-suites.ts specs ${suite.id}`,
          );
          // The pull request runs only what its merge-group selector admits.
          const selector = /steps\.([\w-]+)\.outputs\.required/u.exec(
            run.stepIf ?? "",
          )?.[1];
          const inputs = selectorInputs(selector ?? "");
          expect(inputs.length, suite.id).toBeGreaterThan(0);
          for (const file of [
            ...specs,
            ...browserSuiteRunInputs(suite, ROOT),
          ]) {
            expect(
              inputs.some(
                (input) => file === input || file.startsWith(`${input}/`),
              ),
              file,
            ).toBe(true);
          }
        }
        for (const spec of specs) {
          const legs = ciBrowserSuiteLegs(
            changedBrowserSuiteSpecs([spec], { root: ROOT }),
          );
          const matrix = planUiPlaygroundMatrix({
            selectedSpecs: [],
            allSpecs: [],
            eventName: "pull_request",
            desktopRequired: false,
            suiteLegs: parseCiBrowserSuiteLegs(JSON.stringify(legs)),
          });
          const leg = matrix.find(({ suite: name }) => name === pr.leg);
          expect(
            legSuiteSpecs(suite.id, pr.leg, leg?.specs ?? [], ROOT),
            spec,
          ).toContain(spec);
          const planned = pullRequestBrowserJob({
            scope: specScope(spec),
            legs: JSON.stringify(legs),
          });
          expect(planned, spec).toEqual({
            browserRequired: "true",
            gateRequired: "true",
            job: "true",
          });
        }
        break;
      }
      case "production-leg": {
        expect(specs.length, suite.id).toBeGreaterThan(0);
        for (const run of runs) {
          expect(run.stepIf, suite.id).toContain("matrix.shard == 1");
          // The leg runs the whole suite.
          expect(run.dynamic || run.filters.length > 0, suite.id).toBe(false);
        }
        for (const spec of specs) {
          const plan = selectedE2ePlan([spec], ROOT);
          expect(plan.status, spec).toBe("selected");
          expect(plan.matrix.shard, spec).toContain(1);
          expect(plan.specs, spec).toEqual([]);
          expect(plan.suiteSpecs, spec).toContain(spec);
          expect(specScope(spec).e2e_production_required, spec).toBe("true");
        }
        break;
      }
      case "playground-selection": {
        expect(specs.length, suite.id).toBeGreaterThan(0);
        // The planner's specs are files the suite's config runs.
        const testDir = browserSuiteTestDir(suite, ROOT);
        expect(specs.every((spec) => spec.startsWith(`${testDir}/`))).toBe(
          true,
        );
        for (const spec of specs) {
          const selected = selectGeometrySpecs([spec], ROOT);
          expect(selected, spec).toContain(spec);
          expect(
            pullRequestBrowserJob({
              scope: specScope(spec),
              playgroundSpecs: selected,
            }),
            spec,
          ).toEqual({
            browserRequired: "true",
            gateRequired: "true",
            job: "true",
          });
        }
        break;
      }
      case "production-selection": {
        expect(specs.length, suite.id).toBeGreaterThan(0);
        expect(browserSuiteConfig(suite, ROOT), suite.id).toBe(
          productionConfig,
        );
        for (const spec of specs) {
          const plan = selectedE2ePlan([spec], ROOT);
          // A full plan runs every spec of the production config, which the
          // suite shares; a selected one must name the spec or its leg.
          if (spec === ROUTE_SMOKE_SPEC_PATH) {
            expect(plan.matrix.shard, spec).toContain("network-baseline");
          } else if (plan.status === "selected") {
            expect(spec, spec).not.toBe(GEOMETRY_SPEC_PATH);
            expect(plan.specs, spec).toContain(spec);
          } else {
            expect(plan.matrix.shard.length, spec).toBeGreaterThan(1);
          }
          expect(specScope(spec).e2e_production_required, spec).toBe("true");
        }
        break;
      }
      case "scope": {
        const probe = `${browserSuiteTestDir(suite, ROOT)}/census-probe.spec.ts`;
        const scope = pullRequestScope([probe]);
        expect(scope[pr.output], suite.id).toBe("true");
        if (suite.job === "ci-browser") {
          expect(pullRequestBrowserJob({ scope }), suite.id).toEqual({
            browserRequired: "true",
            gateRequired: "true",
            job: "true",
          });
        } else {
          expect(
            jobRuns(suite.job, "pull_request", { ...PLAN_DEFAULTS, ...scope }),
            suite.id,
          ).toBe("true");
        }
        break;
      }
      case "armed-proof": {
        expect(heavy, suite.id).toContain(suite.job);
        const probe = `${browserSuiteTestDir(suite, ROOT)}/census-probe.spec.ts`;
        const scope = pullRequestScope([probe]);
        // The armed pull request runs the job whenever the group would.
        expect(
          jobRuns(suite.job, "merge_group", {
            ...PLAN_DEFAULTS,
            ...scope,
            suite_depth: "full",
          }),
          suite.id,
        ).toBe("true");
        expect(
          jobRuns(suite.job, "pull_request", {
            ...PLAN_DEFAULTS,
            ...scope,
            suite_depth: "fast",
          }),
          suite.id,
        ).toBe("true");
        break;
      }
      default: {
        pr satisfies never;
        throw new Error("Unknown browser suite PR path");
      }
    }
  },
);

const changedSpecSuite = (id: "ui-components" | "extension" | "api-browser") =>
  browserSuite(id);

test("a changed module selects the specs whose closure holds it, through workspace imports", () => {
  const ui = changedSpecSuite("ui-components");
  const specs = browserSuiteSpecs(ui, ROOT);
  const [spec] = specs;
  if (spec === undefined) {
    throw new Error("No component specs");
  }
  expect(changedBrowserSuiteSpecs([spec], { root: ROOT })).toEqual({
    "ui-components": [spec],
  });
  expect(changedBrowserSuiteSpecs(["README.md"], { root: ROOT })).toEqual({});
  // A module the suite's config loads through a workspace import.
  const workspaceImport = "packages/playwright-tools/src/devices.gen.ts";
  expect(existsSync(path.join(ROOT, workspaceImport))).toBe(true);
  expect(
    changedBrowserSuiteSpecs([workspaceImport], { root: ROOT })[
      "ui-components"
    ],
  ).toEqual([...specs]);
});

test("a run input, a fixture page or an unreadable closure selects every spec of its suite", () => {
  const ui = changedSpecSuite("ui-components");
  const api = changedSpecSuite("api-browser");
  const extension = changedSpecSuite("extension");
  expect(
    changedBrowserSuiteSpecs(
      ["packages/ui/src/components/fixtures/dialog.fixture.html"],
      { root: ROOT },
    )["ui-components"],
  ).toEqual([...browserSuiteSpecs(ui, ROOT)]);
  expect(
    changedBrowserSuiteSpecs([browserSuiteConfig(extension, ROOT)], {
      root: ROOT,
    })["extension"],
  ).toEqual([...browserSuiteSpecs(extension, ROOT)]);
  // The API specs read files, so a helper beside them selects them all.
  expect(
    changedBrowserSuiteSpecs(["apps/api/e2e/visual-treemap.helpers.ts"], {
      root: ROOT,
    })["api-browser"],
  ).toEqual([...browserSuiteSpecs(api, ROOT)]);
  expect(
    changedBrowserSuiteSpecs(
      ["apps/api/src/handlers/visual-sandbox/routes.ts"],
      { root: ROOT },
    )["api-browser"],
  ).toEqual([...browserSuiteSpecs(api, ROOT)]);
  // The install-free planner sees direct changes the same way.
  expect(
    directlyChangedSuiteSpecs(["apps/extension/src/entrypoints/x.ts"], ROOT)[
      "extension"
    ],
  ).toEqual([...browserSuiteSpecs(extension, ROOT)]);
});

const writeTree = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(tmpdir(), "browser-suites-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
};

test.each([
  ['testMatch: ["a.spec.ts"]', "a non-literal testMatch"],
  ['testDir: "./a", projects: [{ testDir: "./b" }]', "a per-project testDir"],
  ['testDir: "./a", testIgnore: /x/', "testIgnore"],
])("a config with %s fails loudly instead of selecting less (%s)", (body) => {
  const root = writeTree({
    "packages/ui/package.json": JSON.stringify({
      name: "@stll/ui",
      scripts: {
        "test:browser": "playwright test --config playwright.config.ts",
      },
    }),
    "packages/ui/playwright.config.ts": `export default defineConfig({ ${body} });\n`,
  });
  try {
    expect(() =>
      browserSuiteSpecs(changedSpecSuite("ui-components"), root),
    ).toThrow(BrowserSuiteDeclarationError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a script whose --config names nothing fails loudly", () => {
  expect(() => playwrightConfigOf("playwright test --config")).toThrow(
    BrowserSuiteDeclarationError,
  );
  expect(() => playwrightConfigOf("playwright test -c --headed")).toThrow(
    BrowserSuiteDeclarationError,
  );
  expect(playwrightConfigOf("playwright test -c e2e/x.config.ts")).toBe(
    "e2e/x.config.ts",
  );
});

test("a leg's suites claim exactly the specs it carries", () => {
  const [ui] = browserSuiteSpecs(changedSpecSuite("ui-components"), ROOT);
  const [extension] = browserSuiteSpecs(changedSpecSuite("extension"), ROOT);
  if (ui === undefined || extension === undefined) {
    throw new Error("Missing specs");
  }
  expect(legSuiteSpecs("ui-components", "ui", [ui, extension], ROOT)).toEqual([
    ui,
  ]);
  expect(legSuiteSpecs("extension", "ui", [ui, extension], ROOT)).toEqual([
    extension,
  ]);
  expect(() =>
    legSuiteSpecs(
      "ui-components",
      "ui",
      [ui, "apps/web/e2e/specs/x.spec.ts"],
      ROOT,
    ),
  ).toThrow(BrowserSuiteDeclarationError);
  expect(() => legSuiteSpecs("api-browser", "ui", [ui], ROOT)).toThrow(
    BrowserSuiteDeclarationError,
  );
});

test("every registered suite id resolves", () => {
  for (const suite of BROWSER_SUITES) {
    const registered: RegisteredSuite = browserSuite(suite.id);
    expect(registered.id).toBe(suite.id);
  }
});
