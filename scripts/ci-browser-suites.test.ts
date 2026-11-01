import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import {
  BROWSER_SUITES,
  type BrowserSuite,
  browserSuiteSpecs,
  changedBrowserSuiteSpecs,
  ciBrowserSuiteLegs,
  packageScript,
  parseCiBrowserSuiteLegs,
  playwrightConfigOf,
  suiteMembers,
} from "./ci-browser-suites";
import { markdownReaders } from "./ci-package-scope";
import { computeChangedFileScope, DEFAULT_DETECTORS } from "./ci-plan-scope";
import { ROUTE_SMOKE_SPEC_PATH } from "./detect-route-smoke-changes";
import { selectedE2ePlan } from "./e2e-spec-shards";
import { lexShell } from "./install-free-ci";
import { selectGeometrySpecs } from "./ui-playground-selection";
import { planUiPlaygroundMatrix } from "./ui-playground-shards";

markdownReaders();

const ROOT = path.resolve(import.meta.dirname, "..");
const STEP = v.looseObject({
  name: v.optional(v.string()),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.unknown())),
});
type Step = v.InferOutput<typeof STEP>;
const WORKFLOW = v.object({
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      outputs: v.optional(v.record(v.string(), v.string())),
      steps: v.optional(v.array(STEP)),
    }),
  ),
});
type Workflow = v.InferOutput<typeof WORKFLOW>;
const workflow = v.parse(
  WORKFLOW,
  Bun.YAML.parse(
    readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf-8"),
  ),
);

const packageName = (directory: string): string | undefined => {
  const manifest = path.join(ROOT, directory, "package.json");
  if (!existsSync(manifest)) {
    return undefined;
  }
  const parsed = v.safeParse(
    v.looseObject({ name: v.string() }),
    JSON.parse(readFileSync(manifest, "utf-8")),
  );
  return parsed.success ? parsed.output.name : undefined;
};

const packageDirectoryByName = (name: string): string | undefined => {
  for (const parent of ["apps", "packages"]) {
    for (const entry of new Bun.Glob(`${parent}/*/package.json`).scanSync(
      ROOT,
    )) {
      const directory = path.posix.dirname(entry);
      if (packageName(directory) === name) {
        return directory;
      }
    }
  }
  return undefined;
};

type Invocation = {
  job: string;
  step: Step;
  package: string;
  script: string;
};

// Every workflow command that starts a package script running Playwright.
const playwrightInvocations = (source: Workflow): Invocation[] => {
  const invocations: Invocation[] = [];
  for (const [job, { steps = [] }] of Object.entries(source.jobs)) {
    for (const step of steps) {
      if (step.run === undefined) {
        continue;
      }
      let directory = ".";
      for (const event of lexShell(step.run)) {
        if (event.type !== "command") {
          continue;
        }
        const words = event.words;
        if (words.at(0) === "cd" && words.at(1) !== undefined) {
          directory = path.posix.join(directory, words.at(1) ?? ".");
        }
        const bun = words.indexOf("bun");
        if (bun === -1) {
          continue;
        }
        const [mode, first, second] = words.slice(bun + 1);
        let name: string | undefined;
        let script: string | undefined;
        if (mode === "--filter") {
          name = first;
          script = second;
        } else if (mode === "run" && directory !== ".") {
          name = packageName(directory);
          script = first;
        }
        if (name === undefined || script === undefined) {
          continue;
        }
        const owner = packageDirectoryByName(name);
        const text =
          owner === undefined ? undefined : packageScript(owner, script, ROOT);
        if (text !== undefined && playwrightConfigOf(text) !== undefined) {
          invocations.push({ job, step, package: name, script });
        }
      }
    }
  }
  return invocations;
};

const claims = (suite: BrowserSuite, invocation: Invocation) =>
  suite.job === invocation.job &&
  suite.package === invocation.package &&
  suite.script === invocation.script;

const unclaimedInvocations = (source: Workflow) =>
  playwrightInvocations(source)
    .filter(
      (invocation) =>
        BROWSER_SUITES.filter((suite) => claims(suite, invocation)).length !==
        1,
    )
    .map(
      ({ job, step, package: name, script }) =>
        `${job} / ${step.name ?? "unnamed"}: ${name} ${script}`,
    );

const jobOf = (name: string) =>
  workflow.jobs[name] ?? expect.unreachable(`Missing job ${name}`);

const stepsRunning = (suite: BrowserSuite) =>
  playwrightInvocations(workflow)
    .filter((invocation) => claims(suite, invocation))
    .map(({ step }) => step);

// The paths a ci-browser selector step diffs before it admits its suites.
const selectorInputs = (selector: string): readonly string[] => {
  const step = (jobOf("ci-browser").steps ?? []).find(
    ({ id }) => id === selector,
  );
  const inputs: string[] = [];
  for (const event of lexShell(step?.run ?? "")) {
    if (event.type !== "command") {
      continue;
    }
    const boundary = event.words.indexOf("--");
    if (event.words.includes("diff") && boundary !== -1) {
      inputs.push(...event.words.slice(boundary + 1));
    }
  }
  return inputs;
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

const heavyProofJobs = (): readonly string[] => {
  const step = (jobOf("ci-plan").steps ?? []).find(({ id }) => id === "suites");
  return v.parse(
    v.array(v.string()),
    JSON.parse(String(step?.env?.["HEAVY_PROOF_JOBS"] ?? "[]")),
  );
};

test("every Playwright invocation in ci.yml belongs to exactly one browser suite", () => {
  expect(playwrightInvocations(workflow).length).toBeGreaterThan(0);
  expect(unclaimedInvocations(workflow)).toEqual([]);
  for (const suite of BROWSER_SUITES) {
    expect(stepsRunning(suite).length, suite.id).toBeGreaterThan(0);
    expect(browserSuiteSpecs(suite, ROOT).length, suite.id).toBeGreaterThan(0);
  }
});

test("a browser suite added to a merge-group job without a registered PR path fails the census", () => {
  const routeSmoke = jobOf("route-smoke");
  const mutated: Workflow = {
    jobs: {
      ...workflow.jobs,
      "route-smoke": {
        ...routeSmoke,
        steps: [
          ...(routeSmoke.steps ?? []),
          {
            name: "Check new layouts",
            run: "bun --filter @stll/web test:e2e:soak",
          },
        ],
      },
    },
  };
  expect(unclaimedInvocations(mutated)).toEqual([
    "route-smoke / Check new layouts: @stll/web test:e2e:soak",
  ]);
});

// timeout: Runs the real spec planners over every spec of each suite; the limit only catches a hang.
test("every browser suite the merge group selects runs a changed spec on the pull request", () => {
  const heavy = heavyProofJobs();
  for (const suite of BROWSER_SUITES) {
    const specs = browserSuiteSpecs(suite, ROOT);
    const [probe] = specs;
    if (probe === undefined) {
      throw new Error(`${suite.id} has no specs`);
    }
    const steps = stepsRunning(suite);
    const { pr } = suite;
    switch (pr.kind) {
      case "ci-browser-leg": {
        for (const step of steps) {
          expect(step.if, suite.id).toContain(`matrix.suite == '${pr.leg}'`);
          expect(step.run, suite.id).toContain(
            `ci-browser-suites.ts specs ${suite.id}`,
          );
          // The pull request runs only specs its merge-group selector admits.
          const selector = /steps\.([\w-]+)\.outputs\.required/u.exec(
            step.if ?? "",
          )?.[1];
          const inputs = selectorInputs(selector ?? "");
          expect(inputs.length, suite.id).toBeGreaterThan(0);
          for (const spec of specs) {
            expect(
              inputs.some(
                (input) => spec === input || spec.startsWith(`${input}/`),
              ),
              spec,
            ).toBe(true);
          }
        }
        for (const spec of specs) {
          const selection = changedBrowserSuiteSpecs([spec], { root: ROOT });
          const legs = ciBrowserSuiteLegs(selection);
          const matrix = planUiPlaygroundMatrix({
            selectedSpecs: [],
            allSpecs: [],
            eventName: "pull_request",
            desktopRequired: false,
            suiteLegs: parseCiBrowserSuiteLegs(JSON.stringify(legs)),
          });
          const leg = matrix.find(({ suite: name }) => name === pr.leg);
          expect(leg?.specs, spec).toContain(spec);
          expect(suiteMembers(suite.id, leg?.specs ?? [], ROOT), spec).toEqual([
            spec,
          ]);
        }
        break;
      }
      case "production-leg": {
        for (const step of steps) {
          expect(step.if, suite.id).toContain("matrix.shard == 1");
          expect(step.run, suite.id).toContain(
            `ci-browser-suites.ts specs ${suite.id}`,
          );
        }
        for (const spec of specs) {
          const plan = selectedE2ePlan([spec], ROOT);
          expect(plan.status, spec).toBe("selected");
          expect(plan.matrix.shard, spec).toContain(1);
          expect(plan.specs, spec).toEqual([]);
          expect(plan.suiteSpecs, spec).toEqual([spec]);
        }
        expect(pullRequestScope([probe]).e2e_production_required).toBe("true");
        break;
      }
      case "playground-selection": {
        for (const spec of specs) {
          expect(selectGeometrySpecs([spec], ROOT), spec).toContain(spec);
        }
        break;
      }
      case "production-selection": {
        const plan = selectedE2ePlan([probe], ROOT);
        const selected =
          plan.status === "full" ||
          plan.specs.includes(probe) ||
          (probe === ROUTE_SMOKE_SPEC_PATH &&
            plan.matrix.shard.includes("network-baseline"));
        expect(selected, suite.id).toBe(true);
        expect(pullRequestScope([probe]).e2e_production_required).toBe("true");
        break;
      }
      case "scope": {
        expect(pullRequestScope([probe])[pr.output], suite.id).toBe("true");
        const consumer =
          suite.job === "ci-browser"
            ? jobOf("ci-plan").outputs?.["ci_browser_required"]
            : jobOf(suite.job).if;
        expect(consumer, suite.id).toContain(pr.output);
        break;
      }
      case "armed-proof": {
        expect(heavy, suite.id).toContain(suite.job);
        expect(jobOf(suite.job).if, suite.id).toContain(
          "heavy_proof == 'true'",
        );
        break;
      }
      default: {
        pr satisfies never;
        throw new Error("Unknown browser suite PR path");
      }
    }
  }
}, 180_000);

test("a changed helper selects the specs that import it, and nothing else", () => {
  const [spec] = browserSuiteSpecs(
    BROWSER_SUITES.find(({ id }) => id === "ui-components") ??
      expect.unreachable("Missing ui-components"),
    ROOT,
  );
  if (spec === undefined) {
    throw new Error("No component specs");
  }
  expect(changedBrowserSuiteSpecs([spec], { root: ROOT })).toEqual({
    "ui-components": [spec],
  });
  expect(changedBrowserSuiteSpecs(["README.md"], { root: ROOT })).toEqual({});
  const all = changedBrowserSuiteSpecs([], { root: ROOT, all: true });
  expect(all["ui-components"]?.length).toBeGreaterThan(1);
  expect(all["extension"]?.length).toBeGreaterThan(0);
});
