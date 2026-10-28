import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Script } from "node:vm";

import { parseBunLockText } from "./bun-lock-text";
import {
  type ChangedFileScopeDetectors,
  computeChangedFileScope,
  DEFAULT_DETECTORS,
  MODEL_CATALOG_DRIFT_INPUTS,
  STACK_REDACTION_BROWSER_INPUTS,
} from "./ci-plan-scope";
import { rootCheckGate } from "./ci-root-check-gate";
import { withoutStaticReuseCondition } from "./ci-static-checks.test-support";
import { HEAVY_PROOF_GATE } from "./heavy-proof-gate";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const script = path.join(import.meta.dirname, "detect-e2e-changes.sh");
const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");
// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
const shellExpansion = (value: string) => ["$", "{", value, "}"].join("");
const changedFileScope = (
  file: string,
  eventName = "pull_request",
  detectorOverrides: Partial<ChangedFileScopeDetectors> = {},
) =>
  computeChangedFileScope(
    {
      changedFiles: [file],
      comparisonBase: "base",
      scopeUnknown: false,
      eventName,
      suiteDepth: "fast",
      heavyOnly: false,
      prTitle: "",
    },
    {
      ...DEFAULT_DETECTORS,
      packageChecks: () => true,
      landingBuild: () => false,
      landingDeploy: () => false,
      desktopBrowser: () => false,
      ...detectorOverrides,
    },
  );
const workflow = readFileSync(
  path.join(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf-8",
);
const ciWorkflow = Bun.YAML.parse(workflow);
const ciChecksRestSteps = workflowJobSteps(ciWorkflow, "ci-checks-rest");
const ciChecksRestStep = (name: string) =>
  workflowStepByName(ciChecksRestSteps, name);
const nightlyWorkflow = readFileSync(
  path.join(import.meta.dirname, "../.github/workflows/nightly-test.yml"),
  "utf-8",
);
const playwrightSetup = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/actions/setup-playwright/action.yml",
  ),
  "utf-8",
);
const e2eStackSetup = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/actions/setup-e2e-stack/action.yml",
  ),
  "utf-8",
);
const productionE2eSetup = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/actions/setup-production-e2e/action.yml",
  ),
  "utf-8",
);
const marketingWorkflow = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/workflows/marketing-screenshots.yml",
  ),
  "utf-8",
);
const marketingUpdateWorkflow = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/workflows/marketing-screenshots-update.yml",
  ),
  "utf-8",
);
const marketingCaptureWorkflow = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/workflows/marketing-screenshots-capture.yml",
  ),
  "utf-8",
);
const marketingPublishWorkflow = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/workflows/marketing-screenshots-publish.yml",
  ),
  "utf-8",
);
const marketingCapture = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/actions/marketing-capture/action.yml",
  ),
  "utf-8",
);

// This contract is exercised before CI installs dependencies.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const contractRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new TypeError("Expected workflow object");
  }
  return value;
};
const requiredExpression = (value: unknown) => {
  if (typeof value !== "string") {
    throw new TypeError("Missing workflow expression");
  }
  return value;
};
type ContractStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
const contractStep = (value: unknown): ContractStep => {
  const record = contractRecord(value);
  const step: ContractStep = {};
  for (const field of ["name", "uses", "run"] as const) {
    if (record[field] !== undefined) {
      step[field] = requiredExpression(record[field]);
    }
  }
  if (record["with"] !== undefined) {
    step.with = contractRecord(record["with"]);
  }
  return step;
};
type ContractJob = {
  if?: string;
  needs?: string | string[];
  with?: Record<string, unknown>;
  outputs?: Record<string, string>;
  steps?: ContractStep[];
};
const contractJob = (value: unknown): ContractJob => {
  const record = contractRecord(value);
  const job: ContractJob = {};
  if (record["if"] !== undefined) {
    job.if = requiredExpression(record["if"]);
  }
  if (record["needs"] !== undefined) {
    const needs = record["needs"];
    job.needs = Array.isArray(needs)
      ? needs.map(requiredExpression)
      : requiredExpression(needs);
  }
  if (record["with"] !== undefined) {
    job.with = contractRecord(record["with"]);
  }
  if (record["outputs"] !== undefined) {
    job.outputs = Object.fromEntries(
      Object.entries(contractRecord(record["outputs"])).map(
        ([key, output]) => [key, requiredExpression(output)] as const,
      ),
    );
  }
  if (record["steps"] !== undefined) {
    const steps = record["steps"];
    if (!Array.isArray(steps)) {
      throw new TypeError("Expected workflow steps array");
    }
    job.steps = steps.map(contractStep);
  }
  return job;
};
const contractWorkflow = (value: unknown) => ({
  jobs: Object.fromEntries(
    Object.entries(contractRecord(contractRecord(value)["jobs"])).map(
      ([key, job]) => [key, contractJob(job)] as const,
    ),
  ),
});
const ciContract = contractWorkflow(Bun.YAML.parse(workflow));
const marketingContract = contractWorkflow(Bun.YAML.parse(marketingWorkflow));
const mainHeavyContract = contractWorkflow(
  Bun.YAML.parse(
    readFileSync(
      path.join(import.meta.dirname, "../.github/workflows/main-heavy.yml"),
      "utf-8",
    ),
  ),
);
const evaluateExpression = (expression: string, context: object) =>
  new Script(
    expression
      .replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/u, "$1")
      .replaceAll(
        /needs\.([\w-]+)/gu,
        (_, job: string) => `needs[${JSON.stringify(job)}]`,
      ),
  ).runInNewContext(context);
const checkoutRefs = Object.values(ciContract.jobs).flatMap((job) =>
  (job.steps ?? []).filter(
    (step) =>
      step.uses?.startsWith("actions/checkout@") &&
      step.with?.["ref"] !== undefined,
  ),
);
const marketingCheckout = (job: string) => {
  const checkout = marketingContract.jobs[job]?.steps?.find(
    ({ name }) => name === "Checkout",
  );
  if (!checkout) {
    throw new Error(`Missing marketing ${job} checkout`);
  }
  return requiredExpression(checkout.with?.["ref"]);
};

// Job bodies are sliced from the workflow text for text assertions, while
// their steps come from the whole parsed workflow: a step may be a YAML alias
// whose anchor sits in another job, which the slice alone cannot resolve.
const parsedWorkflows = new Map<string, Record<string, unknown>>();
const jobSlices = new Map<string, { source: string; jobId: string }>();

const parsedJobs = (source: string): Record<string, unknown> => {
  const cached = parsedWorkflows.get(source);
  if (cached !== undefined) {
    return cached;
  }
  const jobs = contractRecord(contractRecord(Bun.YAML.parse(source))["jobs"]);
  parsedWorkflows.set(source, jobs);
  return jobs;
};

const jobOf = (source: string, jobId: string): string => {
  const marker = `\n  ${jobId}:\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow is missing job ${jobId}`);
  }
  const bodyStart = start + marker.length;
  const nextJob = source.slice(bodyStart).search(/\n {2}[a-z][\w-]*:\n/u);
  const slice =
    nextJob === -1
      ? source.slice(bodyStart)
      : source.slice(bodyStart, bodyStart + nextJob);
  jobSlices.set(slice, { source, jobId });
  return slice;
};

const workflowJob = (jobId: string): string => jobOf(workflow, jobId);

// Workflow steps sit two levels deeper than composite-action steps, so the
// marker indent is what tells the two apart.
const stepOf = (source: string, stepName: string, indent: number): string => {
  const pad = " ".repeat(indent);
  const marker = `\n${pad}- name: ${stepName}\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing step ${stepName}`);
  }
  const bodyStart = start + marker.length;
  const nextStep = source
    .slice(bodyStart)
    .search(new RegExp(`\\n {${indent}}- name:`, "u"));
  return nextStep === -1
    ? source.slice(bodyStart)
    : source.slice(bodyStart, bodyStart + nextStep);
};

const workflowStepValue = (job: string, stepName: string) => {
  const origin = jobSlices.get(job);
  const parsedJob = contractRecord(
    origin === undefined
      ? contractRecord(Bun.YAML.parse(`job:\n${job}`))["job"]
      : parsedJobs(origin.source)[origin.jobId],
  );
  return workflowStepByName(parsedJob["steps"], stepName);
};

const actionStep = (action: string, stepName: string): string =>
  stepOf(action, stepName, 4);

const expectPullRequestAndMergeGroup = (source: string) => {
  expect(source).toContain("github.event_name == 'pull_request'");
  expect(source).toContain("github.event_name == 'merge_group'");
};

const workflowStepRun = (job: string, stepName: string): string =>
  requiredExpression(workflowStepValue(job, stepName)["run"]);

const detects = (
  scope: "core" | "landing" | "marketing" | "pr-core",
  files: string[],
) =>
  Bun.spawnSync(["bash", script, scope, ...files], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();

describe("detect-e2e-changes", () => {
  test("selects a nested parallel step without absorbing its sibling", () => {
    const job = `    runs-on: ubuntu-latest
    steps:
      - parallel:
          - name: Selected check
            if: ${githubExpression("steps.setup.outputs.enabled == 'true'")}
            with:
              manifest: ${githubExpression("steps.setup.outputs.manifest")}
              options:
                mode: strict
            run: |-
              bun test scripts/selected.test.ts
          - name: Neighboring check
            run: bun test scripts/neighboring.test.ts
`;

    const selected = workflowStepValue(job, "Selected check");
    expect(selected["if"]).toBe(
      githubExpression("steps.setup.outputs.enabled == 'true'"),
    );
    expect(selected["with"]).toEqual({
      manifest: githubExpression("steps.setup.outputs.manifest"),
      options: { mode: "strict" },
    });
    expect(workflowStepRun(job, "Selected check")).toBe(
      "bun test scripts/selected.test.ts",
    );
    expect(workflowStepRun(job, "Selected check")).not.toContain(
      "scripts/neighboring.test.ts",
    );
  });

  test("skips documentation-only changes", () => {
    expect(detects("core", ["README.md"])).toBe("false");
    expect(detects("landing", ["README.md"])).toBe("false");
  });

  test("runs product-code changes through core", () => {
    const files = ["apps/api/src/handlers/tasks/get.ts"];
    expect(detects("core", files)).toBe("true");
    expect(detects("landing", files)).toBe("false");
  });

  test.each([
    ".github/actions/prepare-network-baseline/action.yml",
    ".github/actions/prepare-network-baseline/prepare.sh",
    "scripts/network-baseline-scope.ts",
    "scripts/network-baseline-comparison.test.ts",
  ])("network comparison inputs require core E2E: %s", (file) => {
    expect(detects("core", [file])).toBe("true");
    expect(detects("landing", [file])).toBe("false");
  });

  test("a marketing-test-only change waits for the nightly suite", () => {
    const files = ["apps/web/e2e/marketing/product-screenshots.spec.ts"];
    expect(detects("core", files)).toBe("false");
    expect(detects("landing", files)).toBe("false");
  });

  test("keeps a landing-only change out of app E2E", () => {
    for (const file of [
      "apps/landing/src/pages/index.astro",
      "apps/landing/e2e/landing-navigation.spec.ts",
    ]) {
      expect(detects("core", [file])).toBe("false");
      expect(detects("landing", [file])).toBe("true");
    }
  });

  test("the shared marketing config exercises the landing project", () => {
    const files = ["packages/playwright-tools/src/marketing-config.ts"];
    expect(detects("core", files)).toBe("false");
    expect(detects("landing", files)).toBe("true");
  });

  test("the web package manifest exercises its core commands", () => {
    const files = ["apps/web/package.json"];
    expect(detects("core", files)).toBe("true");
    expect(detects("landing", files)).toBe("false");
  });

  test("routes every input of a product screenshot through the marketing scope", () => {
    // A file that really ships: a font the captured app renders with, so a
    // rename breaks this list instead of leaving the scope pointing at
    // nothing.
    const renderedFont =
      "apps/web/public/fonts/dm-sans-latin-wght-normal.woff2";
    expect(existsSync(path.join(import.meta.dirname, "..", renderedFont))).toBe(
      true,
    );
    // Public assets are already product code to the core scope; the marketing
    // scope is what changes here.
    expect(detects("core", [renderedFont])).toBe("true");
    expect(detects("landing", [renderedFont])).toBe("false");

    for (const file of [
      renderedFont,
      "apps/web/src/components/inspector/entity-metadata-panel.tsx",
      "apps/web/e2e/marketing/product-screenshots.spec.ts",
      "apps/web/e2e/playwright.marketing.config.ts",
      "apps/web/package.json",
      "apps/api/src/handlers/entities/routes.ts",
      "apps/api/scripts/seed-dev.ts",
      "apps/api/scripts/seed-test-user.ts",
      "apps/api/scripts/seed-utils.ts",
      "packages/ui/src/components/button.tsx",
      "packages/locales/src/en.ts",
      "apps/landing/public/media/products/editor.png",
      ".github/workflows/marketing-screenshots.yml",
      ".github/actions/marketing-capture/action.yml",
    ]) {
      expect(detects("marketing", [file])).toBe("true");
    }

    for (const file of [
      "README.md",
      "docs/changelog/0.7.8.md",
      "apps/landing/src/pages/index.astro",
      "apps/web/e2e/specs/route-smoke.spec.ts",
    ]) {
      expect(detects("marketing", [file])).toBe("false");
    }
  });

  test("runs both PR scopes when their orchestration changes", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/actions/setup-e2e-stack/action.yml",
      ".github/actions/setup-production-e2e/action.yml",
      ".github/actions/build-e2e-web/action.yml",
      ".github/actions/setup-playwright/action.yml",
      // Every E2E job installs through these files.
      ".github/actions/ci-install/action.yml",
      "scripts/ci-install.ts",
      "scripts/ci-install-store.ts",
    ]) {
      expect(detects("core", [file])).toBe("true");
      expect(detects("landing", [file])).toBe("true");
    }
  });

  test("plans trust and changed scopes in one security gate", () => {
    const plan = workflowJob("ci-plan");
    const planStepNames = workflowJobSteps(ciWorkflow, "ci-plan").map(
      (step) => step["name"],
    );
    expect(workflow).not.toContain("\n  trust-check:\n");
    expect(workflow).not.toContain("\n  ci-changes:\n");
    expect(planStepNames.indexOf("Check if PR is trusted")).toBeLessThan(
      planStepNames.indexOf("Checkout"),
    );
    expect(planStepNames.indexOf("Checkout")).toBeLessThan(
      planStepNames.indexOf("Check changed file scope"),
    );
    expect(plan).toContain("persist-credentials: false");
    for (const stepName of [
      "Checkout",
      "Resolve available CI images",
      "Plan release marketing screenshots",
      "Check changed file scope",
    ]) {
      expect(
        requiredExpression(workflowStepValue(plan, stepName)["if"]),
        stepName,
      ).toContain("steps.check.outputs.trusted == 'true'");
    }
    // Bun comes only from the trusted workflow revision, never from the PR checkout.
    expect(
      workflowStepValue(plan, "Setup Bun for planning")["with"],
    ).toMatchObject({
      "bun-version-file": ".workflow-tooling/package.json",
    });
    expect(
      requiredExpression(
        workflowStepValue(plan, "Resolve available CI images")["if"],
      ),
    ).toBe(
      "steps.completed-depth.outputs.run_required != 'false' && (steps.check.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch')",
    );
    expect(workflow).not.toContain("needs.trust-check");
    expect(workflow).not.toContain("needs.ci-changes");
  });

  test("runs Redis collaboration checks for every owning boundary", () => {
    const plan = workflowJob("ci-plan");
    const serviceSuites = workflowJob("service-suites");
    const collabRedis = workflowStepValue(
      serviceSuites,
      "Run cross-replica collaboration suite",
    );

    for (const collaborationPath of [
      "apps/collab/*",
      "apps/api/src/handlers/folio-collab/*",
      "apps/api/src/handlers/entities/join-folio-collab-room.ts",
      "apps/api/src/lib/folio-collab-*",
      "packages/api-contract/src/folio-collab*",
    ]) {
      expect(
        changedFileScope(collaborationPath.replaceAll("*", "fixture"))
          .collab_redis_required,
        collaborationPath,
      ).toBe("true");
    }
    expect(plan).toContain(
      `service_suites_required: ${githubExpression("steps.changed-files.outputs.package_checks_required == 'true' || steps.changed-files.outputs.collab_redis_required == 'true'")}`,
    );
    expect(serviceSuites).toContain(
      "needs.ci-plan.outputs.service_suites_required == 'true'",
    );
    expect(requiredExpression(collabRedis["if"])).toBe(
      githubExpression(
        "!cancelled() && needs.ci-plan.outputs.collaboration_suite_required == 'true' && (github.event_name != 'pull_request' || vars.CI_POSTGRES_PR_SELECTION == 'on') && (needs.ci-plan.outputs.suite_depth == 'full' || (needs.ci-plan.outputs.suite_depth == 'fast' && needs.ci-plan.outputs.service_suites_pr_required == 'true'))",
      ),
    );
    expect(requiredExpression(collabRedis["run"])).toBe(
      "bun --filter @stll/collab test src/server.test.ts",
    );
    const result = workflowJob("ci-result");
    expect(result).toContain("service-suites,");
    expect(result).toContain('"service-suites": "service_suites_required"');
  });

  test("keeps production, Vite canary, and landing work parallel", () => {
    const production = workflowJob("e2e-production-shard");
    expect(production).toContain(
      "E2E_EXECUTION_PROFILE: ci-production-parallel",
    );
    expect(production).not.toContain("Run Vite dependency canary");
    expect(production).not.toContain("Check landing islands");

    const canary = workflowJob("e2e-vite-canary");
    expect(canary).not.toContain("E2E_EXECUTION_PROFILE");
    expect(canary).not.toContain("Build web for route checks");
    expect(canary).not.toContain("Run Playwright shard");
    const canaryRun = workflowStepRun(canary, "Run Vite dependency canary");
    expect(canaryRun).toBe(
      [
        'bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh"',
        "bun --filter @stll/web test:e2e --",
        "e2e/specs/vite-dependency-canary.spec.ts",
        "--project chromium",
      ].join(" "),
    );
    expect(canaryRun).not.toMatch(/--grep(?:=|\s)+["']?@dev-canary/u);

    const landing = workflowJob("e2e-landing");
    expect(landing).not.toContain("Start docker stack");
    expect(landing).not.toContain("Start API server");

    // ci-result reads the browser suites directly, without an aggregating hop.
    expect(workflow).not.toContain("\n  e2e:\n");
    const result = workflowJob("ci-result");
    for (const requiredJob of [
      "e2e-production-shard",
      "e2e-vite-canary",
      "e2e-landing",
    ]) {
      expect(result).toContain(`        ${requiredJob},\n`);
    }

    // The route network baseline has a leg of its own, and the Playwright
    // shards skip it there.
    expect(production).toContain(
      `shard: ${githubExpression("fromJSON(needs.ci-plan.outputs.e2e_production_matrix).shard")}`,
    );
    expect(workflowJob("ci-plan")).toContain(
      "matrix=$(bun scripts/e2e-spec-shards-core.ts all)",
    );
    expect(
      requiredExpression(
        workflowStepValue(production, "Check route network baseline")["if"],
      ),
    ).toContain("matrix.shard == 'network-baseline'");
    for (const stepName of [
      "Run Playwright shard",
      "Run route-smoke Playwright shard",
    ]) {
      expect(
        requiredExpression(workflowStepValue(production, stepName)["if"]),
        stepName,
      ).toContain("matrix.shard != 'network-baseline'");
    }
  });

  test("plans e2e outputs from selection and fallback semantics", () => {
    const plan = workflowStepRun(
      workflowJob("ci-plan"),
      "Plan changed PR e2e shards",
    );
    const fullMatrix = '{"shard":["full","network-baseline"]}';
    // A merge group that runs route-smoke drops the duplicate network leg.
    const fullWithoutNetwork = '{"shard":["full"]}';
    const selectedMatrix = '{"shard":["selected"]}';
    const selectedSpecs = '["e2e/specs/selected.spec.ts"]';
    const planEnv = workflowStepByName(
      workflowJobSteps(ciWorkflow, "ci-plan"),
      "Plan changed PR e2e shards",
    )["env"];
    const declaredEnv =
      typeof planEnv === "object" && planEnv !== null
        ? Object.keys(planEnv)
        : [];
    expect(declaredEnv).toContain("ROUTE_SMOKE_REQUIRED");
    const root = mkdtempSync(path.join(tmpdir(), "e2e-plan-outputs-"));
    const output = path.join(root, "outputs");
    try {
      for (const event of [
        "pull_request",
        "merge_group",
        "workflow_dispatch",
      ]) {
        for (const outcome of ["success", "failure", "skipped"]) {
          for (const matrix of ["", '{"shard":[]}', selectedMatrix]) {
            for (const [required, routeSmoke] of [
              ["true", "true"],
              ["true", "false"],
              ["false", "true"],
              ["false", "false"],
            ] as const) {
              writeFileSync(output, "fixture=preserved\n");
              const env = {
                PATH: "/usr/bin:/bin",
                GITHUB_OUTPUT: output,
                EVENT_NAME: event,
                SELECTOR_OUTCOME: outcome,
                SELECTED_MATRIX: matrix,
                SELECTED_MODE: "selected",
                SELECTED_SPECS: selectedSpecs,
                E2E_PRODUCTION_REQUIRED: required,
                ROUTE_SMOKE_REQUIRED: routeSmoke,
                FULL_MATRIX: fullMatrix,
              };
              // The harness supplies every variable the step declares, so a
              // new step input fails here instead of as an unbound variable.
              expect(Object.keys(env)).toEqual(
                expect.arrayContaining(declaredEnv),
              );
              const result = Bun.spawnSync(
                [
                  "/bin/bash",
                  "-c",
                  [
                    'bun() { [[ "$*" == "scripts/e2e-spec-shards-core.ts all" ]] || return 91; printf "%s\\n" "$FULL_MATRIX"; }',
                    plan,
                  ].join("\n"),
                ],
                {
                  cwd: root,
                  env,
                  stdout: "pipe",
                  stderr: "pipe",
                },
              );
              expect(result.exitCode, result.stderr.toString()).toBe(0);
              const usesSelection =
                event === "pull_request" &&
                outcome === "success" &&
                matrix !== "";
              const emptySelection = usesSelection && matrix === '{"shard":[]}';
              let expectedMatrix = fullMatrix;
              if (usesSelection) {
                expectedMatrix = matrix;
              } else if (event === "merge_group" && routeSmoke === "true") {
                expectedMatrix = fullWithoutNetwork;
              }
              expect(readFileSync(output, "utf-8").trim().split("\n")).toEqual([
                "fixture=preserved",
                `matrix=${expectedMatrix}`,
                `mode=${usesSelection ? "selected" : "full"}`,
                `specs=${usesSelection ? selectedSpecs : "[]"}`,
                `selection_required=${String(!emptySelection)}`,
                `required=${emptySelection ? "false" : required}`,
              ]);
            }
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(
      ciContract.jobs["ci-plan"]?.outputs?.["e2e_production_required"],
    ).toBe(githubExpression("steps.e2e-pr-plan.outputs.required"));
  });

  test("starts only infrastructure exercised by pull request E2E", () => {
    expect(workflowJob("e2e-production-shard")).toContain(
      "uses: ./.github/actions/setup-production-e2e",
    );
    expect(productionE2eSetup).toContain(
      "uses: ./.github/actions/setup-e2e-stack",
    );
    expect(workflowJob("e2e-vite-canary")).toContain(
      "uses: ./.github/actions/setup-e2e-stack",
    );
    expect(workflowJob("e2e-production-shard")).not.toContain("gotenberg");
    expect(workflowJob("e2e-vite-canary")).not.toContain("gotenberg");
    expect(e2eStackSetup).toContain("- name: Start docker stack");
    const composeStartLines = e2eStackSetup
      .split("\n")
      .filter((line) => line.includes("docker compose --profile dev up"))
      .map((line) => line.trim());
    expect(composeStartLines).toEqual([
      `if docker compose --profile dev up -d --wait postgres rustfs valkey "${shellExpansion("extra_services[@]")}" 2>&1 \\`,
    ]);
    // The shared action names no optional service itself; each caller declares
    // what it exercises, so a new consumer cannot quietly widen the stack the
    // PR jobs pay for.
    expect(e2eStackSetup).not.toContain("gotenberg");
    expect(marketingWorkflow).not.toContain("gotenberg");
    expect(marketingCapture).toContain("extra-services: gotenberg");
  });

  test("a Docker Hub pull rate limit fails the job with a typed infrastructure reason", () => {
    const rateLimit = e2eStackSetup.slice(
      e2eStackSetup.indexOf("grep -Eqi 'toomanyrequests:.*pull rate limit'"),
    );
    expect(rateLimit).not.toBe(e2eStackSetup);
    const branch = rateLimit.slice(0, rateLimit.indexOf("\n          fi"));
    expect(branch).toContain("kind=infra class=e2e-stack-rate-limited");
    expect(branch.trimEnd()).toEndWith("exit 1");
    // No readiness output: a stack that is not ready fails the setup step.
    expect(e2eStackSetup).not.toContain("outputs.status");
    expect(e2eStackSetup).not.toContain("status=");
    expect(productionE2eSetup).not.toContain("outputs.status");
    const action: unknown = Bun.YAML.parse(e2eStackSetup);
    if (
      !isRecord(action) ||
      !isRecord(action["runs"]) ||
      !Array.isArray(action["runs"]["steps"])
    ) {
      throw new TypeError("Shared E2E action must declare composite steps");
    }
    const stackSteps = action["runs"]["steps"].map((value: unknown) => {
      if (!isRecord(value)) {
        throw new TypeError("Shared E2E action step must be an object");
      }
      const text = (key: string) => {
        const field = value[key];
        if (field === undefined || typeof field === "string") {
          return field;
        }
        throw new TypeError(`Shared E2E action step ${key} must be text`);
      };
      return { name: text("name"), id: text("id"), if: text("if") };
    });
    const stackIndex = stackSteps.findIndex((step) => step.id === "stack");
    expect(stackIndex).toBeGreaterThanOrEqual(0);
    const cleanupSteps = stackSteps.filter((step) =>
      step.name?.startsWith("Log out of "),
    );
    expect(cleanupSteps.map(({ name }) => name)).toEqual([
      "Log out of GitHub Container Registry",
      "Log out of Docker Hub",
    ]);
    for (const cleanup of cleanupSteps) {
      expect(cleanup.if, cleanup.name).toStartWith("always()");
      const cleanupIndex = stackSteps.indexOf(cleanup);
      expect(cleanupIndex, cleanup.name).toBeGreaterThan(stackIndex);
      expect(cleanupIndex, cleanup.name).toBeLessThan(
        stackSteps.findIndex(
          (step) => step.name === "Prepare API runtime sources",
        ),
      );
    }
    const afterStack = stackSteps
      .slice(stackIndex + 1)
      .filter((step) => !cleanupSteps.includes(step));
    expect(afterStack.length).toBeGreaterThan(0);
    const assertReady = (steps: typeof afterStack) => {
      for (const step of steps) {
        expect(step.if, step.name).toBe("steps.stack.outcome == 'success'");
      }
    };
    assertReady(afterStack);
    for (const [index, step] of afterStack.entries()) {
      const mutation = afterStack.map((entry, position) =>
        position === index ? { ...entry, if: "always()" } : entry,
      );
      expect(mutation.at(index)?.if).not.toBe(step.if);
      expect(() => assertReady(mutation)).toThrow("steps.stack.outcome");
    }

    for (const stepName of [
      "Install Playwright browsers",
      "Download production web build",
      "Validate production web build",
      "Start production web server",
      "Wait for production web server",
    ]) {
      expect(actionStep(productionE2eSetup, stepName)).toContain(
        "steps.stack.outcome == 'success'",
      );
    }
    expect(
      actionStep(productionE2eSetup, "Start docker stack and API server"),
    ).toContain("id: stack");
    const productionJob = workflowJob("e2e-production-shard");
    expect(
      workflowStepValue(productionJob, "Setup production browser stack")["id"],
    ).toBe("e2e-stack");
    for (const stepName of [
      "Run Playwright shard",
      "Upload Playwright blob report",
    ]) {
      expect(
        requiredExpression(workflowStepValue(productionJob, stepName)["if"]),
      ).toContain("steps.e2e-stack.outcome == 'success'");
    }
    // A setup that fails after starting its servers still leaves logs.
    expect(
      requiredExpression(
        workflowStepValue(productionJob, "Upload server logs")["if"],
      ),
    ).toBe("failure() && steps.e2e-stack.outcome != 'skipped'");
    const canary = workflowJob("e2e-vite-canary");
    expect(
      workflowStepValue(canary, "Start docker stack and API server")["id"],
    ).toBe("e2e-stack");
    for (const stepName of [
      "Start web dev server",
      "Wait for web dev server",
      "Install Playwright browsers",
      "Run Vite dependency canary",
      "Guard against mid-test Vite re-optimize",
      "Stop web dev server",
      "Upload Playwright blob report",
    ]) {
      expect(
        requiredExpression(workflowStepValue(canary, stepName)["if"]),
      ).toContain("steps.e2e-stack.outcome == 'success'");
    }
  });

  // Measured p95: 12.7 s; this must evaluate the real workflow and repository scope.
  test("keeps full code quality for manual sweeps and scopes pull requests", () => {
    expect(
      changedFileScope("docs/development.md", "pull_request", {
        packageChecks: () => false,
      }).package_checks_required,
    ).toBe("false");
    expect(
      changedFileScope("docs/development.md", "workflow_dispatch", {
        packageChecks: () => false,
      }).package_checks_required,
    ).toBe("true");
    for (const { leg, job, name } of [
      { leg: "api", job: "code-quality-api", name: "Code quality" },
      { leg: "web", job: "code-quality-web-rest", name: "Code quality (web)" },
      {
        leg: "rest",
        job: "code-quality-web-rest",
        name: "Code quality (rest)",
      },
    ]) {
      const step = workflowStepByName(workflowJobSteps(ciWorkflow, job), name);
      const env = contractRecord(step["env"]);
      expect(env["EVENT_NAME"]).toBe(githubExpression("github.event_name"));
      expect(env["CHECK_BASE_REF"]).toBe(
        githubExpression("format('origin/{0}', github.base_ref || 'main')"),
      );
      expect(requiredExpression(step["run"])).toBe(
        [
          'if [[ "$EVENT_NAME" == "workflow_dispatch" ]]; then',
          `  bun run code-check -- --leg ${leg}`,
          "  exit 0",
          "fi",
          `bun run code-check:affected -- --leg ${leg} --base "$CHECK_BASE_REF"`,
          "",
        ].join("\n"),
      );
    }
  }, 30_000);

  test("runs the full native compiler only at the release boundary", () => {
    const plan = workflowJob("ci-plan");
    expect(plan).toContain(
      `release_typecheck_required: ${githubExpression("steps.changed-files.outputs.release_typecheck_required")}`,
    );
    expect(changedFileScope("VERSION").release_typecheck_required).toBe("true");
    expect(
      changedFileScope("apps/web/src/main.tsx").release_typecheck_required,
    ).toBe("false");

    const releaseTypecheck = workflowJob("release-typecheck");
    expect(releaseTypecheck).toContain(
      "needs.ci-plan.outputs.release_typecheck_required == 'true'",
    );
    // Release compiles gate merge groups, armed pull requests and heavy
    // runs, never an unarmed pull request.
    expect(releaseTypecheck).toContain(HEAVY_PROOF_GATE);
    expect(releaseTypecheck).toContain("(github.event_name == 'merge_group'");
    expect(releaseTypecheck).toContain(
      "run: bun run typecheck --concurrency=1 && bun run typecheck:repo",
    );
    expect(releaseTypecheck).toContain('TURBO_FORCE: "true"');

    const result = workflowJob("ci-result");
    expect(result).toContain("release-typecheck");
  });

  test("revalidates release invariants on the merge queue tree", () => {
    for (const stepName of [
      "Release changelog guard",
      "Release CLI coupling guard",
      "Release marketing provenance warning",
    ]) {
      expectPullRequestAndMergeGroup(
        requiredExpression(ciChecksRestStep(stepName)["if"]),
      );
    }
  });

  test("checks the generated model snapshots only when their inputs change", () => {
    const plan = workflowJob("ci-plan");
    expect(plan).toContain(
      `model_catalog_drift_required: ${githubExpression("steps.changed-files.outputs.model_catalog_drift_required")}`,
    );
    expect(new Set(MODEL_CATALOG_DRIFT_INPUTS)).toEqual(
      new Set([
        ".github/workflows/ci.yml",
        "packages/ai-catalog/package.json",
        "packages/ai-catalog/src/capabilities-overrides.ts",
        "packages/ai-catalog/src/capabilities.gen.ts",
        "packages/ai-catalog/src/document-input-overrides.ts",
        "packages/ai-catalog/src/index.ts",
        "packages/ai-catalog/src/model-defaults-ledger.ts",
        "packages/ai-catalog/src/model-rate-policy.ts",
        "packages/ai-catalog/src/model-rate.ts",
        "packages/ai-catalog/src/model-rates.gen.ts",
        "packages/ai-catalog/src/reasoning-capabilities.ts",
        "packages/fetch/src/connection-failure.ts",
        "packages/fetch/src/index.ts",
        "packages/scripts/src/model-catalog-capabilities-gen.ts",
        "packages/scripts/src/model-catalog-capabilities.ts",
        "packages/scripts/src/model-catalog-rates-gen.ts",
        "packages/scripts/src/model-catalog-snapshot.ts",
      ]),
    );
    for (const input of MODEL_CATALOG_DRIFT_INPUTS) {
      expect(changedFileScope(input).model_catalog_drift_required, input).toBe(
        "true",
      );
    }

    const driftGuard = ciChecksRestStep("Model catalog snapshot drift check");
    const driftGuardCondition = requiredExpression(
      withoutStaticReuseCondition(driftGuard)["if"],
    );
    const driftGuardRun = requiredExpression(driftGuard["run"]);
    expect(driftGuardCondition).toContain(
      "needs.ci-plan.outputs.model_catalog_drift_required == 'true'",
    );
    expect(driftGuardRun).toContain(
      "bun --filter @stll/ai-catalog gen:rates --check",
    );
    expect(driftGuardRun).toContain(
      "bun --filter @stll/ai-catalog gen:capabilities --check",
    );
    // Path-scoped: the drift output is a required operand, never one of
    // several alternatives. The package-checks operand only ties the step to
    // the dependency install its generators import from.
    expect(driftGuardCondition).toMatch(
      /needs\.ci-plan\.outputs\.package_checks_required == 'true'\s*&&\s*needs\.ci-plan\.outputs\.model_catalog_drift_required == 'true'/u,
    );
    expect(driftGuardCondition).toBe(
      githubExpression(
        `!cancelled() && steps.install.outcome == 'success' && (needs.ci-plan.outputs.package_checks_required == 'true' && needs.ci-plan.outputs.model_catalog_drift_required == 'true') && ${rootCheckGate({ job: "ci-checks-rest", name: "Model catalog snapshot drift check" })}`,
      ),
    );
  });

  test("every root-check selection clause is the owner-generated required operand", () => {
    const gatedSteps = Object.entries(ciContract.jobs).flatMap(
      ([job, value]) =>
        value.steps === undefined
          ? []
          : workflowJobSteps(ciWorkflow, job)
              .filter(
                (step) =>
                  typeof step["if"] === "string" &&
                  step["if"].includes("needs.ci-plan.outputs.root_checks"),
              )
              .map((step) => ({ job, step })),
    );
    expect(gatedSteps.length).toBeGreaterThan(0);
    for (const { job, step } of gatedSteps) {
      const condition = requiredExpression(
        withoutStaticReuseCondition(step)["if"],
      );
      const gate = rootCheckGate({
        job,
        name: requiredExpression(step["name"]),
      });
      const operands = condition.split(` && ${gate}`);
      expect(operands).toHaveLength(2);
      expect(operands.at(1)).toBe(" }}");
      const prerequisites = requiredExpression(operands.at(0));
      expect(prerequisites).not.toContain("needs.ci-plan.outputs.root_checks");
      expect(prerequisites).not.toContain("||");
    }
  });

  test("checks shipped product screenshots on planned releases", () => {
    const plan = workflowJob("ci-plan");
    expect(plan).toContain(
      `marketing_screenshots_required: ${githubExpression("steps.marketing-release.outputs.required")}`,
    );
    expect(
      requiredExpression(
        workflowStepValue(plan, "Plan release marketing screenshots")["if"],
      ),
    ).toBe(
      "steps.completed-depth.outputs.run_required != 'false' && (steps.check.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch')",
    );

    const screenshots = workflowJob("marketing-screenshots");
    expect(ciContract.jobs["marketing-screenshots"]?.needs).toEqual([
      "ci-plan",
      "web-build",
      "heavy-web-build",
    ]);
    expect(screenshots).toContain("always()");
    expect(screenshots).toContain(
      "needs.ci-plan.outputs.marketing_screenshots_required == 'true'",
    );
    const predicate = requiredExpression(
      ciContract.jobs["marketing-screenshots"]?.if,
    );
    // The armed proof runs them on a pull request; a merge group whose head
    // carries it skips them.
    for (const [event, heavyProof] of [
      "pull_request",
      "merge_group",
      "workflow_dispatch",
    ].flatMap((name) => [[name, false] as const, [name, true] as const])) {
      for (const planned of [false, true]) {
        for (const trusted of [false, true]) {
          for (const buildRequired of [false, true]) {
            for (const webResult of ["success", "skipped", "failure"]) {
              for (const heavyResult of ["success", "skipped", "failure"]) {
                for (const cancelled of [false, true]) {
                  const context = {
                    github: { event_name: event },
                    inputs: { pr_depth_only: false },
                    needs: {
                      "ci-plan": {
                        outputs: {
                          queue_depth: "full",
                          run_required: "true",
                          heavy_proof: String(heavyProof),
                          trusted: String(trusted),
                          marketing_screenshots_required: String(planned),
                          web_build_required: String(buildRequired),
                        },
                      },
                      "web-build": { result: webResult },
                      "heavy-web-build": { result: heavyResult },
                    },
                    always: () => true,
                    cancelled: () => cancelled,
                  };
                  const certified =
                    heavyProof &&
                    planned &&
                    (trusted || event === "workflow_dispatch") &&
                    (!buildRequired ||
                      webResult === "success" ||
                      heavyResult === "success") &&
                    (event !== "merge_group" || !cancelled);
                  expect(Boolean(evaluateExpression(predicate, context))).toBe(
                    certified,
                  );
                  context.needs["ci-plan"].outputs.queue_depth = "thin";
                  expect(Boolean(evaluateExpression(predicate, context))).toBe(
                    certified,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(screenshots).toContain(
      "uses: ./.github/workflows/marketing-screenshots.yml",
    );
    expect(screenshots).toContain("mode: check");

    // Only the update path pushes, and only with the App token, so the check
    // job stays read-only.
    expect(screenshots).toContain("contents: read");
    expect(screenshots).not.toContain("STELLA_RELEASE_APP_PRIVATE_KEY");

    const result = workflowJob("ci-result");
    expect(result).toContain("marketing-screenshots");
  });

  test("regenerates a branch's baselines from workflow code on main", () => {
    // The release App key must only ever run workflow code from main, so the
    // update workflow is dispatched on the default branch and told which
    // branch to rewrite; a `--ref <branch>` dispatch would hand the key that
    // branch's copy of both files.
    expect(marketingUpdateWorkflow).toContain(
      [
        "      branch:",
        "        description: The same-repository branch whose baselines to regenerate",
        "        required: true",
      ].join("\n"),
    );
    expect(marketingUpdateWorkflow).toContain(
      `group: marketing-screenshots-update-${githubExpression("inputs.branch")}`,
    );
    expect(marketingUpdateWorkflow).not.toContain("--ref");

    // The dispatch on main only validates the branch and starts the capture
    // on that branch's own ref; it runs no branch code and holds no key.
    const update = jobOf(marketingUpdateWorkflow, "update");
    const validate = workflowStepRun(update, "Validate inputs");
    expect(validate).toContain('if [[ "$WORKFLOW_REF" != "main" ]]');
    expect(validate).toContain('if [[ "$BRANCH" == "main" ]]');
    expect(validate).toContain('"$BRANCH" =~ ^[A-Za-z0-9._/-]+$');
    expect(validate).toContain('"$BRANCH" == *".."*');
    expect(validate).toContain('"$BRANCH" == -*');
    expect(update).toContain(
      "workflow_id: 'marketing-screenshots-capture.yml'",
    );
    // Workflow source text, not an env read of this process.
    expect(update).toMatch(/ref: process\.env\.BRANCH,/u);
    expect(marketingUpdateWorkflow).not.toContain("secrets.");

    // The capture runs on the branch's ref and never on main; it holds no
    // push credential. The publish run mints the token only after it has
    // validated the PNGs.
    const capture = jobOf(marketingCaptureWorkflow, "capture");
    expect(capture).toContain("github.ref != 'refs/heads/main'");
    expect(capture).not.toContain("Mint App token");
    expect(capture).not.toContain("environment:");
    const publish = jobOf(marketingPublishWorkflow, "publish");
    expect(publish.indexOf("- name: Stage validated baselines")).toBeLessThan(
      publish.indexOf("- name: Mint App token"),
    );
    expect(workflowStepValue(capture, "Checkout")["with"]).toMatchObject({
      ref: githubExpression("github.sha"),
    });
    expect(checkoutRefs.length).toBeGreaterThan(0);
    for (const event of ["pull_request", "merge_group", "workflow_dispatch"]) {
      const context = {
        github: {
          event_name: event,
          workflow: "CI Checks",
          sha: "event-sha",
          workflow_sha: "workflow-sha",
        },
        inputs: {
          heavy_only: false,
          sha: "unvalidated-sha",
          ref: "unvalidated-ref",
        },
      };
      expect(evaluateExpression(marketingCheckout("check"), context)).toBe("");
      expect(
        evaluateExpression(
          requiredExpression(
            ciContract.jobs["marketing-screenshots"]?.with?.["ref"],
          ),
          context,
        ),
      ).toBe("");
      for (const checkout of checkoutRefs) {
        expect(
          evaluateExpression(
            requiredExpression(checkout.with?.["ref"]),
            context,
          ),
        ).toBe(
          checkout.with?.["path"] === ".workflow-tooling" ? "workflow-sha" : "",
        );
      }
      for (const job of Object.values(ciContract.jobs)) {
        for (const item of job.steps ?? []) {
          const expectedSha = item.with?.["expected-sha"];
          if (expectedSha !== undefined) {
            expect(
              evaluateExpression(requiredExpression(expectedSha), context),
            ).toBe("event-sha");
          }
        }
      }
    }
    const validatedSha = "a".repeat(40);
    const validationOutput = requiredExpression(
      mainHeavyContract.jobs["validate"]?.outputs?.["sha"],
    );
    const forwardedSha = evaluateExpression(validationOutput, {
      steps: { ancestor: { outputs: { sha: validatedSha } } },
    });
    const suites = mainHeavyContract.jobs["suites"];
    expect(suites?.with?.["heavy_only"]).toBe(true);
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      for (const run of ["true", "false"]) {
        expect(
          evaluateExpression(requiredExpression(suites?.if), {
            needs: { validate: { result, outputs: { run } } },
          }),
        ).toBe(result === "success" && run === "true");
      }
    }
    const callerSha = evaluateExpression(
      requiredExpression(suites?.with?.["sha"]),
      { needs: { validate: { outputs: { sha: forwardedSha } } } },
    );
    expect(callerSha).toBe(validatedSha);
    const heavyContext = {
      github: {
        workflow: "Main heavy suites",
        sha: "event-sha",
        workflow_sha: "workflow-sha",
      },
      inputs: { heavy_only: true, sha: callerSha, ref: callerSha },
    };
    for (const checkout of checkoutRefs) {
      expect(
        evaluateExpression(
          requiredExpression(checkout.with?.["ref"]),
          heavyContext,
        ),
      ).toBe(
        checkout.with?.["path"] === ".workflow-tooling"
          ? "workflow-sha"
          : validatedSha,
      );
    }
    expect(
      evaluateExpression(
        requiredExpression(
          ciContract.jobs["marketing-screenshots"]?.with?.["ref"],
        ),
        heavyContext,
      ),
    ).toBe(validatedSha);
    expect(evaluateExpression(marketingCheckout("check"), heavyContext)).toBe(
      validatedSha,
    );
    for (const job of Object.values(ciContract.jobs)) {
      for (const item of job.steps ?? []) {
        const expectedSha = item.with?.["expected-sha"];
        if (expectedSha !== undefined) {
          expect(
            evaluateExpression(requiredExpression(expectedSha), heavyContext),
          ).toBe(validatedSha);
        }
      }
    }
    const validateSteps = mainHeavyContract.jobs["validate"]?.steps ?? [];
    expect(
      validateSteps.find(({ name }) => name === "Validate SHA format")?.run,
    ).toContain("^[0-9a-f]{40}$");
    expect(
      validateSteps.find(({ name }) => name === "Verify main ancestry")?.run,
    ).toContain(
      'bash "$RUNNER_TEMP/verify-release-tree-proof.sh" --allow-pr-head "$GITHUB_REPOSITORY" "$SHA" "$SHA"',
    );
    expect(
      validateSteps.find(({ name }) => name === "Fetch main history")?.run,
    ).toContain("show origin/main:scripts/verify-release-tree-proof.sh");
    // The push is an API commit appended to the named branch: GitHub signs
    // it, so it cannot leave a person's pull request behind the
    // signed-commits rule.
    const push = workflowStepValue(publish, "Push regenerated baselines");
    expect(push["uses"]).toContain(
      "stella/.github/.github/actions/signed-commit@",
    );
    expect(push["with"]).toMatchObject({
      mode: "append",
      branch: githubExpression("steps.select.outputs.branch"),
    });

    // Nightly checks continue to use their triggering ref.
    expect(nightlyWorkflow).not.toContain("ref: ");
  });

  test("publishes regenerated baselines a fork pull request can commit itself", () => {
    const upload = workflowStepValue(
      jobOf(marketingCaptureWorkflow, "capture"),
      "Upload regenerated baselines",
    );
    expect(upload["uses"]).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/u);
    expect(upload["with"]).toMatchObject({
      name: "marketing-screenshots",
      path: "apps/landing/public/media/products/*.png",
      "retention-days": 7,
    });
    // The capture run's own artifact: a run that cannot push (a fork's
    // change) still hands over the PNGs.
    expect(marketingCaptureWorkflow).not.toContain(
      "Push regenerated baselines",
    );
  });

  // A setup action that reports "not ready" through an output and exits 0
  // lets every test gated on that output skip while the job stays green.
  // Setup actions fail instead, so no step may gate on their outputs.
  const setupReadinessViolations = (
    files: readonly { path: string; source: string }[],
  ) =>
    files.flatMap(({ path: file, source }) => {
      const document: unknown = Bun.YAML.parse(source);
      if (!isRecord(document)) {
        return [`${file}: not a YAML mapping`];
      }
      const problems: string[] = [];
      if (
        /^\.github\/actions\/setup-[^/]+\/action\.ya?ml$/u.test(file) &&
        document["outputs"] !== undefined
      ) {
        problems.push(`${file}: setup action declares outputs`);
      }
      const jobs = isRecord(document["jobs"])
        ? Object.values(document["jobs"])
        : [document["runs"]];
      for (const job of jobs) {
        if (!isRecord(job) || !Array.isArray(job["steps"])) {
          continue;
        }
        const steps = job["steps"].filter(isRecord);
        const setupIds = new Set(
          steps
            .filter(
              (step) =>
                typeof step["uses"] === "string" &&
                step["uses"].startsWith("./.github/actions/setup-") &&
                typeof step["id"] === "string",
            )
            .map((step) => String(step["id"])),
        );
        for (const step of steps) {
          const condition = step["if"];
          if (typeof condition !== "string") {
            continue;
          }
          for (const id of setupIds) {
            if (condition.includes(`steps.${id}.outputs.`)) {
              problems.push(
                `${file}: ${String(step["name"])} is gated on setup output steps.${id}.outputs`,
              );
            }
          }
        }
      }
      return problems;
    });

  test("no step is gated on a setup action's readiness output", () => {
    const root = path.join(import.meta.dirname, "..");
    const files = [".github/workflows/*.yml", ".github/actions/*/action.yml"]
      .flatMap((pattern) => [
        ...new Bun.Glob(pattern).scanSync({ cwd: root, dot: true }),
      ])
      .map((file) => ({
        path: file,
        source: readFileSync(path.join(root, file), "utf-8"),
      }));
    expect(files.length).toBeGreaterThan(10);
    expect(setupReadinessViolations(files)).toEqual([]);
  });

  test("failure diagnostics run whenever the stack setup was attempted", () => {
    const root = path.join(import.meta.dirname, "..");
    const conditions = [
      ...new Bun.Glob(".github/workflows/*.yml").scanSync({
        cwd: root,
        dot: true,
      }),
    ].flatMap((file) =>
      [
        ...readFileSync(path.join(root, file), "utf-8").matchAll(
          /if: (failure\(\) && steps\.e2e-stack\.outcome [!=]= '\w+')/gu,
        ),
      ].map((match) => `${file}: ${match.at(1) ?? ""}`),
    );
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition).toEndWith("outcome != 'skipped'");
    }
  });

  test("the setup readiness guard rejects a status-gated test step", () => {
    const gatedWorkflow = [
      "jobs:",
      "  e2e:",
      "    steps:",
      "      - id: stack",
      "        uses: ./.github/actions/setup-e2e-stack",
      "      - name: Run browser tests",
      "        if: steps.stack.outputs.status == 'ready'",
      "        run: bun test:e2e",
    ].join("\n");
    const action = [
      "outputs:",
      "  status:",
      "    value: ready",
      "runs:",
      "  using: composite",
      "  steps: []",
    ].join("\n");
    expect(
      setupReadinessViolations([
        { path: ".github/workflows/ci.yml", source: gatedWorkflow },
        { path: ".github/actions/setup-example/action.yml", source: action },
      ]),
    ).toEqual([
      ".github/workflows/ci.yml: Run browser tests is gated on setup output steps.stack.outputs",
      ".github/actions/setup-example/action.yml: setup action declares outputs",
    ]);
  });

  test("the landing browser specs run in a gating collector", () => {
    const job = workflowJob("e2e-landing");
    const collector = workflowStepValue(job, "Check landing islands");
    // Default success() gating, no pipe that could hide the exit status.
    expect(collector["if"]).toBeUndefined();
    const run = requiredExpression(collector["run"]);
    expect(run).toEndWith("bun --filter @stll/landing test:e2e");
    expect(run).not.toContain("|");
    const landingPackage: unknown = JSON.parse(
      readFileSync(
        path.join(import.meta.dirname, "../apps/landing/package.json"),
        "utf-8",
      ),
    );
    const scripts = isRecord(landingPackage) ? landingPackage["scripts"] : {};
    const command = isRecord(scripts) ? scripts["test:e2e"] : undefined;
    // Playwright fails when no test matches unless told otherwise.
    expect(command).toBe(
      "playwright test --config e2e/playwright.config.ts --project landing",
    );
    const config = readFileSync(
      path.join(
        import.meta.dirname,
        "../apps/landing/e2e/playwright.config.ts",
      ),
      "utf-8",
    );
    expect(config).toContain('testDir: "."');
    for (const spec of [
      "landing-anonymize-demo.spec.ts",
      "landing-navigation.spec.ts",
    ]) {
      expect(
        existsSync(path.join(import.meta.dirname, "../apps/landing/e2e", spec)),
        spec,
      ).toBe(true);
    }
    // Parse the whole workflow: the job reuses anchors defined in other jobs.
    const result = contractRecord(parsedJobs(workflow)["ci-result"]);
    expect(result["needs"]).toContain("e2e-landing");
  });

  test("never passes the screenshot check without comparing a PNG", () => {
    // The shared stack setup fails the job when the stack is not ready, so
    // the capture needs no readiness gate of its own and no step may carry
    // one that turns a missing stack into a skip.
    expect(marketingCapture).toContain(
      "uses: ./.github/actions/setup-e2e-stack",
    );
    expect(marketingCapture).not.toContain("outputs.status");
    expect(marketingWorkflow).not.toContain("steps.e2e-stack");
  });

  test("keeps one capture body behind both screenshot directions", () => {
    // The shared body is a composite action so check and update cannot drift;
    // only the checkout differs, because update captures a named branch.
    for (const source of [marketingWorkflow, marketingCaptureWorkflow]) {
      expect(
        source.match(/uses: \.\/\.github\/actions\/marketing-capture/gu),
      ).toHaveLength(1);
    }
    expect(marketingPublishWorkflow).not.toContain("marketing-capture");
    expect(marketingWorkflow).not.toContain("test:e2e:marketing");
    expect(marketingCapture).toContain("test:e2e:marketing:update");
    // Cleanup stays inside the action so a failed capture still releases the
    // web server.
    expect(
      actionStep(marketingCapture, "Stop production web server"),
    ).toContain("if: always()");
    // An unrecognised mode must fail loudly: the check job always runs and
    // requires check mode, instead of being skipped green.
    expect(jobOf(marketingWorkflow, "check")).not.toContain("if: inputs.mode");
    expect(
      workflowStepRun(jobOf(marketingWorkflow, "check"), "Require check mode"),
    ).toContain('if [[ "$MODE" != check ]]');
    expect(actionStep(marketingCapture, "Validate mode")).toContain(
      "Unknown marketing screenshot mode",
    );
  });

  test("builds the production web artifact once per workflow run", () => {
    const scope = changedFileScope("apps/api/src/server.ts");
    expect(scope.e2e_core_required).toBe("true");
    expect(scope.web_build_required).toBe("true");

    const webBuild = workflowJob("web-build");
    expect(webBuild).toContain("needs: [ci-plan, pr-heavy-gate]");
    expect(webBuild).toContain("Upload production E2E web build");
    expect(webBuild).toContain("uses: ./.github/actions/build-e2e-web");

    const production = workflowJob("e2e-production-shard");
    const productionJob = ciContract.jobs["e2e-production-shard"];
    expect(productionJob?.needs).toEqual([
      "ci-plan",
      "web-build",
      "heavy-web-build",
    ]);
    const predicate = requiredExpression(productionJob?.if);
    for (const event of [
      "pull_request",
      "merge_group",
      "workflow_dispatch",
      "push",
      "schedule",
    ]) {
      for (const depth of ["fast", "full"]) {
        for (const planned of [false, true]) {
          for (const trusted of [false, true]) {
            for (const webResult of ["success", "skipped", "failure"]) {
              for (const heavyResult of ["success", "skipped", "failure"]) {
                for (const heavyOnly of [false, true]) {
                  for (const [cancelled, armed] of [
                    [false, false],
                    [false, true],
                    [true, false],
                    [true, true],
                  ] as const) {
                    const context = {
                      github: { event_name: event },
                      inputs: { heavy_only: heavyOnly },
                      // GitHub reads an unset repository variable as ''.
                      vars: { QUEUE_BROWSER_SUITES: "" },
                      needs: {
                        "ci-plan": {
                          outputs: {
                            coverage_profile: "normal-v1",
                            queue_depth: "full",
                            suite_depth: depth,
                            run_required: "true",
                            trusted: String(trusted),
                            e2e_production_required: String(planned),
                            // A pull request runs the suite once armed.
                            heavy_proof: String(
                              event !== "pull_request" || armed,
                            ),
                          },
                        },
                        "web-build": { result: webResult },
                        "heavy-web-build": { result: heavyResult },
                      },
                      always: () => true,
                      cancelled: () => cancelled,
                    };
                    const certified =
                      planned &&
                      (trusted || event === "workflow_dispatch") &&
                      (webResult === "success" || heavyResult === "success") &&
                      (event !== "merge_group" || !cancelled);
                    const label = `${event}/${depth}/${planned}/${trusted}/${webResult}/${heavyResult}/${heavyOnly}/${cancelled}/${armed}`;
                    expect(
                      Boolean(evaluateExpression(predicate, context)),
                      label,
                    ).toBe(certified);
                    // Queue depth and browser configuration cannot bypass
                    // a planned consumer's certification requirement.
                    context.needs["ci-plan"].outputs.queue_depth = "thin";
                    expect(
                      Boolean(evaluateExpression(predicate, context)),
                      `${label}/thin`,
                    ).toBe(certified);
                    context.vars.QUEUE_BROWSER_SUITES = "off";
                    expect(
                      Boolean(evaluateExpression(predicate, context)),
                      `${label}/thin/off`,
                    ).toBe(certified);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(production).not.toContain("Build web for route checks");
    expect(production).not.toContain("Wait for production web build");
    expect(production).toContain(
      "uses: ./.github/actions/setup-production-e2e",
    );
    expect(productionE2eSetup).toContain("Download production web build");
    expect(productionE2eSetup).toContain("Validate production web build");

    // The marketing capture serves that same build, never the Vite dev
    // server: PR CI hands the artifact over, and the callers without a
    // web-build job (nightly, update) build in place with the same flags.
    expect(marketingCapture).not.toContain("vite --port");
    for (const stepName of [
      "Wait for production web build",
      "Download production web build",
      "Validate production web build",
    ]) {
      expect(actionStep(marketingCapture, stepName)).toContain(
        "if: inputs.web-build-artifact != ''",
      );
    }
    const buildInPlace = actionStep(marketingCapture, "Build production web");
    expect(buildInPlace).toContain("if: inputs.web-build-artifact == ''");
    expect(marketingWorkflow).toContain(
      `web-build-artifact: ${githubExpression("inputs.web-build-artifact")}`,
    );
    expect(workflowJob("marketing-screenshots")).toContain(
      "web-build-artifact:",
    );
    expect(webBuild).toContain(
      "needs.ci-plan.outputs.marketing_screenshots_required == 'true'",
    );
  });

  test("scopes browser work before every dependency setup step", () => {
    const job = workflowJob("ci-browser");
    const scopes = [
      "Check desktop browser test scope",
      "Check UI browser test scope",
      "Check extension browser test scope",
    ];
    const required =
      "if: steps.desktop-browser-tests.outputs.required == 'true' || steps.ui-browser-tests.outputs.required == 'true' || steps.extension-browser-tests.outputs.required == 'true'";
    const setupSteps = [
      "Setup Bun",
      "Restore Bun install cache",
      "Turbo remote cache",
      "Install dependencies",
      "Prepare environment",
      "Install UI browser test runtime",
    ];
    for (const scope of scopes) {
      expect(job.indexOf(scope)).toBeGreaterThan(-1);
      expect(
        requiredExpression(workflowStepValue(job, scope)["run"] ?? ""),
      ).not.toContain("bun ");
      for (const name of setupSteps) {
        expect(job.indexOf(name)).toBeGreaterThan(-1);
        expect(job.indexOf(scope)).toBeLessThan(job.indexOf(name));
        expect(requiredExpression(workflowStepValue(job, name)["if"])).toBe(
          required.slice("if: ".length),
        );
      }
    }
  });

  test("browser setup verifies image executables without a host cache or installs", () => {
    const ciBrowser = workflowJob("ci-browser");
    const runtime = workflowStepValue(
      ciBrowser,
      "Install UI browser test runtime",
    );
    expect(runtime["with"]).toEqual({
      browsers: "chromium webkit",
      "dependency-mode": "preinstalled",
    });
    expect(marketingCapture).toContain("dependency-mode: container");
    expect(playwrightSetup).not.toContain("actions/cache@");
    expect(playwrightSetup).not.toContain("playwright install");
    expect(playwrightSetup).not.toContain("install-deps.sh");
    expect(playwrightSetup).toContain("--offline");
    expect(playwrightSetup).toContain("verify-browsers.sh");
    expect(nightlyWorkflow).toContain(
      "uses: ./.github/workflows/marketing-screenshots.yml",
    );
  });

  test("pins all browser commands to one image matching the locked Playwright version", () => {
    const lock = parseBunLockText(
      readFileSync(path.join(import.meta.dirname, "../bun.lock"), "utf-8"),
    );
    if (
      typeof lock !== "object" ||
      lock === null ||
      !("packages" in lock) ||
      typeof lock.packages !== "object" ||
      lock.packages === null ||
      !("@playwright/test" in lock.packages)
    ) {
      throw new Error("Lockfile must resolve Playwright");
    }
    const entry = lock.packages["@playwright/test"];
    if (!Array.isArray(entry) || typeof entry.at(0) !== "string") {
      throw new TypeError("Playwright resolution must contain a version");
    }
    const resolution = String(entry.at(0));
    expect(resolution).toStartWith("@playwright/test@");
    const version = resolution.slice("@playwright/test@".length);
    const image = readFileSync(
      path.join(
        import.meta.dirname,
        "../.github/actions/setup-playwright/image.txt",
      ),
      "utf-8",
    ).trim();
    expect(image).toMatch(
      /^mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[a-f0-9]{64}$/u,
    );
    expect(image).toStartWith(
      `mcr.microsoft.com/playwright:v${version}-noble@sha256:`,
    );
    expect(workflowJob("ci-browser")).toContain(
      `image: ${githubExpression("needs.ci-plan.outputs.playwright_image")}`,
    );
    expect(workflowJob("ci-plan")).toContain(
      "bun scripts/ci-service-images.ts --resolve",
    );
    const ciBrowser = workflowJob("ci-browser");
    const bunSetup = workflowStepValue(ciBrowser, "Setup Bun");
    const bunSetupRun = requiredExpression(bunSetup["run"]);
    expect(bunSetupRun).toContain("@oven/bun-linux-x64@$version");
    expect(bunSetupRun).toContain("--ignore-scripts");
    // The cached owner's pinned setup-bun reuses this standard install path.
    expect(bunSetupRun).toContain('bin="$HOME/.bun/bin"');
    const cachedSetup = workflowStepValue(
      ciBrowser,
      "Restore Bun install cache",
    );
    expect(cachedSetup["uses"]).toMatch(/^oven-sh\/setup-bun@[a-f0-9]{40}$/u);
    expect(contractRecord(cachedSetup["with"])["bun-version-file"]).toBe(
      "package.json",
    );
  });

  test("isolates cross-engine stack redaction from Chromium E2E", () => {
    const plan = workflowJob("ci-plan");
    const stackRedaction = workflowJob("stack-redaction-browsers");
    const result = workflowJob("ci-result");

    expect(plan).toContain("stack_redaction_browsers_required:");
    // The exported inputs are the complete owner set of the Firefox/WebKit guard:
    // production redaction, the harness, and everything that shapes how the
    // harness is built or installed. Set equality in both directions, so a
    // dropped owner fails here instead of silently skipping the job.
    expect(new Set(STACK_REDACTION_BROWSER_INPUTS)).toEqual(
      new Set([
        "apps/web/src/lib/analytics/posthog.ts",
        "apps/web/src/lib/analytics/stack-redaction.ts",
        "apps/web/src/lib/analytics/error-diagnostics.ts",
        "apps/web/e2e/stack-redaction/*",
        "apps/web/e2e/playwright.stack-redaction.config.ts",
        "apps/web/e2e/tsconfig.json",
        "apps/web/tsconfig.json",
        "apps/web/package.json",
        "scripts/retry.sh",
        ".github/actions/setup-playwright/*",
        "bunfig.toml",
        "package.json",
        "bun.lock",
        ".npmrc",
        ".github/workflows/ci.yml",
      ]),
    );
    for (const input of STACK_REDACTION_BROWSER_INPUTS) {
      expect(
        changedFileScope(input.replaceAll("*", "fixture"))
          .stack_redaction_browsers_required,
        input,
      ).toBe("true");
    }
    expect(stackRedaction).toContain(
      "needs.ci-plan.outputs.stack_redaction_browsers_required == 'true'",
    );
    expect(
      contractRecord(
        workflowStepValue(
          stackRedaction,
          "Verify Firefox and WebKit in the pinned image",
        )["with"],
      )["browsers"],
    ).toBe("firefox webkit");
    expect(stackRedaction).toContain("run-in-image.sh");
    expect(stackRedaction).toContain(
      "bun --filter @stll/web test:e2e:stack-redaction",
    );
    expect(stackRedaction).not.toContain("playwright install");
    expect(result).toContain("stack-redaction-browsers");
  });

  test("mints the release App token only inside its deployment environment", () => {
    // The key is an environment secret of `release-app`, whose deployment
    // policy is main and release tags. A job that reads it without declaring
    // the environment would be a job the policy never sees, so the census
    // below covers every workflow rather than the two edited here.
    expect(jobOf(marketingPublishWorkflow, "publish")).toContain(
      "environment: release-app",
    );
    expect(jobOf(marketingCaptureWorkflow, "capture")).not.toContain(
      "environment:",
    );
    expect(jobOf(marketingWorkflow, "check")).not.toContain("environment:");

    // A job that calls a reusable workflow cannot declare an environment:
    // GitHub allows only name, uses, with, secrets, strategy, needs, if,
    // concurrency, and permissions there. A local reusable declares it on its own job (walked
    // below); a remote one must be handed the environment name. Pinned so
    // each caller stays a listed decision.
    const forwardingCallers = new Set(["publish-npm.yml#release"]);
    const seenCallers = new Set<string>();

    const workflowsDir = path.join(import.meta.dirname, "../.github/workflows");
    for (const file of readdirSync(workflowsDir)) {
      if (!(file.endsWith(".yml") || file.endsWith(".yaml"))) {
        continue;
      }
      const source = readFileSync(path.join(workflowsDir, file), "utf-8");
      const jobsStart = source.indexOf("\njobs:\n");
      if (jobsStart === -1) {
        continue;
      }
      const jobs = source.slice(jobsStart + "\njobs:".length);
      for (const [, jobId] of jobs.matchAll(/\n {2}([A-Za-z0-9_-]+):\n/gu)) {
        if (jobId === undefined) {
          continue;
        }
        const body = jobOf(jobs, jobId);
        if (!/(?:STELLA_)?RELEASE_APP_PRIVATE_KEY/u.test(body)) {
          continue;
        }
        const location = `${file}#${jobId}`;
        if (/(?:^|\n) {4}uses: /u.test(body)) {
          seenCallers.add(location);
          if (!/(?:^|\n) {4}uses: \.\//u.test(body)) {
            expect(`${location}: ${body}`).toContain(
              "environment: release-app",
            );
          }
          continue;
        }
        expect(`${location}: ${body}`).toContain("environment: release-app");
      }
    }

    // Both directions: an exception that stops existing must be deleted, and
    // a new caller job must be a deliberate entry rather than a silent skip.
    expect([...seenCallers].toSorted()).toEqual(
      [...forwardingCallers].toSorted(),
    );
  });

  test("uploads blob reports from the configured Playwright output directory", () => {
    const uploads = workflow
      .split(/^ {6}- /mu)
      .filter((step) => /name: playwright-blob-/u.test(step));
    const defaultOutputUploads = uploads.filter(
      (step) => !/name: playwright-blob-route-smoke-/u.test(step),
    );
    const routeSmokeUploads = uploads.filter((step) =>
      /name: playwright-blob-route-smoke-/u.test(step),
    );

    expect(defaultOutputUploads.length).toBeGreaterThan(0);
    for (const upload of defaultOutputUploads) {
      expect(upload).toContain("uses: actions/upload-artifact@");
      expect(upload).toContain("path: apps/web/e2e/test-results/blob-report/");
    }
    expect(routeSmokeUploads).toHaveLength(1);
    for (const upload of routeSmokeUploads) {
      expect(upload).toContain("uses: actions/upload-artifact@");
      expect(upload).toContain(
        `path: apps/web/e2e/test-results/route-smoke-\${{ matrix.shard }}/blob-report/`,
      );
    }
    expect(workflow).toContain(
      `E2E_OUTPUT_DIR: test-results/route-smoke-\${{ matrix.shard }}`,
    );
    expect(workflow).not.toContain("path: apps/web/test-results/blob-report/");
  });
});

describe("PR production E2E scope", () => {
  test("follows the production config's actual spec directory", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../apps/web/e2e/playwright.config.ts"),
      "utf-8",
    );
    const testDir = /\btestDir:\s*["']([^"']+)["']/u.exec(source)?.[1];
    if (testDir === undefined) {
      throw new TypeError("Production config must declare testDir");
    }
    const spec = path.posix.join("apps/web/e2e", testDir, "future.spec.ts");
    expect(detects("pr-core", [spec])).toBe("true");
  });

  test("runs for specs, helpers, fixtures and Playwright configuration", () => {
    for (const file of [
      "apps/web/e2e/specs/new.spec.ts",
      "apps/web/e2e/specs/nested/new.spec.ts",
      "apps/web/e2e/helpers/test.ts",
      "apps/web/e2e/fixtures/simple.docx",
      "apps/web/e2e/playwright.config.ts",
    ]) {
      expect(detects("pr-core", [file]), file).toBe("true");
    }
  });

  test("leaves marketing-only inputs to the marketing workflow", () => {
    for (const file of [
      "apps/web/e2e/marketing/product-screenshots.spec.ts",
      "apps/web/e2e/playwright.marketing.config.ts",
    ]) {
      expect(detects("pr-core", [file]), file).toBe("false");
      expect(detects("marketing", [file]), file).toBe("true");
    }
  });

  test("does not widen PR shards for runtime or orchestration changes", () => {
    for (const file of [
      "apps/api/src/handlers/tasks/get.ts",
      "apps/web/src/routes/index.tsx",
      "packages/ui/src/button.tsx",
      "README.md",
      "apps/web/e2e/new.spec.ts",
      "apps/web/e2e/collab/room.spec.ts",
      "apps/web/e2e/playwright.collab.config.ts",
      "apps/web/e2e/fixtures/generate.ts",
      "bun.lock",
      ".github/workflows/ci.yml",
      "scripts/detect-e2e-changes.sh",
    ]) {
      expect(detects("pr-core", [file]), file).toBe("false");
    }
    expect(detects("pr-core", [])).toBe("false");
  });

  test("marketing exclusions cannot hide a core spec in the same diff", () => {
    const files = [
      "apps/web/e2e/marketing/product.spec.ts",
      "apps/web/e2e/specs/new.spec.ts",
    ];
    expect(detects("pr-core", files)).toBe("true");
    expect(detects("pr-core", files.toReversed())).toBe("true");
  });
});

test("every workflow browser command uses the pinned image and no reachable browser action installs system packages", () => {
  const root = path.resolve(import.meta.dirname, "..");
  // CI runs this file without the dependency install, so workflow shapes are
  // read by hand rather than through a schema library.
  type Step = { run?: string; uses?: string };
  const optionalText = (value: unknown, where: string): string | undefined => {
    expect(value === undefined || typeof value === "string", where).toBe(true);
    return typeof value === "string" ? value : undefined;
  };
  const stepsOf = (value: unknown, where: string): Step[] => {
    expect(Array.isArray(value), where).toBe(true);
    return (Array.isArray(value) ? value : []).map((step: unknown) => {
      expect(isRecord(step), where).toBe(true);
      const record = isRecord(step) ? step : {};
      const parsedStep: Step = {};
      const run = optionalText(record["run"], `${where}: run`);
      const uses = optionalText(record["uses"], `${where}: uses`);
      if (run !== undefined) {
        parsedStep.run = run;
      }
      if (uses !== undefined) {
        parsedStep.uses = uses;
      }
      return parsedStep;
    });
  };
  const actionSteps = new Map<string, Step[]>();
  const forbidden =
    /\b(?:apt-get|apt|dpkg)\b|playwright\s+install(?:-deps)?\b/u;
  const browserCommand = (run: string) =>
    run.split("\n").some((line) => {
      const command = line.trimStart();
      if (command.startsWith("echo ") || command.startsWith("#")) {
        return false;
      }
      return (
        command.includes("bun ") &&
        (command.includes("test:e2e") || command.includes("test:browser"))
      );
    });
  const reachableSteps = (steps: Step[]): Step[] =>
    steps.flatMap((step) => {
      if (!step.uses?.startsWith("./.github/actions/")) {
        return [step];
      }
      const cached = actionSteps.get(step.uses);
      if (cached !== undefined) {
        return [step, ...cached];
      }
      const action: unknown = Bun.YAML.parse(
        readFileSync(path.join(root, step.uses, "action.yml"), "utf-8"),
      );
      const runs =
        isRecord(action) && isRecord(action["runs"]) ? action["runs"] : {};
      const reached = reachableSteps(stepsOf(runs["steps"], step.uses));
      actionSteps.set(step.uses, reached);
      return [step, ...reached];
    });
  for (const file of readdirSync(path.join(root, ".github/workflows")).filter(
    (name) => name.endsWith(".yml"),
  )) {
    const parsedWorkflow: unknown = Bun.YAML.parse(
      readFileSync(path.join(root, ".github/workflows", file), "utf-8"),
    );
    const jobs =
      isRecord(parsedWorkflow) && isRecord(parsedWorkflow["jobs"])
        ? parsedWorkflow["jobs"]
        : {};
    expect(Object.keys(jobs).length, file).toBeGreaterThan(0);
    for (const [job, value] of Object.entries(jobs)) {
      expect(isRecord(value), `${file}:${job}`).toBe(true);
      const body = isRecord(value) ? value : {};
      const container = isRecord(body["container"]) ? body["container"] : {};
      const steps = reachableSteps(
        body["steps"] === undefined
          ? []
          : stepsOf(body["steps"], `${file}:${job}`),
      );
      const imageJob = file === "ci.yml" && job === "ci-browser";
      const browserSteps = steps.filter((step) =>
        browserCommand(step.run ?? ""),
      );
      if (!imageJob && browserSteps.length === 0) {
        continue;
      }
      if (imageJob) {
        expect(container["image"]).toBe(
          githubExpression("needs.ci-plan.outputs.playwright_image"),
        );
      }
      for (const step of steps) {
        expect(step.run ?? "", `${file}:${job}`).not.toMatch(forbidden);
      }
      if (!imageJob) {
        for (const step of browserSteps) {
          expect(step.run, `${file}:${job}`).toContain(
            ".github/actions/setup-playwright/run-in-image.sh",
          );
        }
      }
    }
  }
  for (const file of readdirSync(
    path.join(root, ".github/actions/setup-playwright"),
  ).filter((name) => name.endsWith(".sh"))) {
    expect(
      readFileSync(
        path.join(root, ".github/actions/setup-playwright", file),
        "utf-8",
      ),
      file,
    ).not.toMatch(forbidden);
  }
  const verify = readFileSync(
    path.join(root, ".github/actions/setup-playwright/verify-browsers.sh"),
    "utf-8",
  );
  expect(verify).toContain('executable.startsWith("/ms-playwright/")');
  expect(verify).toContain("existsSync(executable)");
  expect(verify).toContain("playwright[name].launch()");
});

test("browser image runner preserves argv, cwd, verdict and only browser inputs, including offline verification", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "playwright-image-runner-"),
  );
  const runner = path.resolve(
    import.meta.dirname,
    "../.github/actions/setup-playwright/run-in-image.sh",
  );
  // A self-contained workspace: the runner reads the pinned image and the
  // installed Playwright package from it, and CI runs this test without the
  // dependency install, so the real checkout may have no node_modules.
  const root = path.join(realpathSync(directory), "workspace");
  const imageFile = ".github/actions/setup-playwright/image.txt";
  mkdirSync(path.join(root, path.dirname(imageFile)), { recursive: true });
  writeFileSync(
    path.join(root, imageFile),
    readFileSync(path.resolve(import.meta.dirname, "..", imageFile), "utf-8"),
  );
  mkdirSync(path.join(root, "apps/web"), { recursive: true });
  const cache = path.join(directory, ".bun/install/cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    path.join(directory, "bun"),
    '#!/usr/bin/env bash\ncase "$*" in\n  "-p process.execPath") echo /native/bun ;;\n  "pm cache") printf "%s\\n" "$BUN_INSTALL_CACHE_DIR" ;;\n  *) exit 4 ;;\nesac\n',
    { mode: 0o755 },
  );
  const credentialFile = path.join(directory, "registry-credential");
  const dockerCalls = path.join(directory, "docker-calls");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts/retry.sh"),
    '#!/usr/bin/env bash\n"$@"\n',
  );
  writeFileSync(
    path.join(directory, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  image)
    [[ "$2" == inspect ]]
    echo inspect >> "$DOCKER_CALLS"
    [[ "$DOCKER_IMAGE_CACHED" == true ]]
    ;;
  pull)
    echo pull >> "$DOCKER_CALLS"
    exit "${shellExpansion("DOCKER_PULL_STATUS:-0")}"
    ;;
  logout)
    [[ "$2" == ghcr.io ]]
    echo logout >> "$DOCKER_CALLS"
    rm -f "$DOCKER_CREDENTIAL_FILE"
    ;;
  run)
    [[ ! -f "$DOCKER_CREDENTIAL_FILE" ]] || exit 99
    echo run >> "$DOCKER_CALLS"
    printf '%s\\n' "$@"
    exit 17
    ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  const runnerEnv = {
    PATH: `${directory}:${process.env["PATH"] ?? ""}`,
    GITHUB_WORKSPACE: root,
    BUN_INSTALL_CACHE_DIR: cache,
    CI: "true",
    E2E_EXECUTION_PROFILE: "network-baseline",
    E2E_EDGE_HEADER_VALUE: "fixture",
    GH_TOKEN: "must-not-forward",
    DOCKER_CALLS: dockerCalls,
    DOCKER_CREDENTIAL_FILE: credentialFile,
  };
  try {
    for (const { offline, cached, packageDirectory } of [
      { offline: false, cached: true },
      { offline: false, cached: false },
      { offline: true, cached: true },
      { offline: true, cached: false },
    ].flatMap((scenario) =>
      ["apps/web", "apps/landing"].map((selectedDirectory) => ({
        ...scenario,
        packageDirectory: selectedDirectory,
      })),
    )) {
      for (const workspace of ["apps/web", "apps/landing"]) {
        rmSync(path.join(root, workspace, "node_modules"), {
          recursive: true,
          force: true,
        });
      }
      mkdirSync(
        path.join(root, packageDirectory, "node_modules/@playwright/test"),
        { recursive: true },
      );
      writeFileSync(credentialFile, "fixture");
      writeFileSync(dockerCalls, "");
      const result = Bun.spawnSync(
        [
          "bash",
          runner,
          ...(offline ? ["--offline"] : []),
          "bun",
          "--filter",
          "@stll/web",
          "test:e2e",
          "--",
          "--grep=spaces and $literal",
        ],
        {
          cwd: path.join(root, "apps/web"),
          env: {
            ...runnerEnv,
            DOCKER_IMAGE_CACHED: String(cached),
            ...(packageDirectory === "apps/landing"
              ? { PLAYWRIGHT_PACKAGE_DIR: packageDirectory }
              : {}),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(17);
      expect(existsSync(credentialFile)).toBe(false);
      expect(readFileSync(dockerCalls, "utf-8").trim().split("\n")).toEqual(
        cached
          ? ["inspect", "logout", "run"]
          : ["inspect", "pull", "logout", "run"],
      );
      const args = new TextDecoder().decode(result.stdout).trim().split("\n");
      expect(args.at(args.indexOf("--network") + 1)).toBe(
        offline ? "none" : "host",
      );
      expect(args.at(args.indexOf("--workdir") + 1)).toBe(
        path.join(root, "apps/web"),
      );
      expect(args).toContain(`${root}:${root}`);
      expect(args).toContain(`${cache}:${cache}:ro`);
      expect(args).toContain(`BUN_INSTALL_CACHE_DIR=${cache}`);
      const hostHome = process.env["HOME"];
      if (hostHome !== undefined) {
        expect(args).not.toContain(`${hostHome}:${hostHome}`);
      }
      expect(args).toContain("/native/bun:/usr/local/bin/bun:ro");
      expect(args).toContain("/native/bun:/usr/local/bin/bunx:ro");
      expect(args).toContain("PLAYWRIGHT_BROWSERS_PATH=/ms-playwright");
      expect(args).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1");
      if (packageDirectory === "apps/landing") {
        expect(args).toContain("PLAYWRIGHT_PACKAGE_DIR");
      } else {
        expect(args).not.toContain("PLAYWRIGHT_PACKAGE_DIR");
      }
      expect(args).toContain("E2E_EXECUTION_PROFILE");
      expect(args).toContain("E2E_EDGE_HEADER_VALUE");
      expect(args).not.toContain("GH_TOKEN");
      expect(args).not.toContain("must-not-forward");
      expect(args).not.toContain("/var/run/docker.sock");
      expect(args.slice(-6)).toEqual([
        "bun",
        "--filter",
        "@stll/web",
        "test:e2e",
        "--",
        "--grep=spaces and $literal",
      ]);
    }
    for (const failure of ["validation", "pull"]) {
      writeFileSync(credentialFile, "fixture");
      writeFileSync(dockerCalls, "");
      if (failure === "validation") {
        writeFileSync(path.join(root, imageFile), "unpinned-browser:latest\n");
      } else {
        writeFileSync(
          path.join(root, imageFile),
          readFileSync(
            path.resolve(import.meta.dirname, "..", imageFile),
            "utf-8",
          ),
        );
      }
      const result = Bun.spawnSync(["bash", runner, "bun", "test:e2e"], {
        cwd: path.join(root, "apps/web"),
        env: {
          ...runnerEnv,
          DOCKER_IMAGE_CACHED: "false",
          DOCKER_PULL_STATUS: "23",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(failure === "validation" ? 1 : 23);
      expect(existsSync(credentialFile)).toBe(false);
      expect(readFileSync(dockerCalls, "utf-8").trim().split("\n")).toEqual(
        failure === "validation" ? ["logout"] : ["inspect", "pull", "logout"],
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
