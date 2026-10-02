import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { parseBunLockText } from "./bun-lock-text";

const script = path.join(import.meta.dirname, "detect-e2e-changes.sh");
const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");
// Built, not written literally: a `${...}` in a plain string reads as a
// broken template literal to the linter.
const shellExpansion = (value: string) => ["$", "{", value, "}"].join("");
const workflow = readFileSync(
  path.join(import.meta.dirname, "../.github/workflows/ci.yml"),
  "utf-8",
);
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
const e2eWebBuild = readFileSync(
  path.join(import.meta.dirname, "../.github/actions/build-e2e-web/action.yml"),
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
const marketingCapture = readFileSync(
  path.join(
    import.meta.dirname,
    "../.github/actions/marketing-capture/action.yml",
  ),
  "utf-8",
);

const jobOf = (source: string, jobId: string): string => {
  const marker = `\n  ${jobId}:\n`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Workflow is missing job ${jobId}`);
  }
  const bodyStart = start + marker.length;
  const nextJob = source.slice(bodyStart).search(/\n {2}[a-z][\w-]*:\n/u);
  return nextJob === -1
    ? source.slice(bodyStart)
    : source.slice(bodyStart, bodyStart + nextJob);
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

const workflowStep = (job: string, stepName: string): string =>
  stepOf(job, stepName, 6);

const actionStep = (action: string, stepName: string): string =>
  stepOf(action, stepName, 4);

const expectPullRequestAndMergeGroup = (source: string) => {
  expect(source).toContain("github.event_name == 'pull_request'");
  expect(source).toContain("github.event_name == 'merge_group'");
};

const workflowStepRun = (job: string, stepName: string): string => {
  const step = workflowStep(job, stepName);
  const runMarker = "\n        run: ";
  const runStart = step.indexOf(runMarker);
  if (runStart === -1) {
    throw new Error(`CI step ${stepName} is missing its run command`);
  }
  const run = step.slice(runStart + runMarker.length);
  const runEnd = run.search(/\n(?= {0,8}\S)/u);
  return (runEnd === -1 ? run : run.slice(0, runEnd)).trimEnd();
};

const detects = (scope: "core" | "landing" | "marketing", files: string[]) =>
  Bun.spawnSync(["bash", script, scope, ...files], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();

describe("detect-e2e-changes", () => {
  test("skips documentation-only changes", () => {
    expect(detects("core", ["README.md"])).toBe("false");
    expect(detects("landing", ["README.md"])).toBe("false");
  });

  test("runs product-code changes through core", () => {
    const files = ["apps/api/src/handlers/tasks/get.ts"];
    expect(detects("core", files)).toBe("true");
    expect(detects("landing", files)).toBe("false");
  });

  test("a marketing-test-only change waits for the nightly suite", () => {
    const files = ["apps/web/e2e/marketing/product-screenshots.spec.ts"];
    expect(detects("core", files)).toBe("false");
    expect(detects("landing", files)).toBe("false");
  });

  test("keeps a landing-only change out of app E2E", () => {
    for (const file of [
      "apps/landing/src/pages/index.astro",
      "apps/web/e2e/marketing/landing-navigation.spec.ts",
    ]) {
      expect(detects("core", [file])).toBe("false");
      expect(detects("landing", [file])).toBe("true");
    }
  });

  test("the shared marketing config exercises the landing project", () => {
    const files = ["apps/web/e2e/playwright.marketing.config.ts"];
    expect(detects("core", files)).toBe("false");
    expect(detects("landing", files)).toBe("true");
  });

  test("the web package manifest exercises its core and landing commands", () => {
    const files = ["apps/web/package.json"];
    expect(detects("core", files)).toBe("true");
    expect(detects("landing", files)).toBe("true");
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
    ]) {
      expect(detects("core", [file])).toBe("true");
      expect(detects("landing", [file])).toBe("true");
    }
  });

  test("plans trust and changed scopes in one security gate", () => {
    const plan = workflowJob("ci-plan");
    expect(workflow).not.toContain("\n  trust-check:\n");
    expect(workflow).not.toContain("\n  ci-changes:\n");
    expect(plan.indexOf("Check if PR is trusted")).toBeLessThan(
      plan.indexOf("Checkout"),
    );
    expect(plan.indexOf("Checkout")).toBeLessThan(
      plan.indexOf("Check changed file scope"),
    );
    expect(plan).toContain("persist-credentials: false");
    for (const stepName of [
      "Checkout",
      "Resolve browser image",
      "Setup Bun for dependency scope",
      "Check changed file scope",
    ]) {
      expect(workflowStep(plan, stepName), stepName).toContain(
        "steps.check.outputs.trusted == 'true'",
      );
    }
    expect(workflowStep(plan, "Resolve browser image")).toContain(
      "if: steps.check.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch'",
    );
    expect(workflow).not.toContain("needs.trust-check");
    expect(workflow).not.toContain("needs.ci-changes");
  });

  test("runs Redis collaboration checks for every owning boundary", () => {
    const plan = workflowJob("ci-plan");
    const serviceSuites = workflowJob("service-suites");
    const collabRedis = workflowStep(
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
      expect(plan).toContain(collaborationPath);
    }
    expect(plan).toContain(
      `service_suites_required: ${githubExpression("steps.changed-files.outputs.package_checks_required == 'true' || steps.changed-files.outputs.collab_redis_required == 'true'")}`,
    );
    expect(serviceSuites).toContain(
      "needs.ci-plan.outputs.service_suites_required == 'true'",
    );
    expect(collabRedis).toContain(
      `if: ${githubExpression("!cancelled() && needs.ci-plan.outputs.collab_redis_required == 'true'")}`,
    );
    expect(collabRedis).toContain(
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
        ">-",
        '          bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" bun --filter @stll/web test:e2e --',
        "          e2e/specs/vite-dependency-canary.spec.ts",
        "          --project chromium",
      ].join("\n"),
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

    const baseline = workflowJob("network-baseline");
    expect(production).toContain("shard: [1, 2]");
    expect(production).not.toContain("Check route network baseline");
    expect(result).toContain("        network-baseline,\n");
    expect(baseline).toContain("needs: [ci-plan, web-build]");
    expect(baseline).not.toContain("suite_depth == 'full'");
    expect(workflowStepRun(baseline, "Check route network baseline")).toBe(
      'bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" bun --filter @stll/web test:e2e -- route-smoke.spec.ts',
    );
    for (const stepName of [
      "Run Playwright shard",
      "Run route-smoke Playwright shard",
    ]) {
      expect(workflowStep(production, stepName), stepName).not.toContain(
        "matrix.shard != 'network-baseline'",
      );
    }
    const requireStack = workflowStep(baseline, "Require a ready stack");
    expect(requireStack).toContain("steps.e2e-stack.outputs.status != 'ready'");
    expect(requireStack).toContain("exit 1");
    expect(baseline.indexOf("- name: Require a ready stack")).toBeLessThan(
      baseline.indexOf("- name: Check route network baseline"),
    );
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

  test("skips browser execution only for an explicit Docker Hub pull rate limit", () => {
    expect(e2eStackSetup).toContain(
      `value: ${githubExpression("steps.stack.outputs.status")}`,
    );
    expect(e2eStackSetup).toContain(
      "grep -Eqi 'toomanyrequests:.*pull rate limit'",
    );
    expect(e2eStackSetup).toContain(
      'echo "status=rate-limited" >> "$GITHUB_OUTPUT"',
    );
    expect(e2eStackSetup).toContain('echo "status=ready" >> "$GITHUB_OUTPUT"');
    expect(
      e2eStackSetup.match(/if: steps\.stack\.outputs\.status == 'ready'/gu),
    ).toHaveLength(4);

    for (const stepName of [
      "Install Playwright browsers",
      "Download production web build",
      "Validate production web build",
      "Start production web server",
      "Wait for production web server",
    ]) {
      expect(actionStep(productionE2eSetup, stepName)).toContain(
        "steps.stack.outputs.status == 'ready'",
      );
    }
    expect(
      actionStep(productionE2eSetup, "Start docker stack and API server"),
    ).toContain("id: stack");
    const productionJob = workflowJob("e2e-production-shard");
    expect(
      workflowStep(productionJob, "Setup production browser stack"),
    ).toContain("id: e2e-stack");
    for (const stepName of [
      "Run Playwright shard",
      "Upload Playwright blob report",
      "Upload server logs",
    ]) {
      expect(workflowStep(productionJob, stepName)).toContain(
        "steps.e2e-stack.outputs.status == 'ready'",
      );
    }
    const canary = workflowJob("e2e-vite-canary");
    expect(workflowStep(canary, "Start docker stack and API server")).toContain(
      "id: e2e-stack",
    );
    for (const stepName of [
      "Start web dev server",
      "Wait for web dev server",
      "Install Playwright browsers",
      "Run Vite dependency canary",
      "Guard against mid-test Vite re-optimize",
      "Stop web dev server",
      "Upload Playwright blob report",
      "Upload server logs",
    ]) {
      expect(workflowStep(canary, stepName)).toContain(
        "steps.e2e-stack.outputs.status == 'ready'",
      );
    }
  });

  test("keeps full code quality for manual sweeps and scopes pull requests", () => {
    const plan = workflowJob("ci-plan");
    for (const leg of ["api", "web", "rest"]) {
      const codeQuality = workflowJob(`code-quality-${leg}`);
      expect(plan).not.toContain(".github/*|.provenance.yml|provenance/*)");
      expect(plan).toContain(".provenance.yml|provenance/*)");
      expect(codeQuality).toContain(
        `EVENT_NAME: ${githubExpression("github.event_name")}`,
      );
      expect(codeQuality).toContain(
        'if [[ "$EVENT_NAME" == "workflow_dispatch" ]]',
      );
      expect(codeQuality).toContain(`bun run code-check -- --leg ${leg}\n`);
      expect(codeQuality).not.toContain("bun run typecheck\n");
      expect(codeQuality).toContain(
        `bun run code-check:affected -- --leg ${leg} --base "origin/$BASE_REF"`,
      );
    }
  });

  test("runs the full native compiler only at the release boundary", () => {
    const plan = workflowJob("ci-plan");
    expect(plan).toContain(
      `release_typecheck_required: ${githubExpression("steps.changed-files.outputs.release_typecheck_required")}`,
    );
    expect(plan).toContain('if [[ "$file" == "VERSION" ]]');
    expect(plan).toContain("release_typecheck_required=true");

    const releaseTypecheck = workflowJob("release-typecheck");
    expect(releaseTypecheck).toContain(
      "needs.ci-plan.outputs.release_typecheck_required == 'true'",
    );
    expectPullRequestAndMergeGroup(releaseTypecheck);
    expect(releaseTypecheck).toContain(
      "run: bun run typecheck && bun run typecheck:repo",
    );
    expect(releaseTypecheck).toContain('TURBO_FORCE: "true"');

    const result = workflowJob("ci-result");
    expect(result).toContain("release-typecheck");
  });

  test("revalidates release invariants on the merge queue tree", () => {
    const ciChecks = workflowJob("ci-checks-rest");
    for (const stepName of [
      "Release changelog guard",
      "Release CLI coupling guard",
      "Release marketing freshness warning",
    ]) {
      expectPullRequestAndMergeGroup(workflowStep(ciChecks, stepName));
    }
  });

  test("checks the generated model snapshots only when their inputs change", () => {
    const plan = workflowJob("ci-plan");
    expect(plan).toContain(
      `model_catalog_drift_required: ${githubExpression("steps.changed-files.outputs.model_catalog_drift_required")}`,
    );
    expect(plan).toContain('echo "model_catalog_drift_required=true"');
    expect(plan).toContain('echo "model_catalog_drift_required=false"');

    const selector =
      /\n *([^\n)]+)\)\n *model_catalog_drift_required=true\n/u.exec(plan)?.[1];
    if (selector === undefined) {
      throw new Error("ci-plan has no model-catalog drift path selector");
    }
    expect(new Set(selector.split("|"))).toEqual(
      new Set([
        ".github/workflows/ci.yml",
        "packages/ai-catalog/package.json",
        "packages/ai-catalog/src/capabilities-overrides.ts",
        "packages/ai-catalog/src/capabilities.gen.ts",
        "packages/ai-catalog/src/document-input-overrides.ts",
        "packages/ai-catalog/src/index.ts",
        "packages/ai-catalog/src/model-rate-policy.ts",
        "packages/ai-catalog/src/model-rate.ts",
        "packages/ai-catalog/src/model-rates.gen.ts",
        "packages/scripts/src/model-catalog-capabilities-gen.ts",
        "packages/scripts/src/model-catalog-capabilities.ts",
        "packages/scripts/src/model-catalog-rates-gen.ts",
      ]),
    );

    const driftGuard = workflowStep(
      workflowJob("ci-checks-rest"),
      "Model catalog snapshot drift guard",
    );
    expect(driftGuard).toContain(
      "needs.ci-plan.outputs.model_catalog_drift_required == 'true'",
    );
    expect(driftGuard).toContain(
      "bun --filter @stll/ai-catalog gen:rates --check",
    );
    expect(driftGuard).toContain(
      "bun --filter @stll/ai-catalog gen:capabilities --check",
    );
    expect(driftGuard).not.toContain("package_checks_required");
  });

  test("fails the pull request that invalidates a shipped product screenshot", () => {
    const plan = workflowJob("ci-plan");
    expect(plan).toContain(
      `marketing_screenshots_required: ${githubExpression("steps.changed-files.outputs.marketing_screenshots_required")}`,
    );
    expect(plan).toContain(
      "marketing_screenshots_required=$(bash scripts/detect-e2e-changes.sh marketing",
    );
    expect(plan).toContain('echo "marketing_screenshots_required=true"');
    expect(plan).toContain('echo "marketing_screenshots_required=false"');

    const screenshots = workflowJob("marketing-screenshots");
    expect(screenshots).toContain("needs: [ci-plan, web-build]");
    expect(screenshots).toContain("always()");
    expect(screenshots).toContain(
      "needs.ci-plan.outputs.marketing_screenshots_required == 'true'",
    );
    expect(screenshots).toContain(
      "needs.ci-plan.outputs.web_build_required != 'true'\n          || needs.web-build.result == 'success'",
    );
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
    expect(marketingUpdateWorkflow).toContain(
      `ref: ${githubExpression("inputs.branch")}`,
    );
    expect(marketingUpdateWorkflow).not.toContain("--ref");

    const update = jobOf(marketingWorkflow, "update");
    const validate = workflowStep(update, "Validate inputs");
    expect(validate).toContain('if [[ "$WORKFLOW_REF" != "main" ]]');
    expect(validate).toContain('if [[ "$BRANCH" == "main" ]]');
    expect(validate).toContain('"$BRANCH" =~ ^[A-Za-z0-9._/-]+$');
    expect(validate).toContain('"$BRANCH" == *".."*');
    expect(validate).toContain('"$BRANCH" == -*');
    // Nothing is minted for a branch that does not exist here.
    expect(update.indexOf("- name: Verify the branch exists")).toBeLessThan(
      update.indexOf("- name: Mint App token"),
    );

    // The checked-out code and the push target are the named branch, never
    // the ref the workflow itself runs from. The check job takes no ref and
    // stays on its triggering one.
    expect(workflowStep(update, "Checkout")).toContain(
      `ref: ${githubExpression("inputs.ref")}`,
    );
    expect(
      workflowStep(jobOf(marketingWorkflow, "check"), "Checkout"),
    ).not.toContain("ref:");
    // The push is an API commit appended to the named branch: GitHub signs
    // it, so it cannot leave a person's pull request behind the
    // signed-commits rule.
    const push = workflowStep(update, "Push regenerated baselines");
    expect(push).toContain(
      "uses: stella/.github/.github/actions/signed-commit@",
    );
    expect(push).toContain("mode: append");
    expect(push).toContain(`branch: ${githubExpression("inputs.ref")}`);

    // Check-mode callers pass no ref and stay on their own triggering ref.
    expect(workflowJob("marketing-screenshots")).not.toContain("ref:");
    expect(nightlyWorkflow).not.toContain("ref: ");
  });

  test("publishes regenerated baselines a fork pull request can commit itself", () => {
    const upload = workflowStep(
      jobOf(marketingWorkflow, "update"),
      "Upload regenerated baselines",
    );
    expect(upload).toContain(
      "uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(upload).toContain(
      `name: marketing-screenshots-${githubExpression("github.run_id")}`,
    );
    expect(upload).toContain("path: apps/landing/public/media/products/*.png");
    expect(upload).toContain("retention-days: 7");
    // Published before the push, so a run that cannot push still hands over
    // the PNGs.
    expect(
      marketingWorkflow.indexOf("- name: Upload regenerated baselines"),
    ).toBeLessThan(
      marketingWorkflow.indexOf("- name: Push regenerated baselines"),
    );
  });

  test("never passes the screenshot check without comparing a PNG", () => {
    // setup-e2e-stack exits 0 with `status=rate-limited`, which the e2e suites
    // treat as a skip. Here it would report success on assets nothing looked
    // at, so the stack is mandatory.
    const requireStack = actionStep(marketingCapture, "Require the stack");
    expect(requireStack).toContain("steps.e2e-stack.outputs.status != 'ready'");
    expect(requireStack).toContain("::error::");
    expect(requireStack).toContain("exit 1");
    expect(marketingCapture.indexOf("- name: Require the stack")).toBeLessThan(
      marketingCapture.indexOf("- name: Start production web server"),
    );
    // No capture, upload, or push step may still carry the skip that step
    // makes fatal; only `always()` cleanup and `failure()` diagnostics test it.
    expect(marketingCapture).not.toContain(
      "if: steps.e2e-stack.outputs.status == 'ready'",
    );
    expect(marketingWorkflow).not.toContain("steps.e2e-stack");
  });

  test("keeps one capture body behind both screenshot directions", () => {
    // The shared body is a composite action so check and update cannot drift;
    // only the checkout differs, because update captures a named branch.
    expect(
      marketingWorkflow.match(
        /uses: \.\/\.github\/actions\/marketing-capture/gu,
      ),
    ).toHaveLength(2);
    expect(marketingWorkflow).not.toContain("test:e2e:marketing");
    expect(marketingCapture).toContain("test:e2e:marketing:update");
    // Cleanup stays inside the action so a failed capture still releases the
    // web server.
    expect(
      actionStep(marketingCapture, "Stop production web server"),
    ).toContain("if: always()");
    // An unrecognised mode must fail loudly: the check job runs on anything
    // that is not update, so it reaches this validation instead of leaving
    // both jobs skipped and green.
    expect(jobOf(marketingWorkflow, "check")).toContain(
      "if: inputs.mode != 'update'",
    );
    expect(actionStep(marketingCapture, "Validate mode")).toContain(
      "Unknown marketing screenshot mode",
    );
  });

  test("builds the production web artifact once per workflow run", () => {
    const plan = workflowJob("ci-plan");
    expect(plan).toContain(
      [
        'if [[ "$e2e_core_required" == "true" ]]; then',
        "            web_build_required=true",
        "          fi",
      ].join("\n"),
    );

    const webBuild = workflowJob("web-build");
    expect(webBuild).toContain("needs: ci-plan");
    expect(webBuild).toContain("Upload production E2E web build");
    expect(webBuild).toContain("uses: ./.github/actions/build-e2e-web");
    expect(e2eWebBuild).toContain("VITE_FEATURE_TIME_BILLING");

    const production = workflowJob("e2e-production-shard");
    const productionHeader = production.slice(
      0,
      production.indexOf("\n    runs-on:"),
    );
    expect(productionHeader).toContain(
      [
        "    needs: [ci-plan, web-build]",
        "    if: >-",
        "      always()",
        "      && (needs.ci-plan.outputs.trusted == 'true'",
        "          || github.event_name == 'workflow_dispatch')",
        "      && needs.ci-plan.outputs.e2e_core_required == 'true'",
        "      && needs.web-build.result == 'success'",
      ].join("\n"),
    );
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
    expect(buildInPlace).toContain("VITE_FEATURE_TIME_BILLING");
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
    const scope = "Check UI browser test scope";
    const setupSteps = [
      "Setup Bun",
      "Turbo remote cache",
      "Install dependencies",
      "Prepare environment",
      "Install UI browser test runtime",
    ];
    expect(job.indexOf(scope)).toBeGreaterThan(-1);
    for (const name of setupSteps) {
      expect(job.indexOf(scope)).toBeLessThan(job.indexOf(name));
      expect(workflowStep(job, name)).toContain(
        "if: steps.ui-browser-tests.outputs.required == 'true'",
      );
    }
    expect(workflowStep(job, scope)).not.toContain("bun ");
  });

  test("browser setup verifies image executables without a host cache or installs", () => {
    const ciBrowser = workflowJob("ci-browser");
    const runtime = workflowStep(ciBrowser, "Install UI browser test runtime");
    expect(runtime).toContain("dependency-mode: preinstalled");
    expect(runtime).toContain("browsers: chromium webkit");
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
      "cat .github/actions/setup-playwright/image.txt",
    );
    const bunSetup = workflowStep(workflowJob("ci-browser"), "Setup Bun");
    expect(bunSetup).toContain("@oven/bun-linux-x64@$version");
    expect(bunSetup).toContain("--ignore-scripts");
  });

  test("isolates cross-engine stack redaction from Chromium E2E", () => {
    const plan = workflowJob("ci-plan");
    const stackRedaction = workflowJob("stack-redaction-browsers");
    const result = workflowJob("ci-result");

    expect(plan).toContain("stack_redaction_browsers_required:");
    // The selector is the complete owner set of the Firefox/WebKit guard:
    // production redaction, the harness, and everything that shapes how the
    // harness is built or installed. Set equality in both directions, so a
    // dropped owner fails here instead of silently skipping the job.
    const selector =
      /\n *([^\n)]+)\)\n *stack_redaction_browsers_required=true\n/u.exec(
        plan,
      )?.[1];
    if (selector === undefined) {
      throw new Error("ci-plan has no stack-redaction path selector");
    }
    expect(new Set(selector.split("|"))).toEqual(
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
    expect(stackRedaction).toContain(
      "needs.ci-plan.outputs.stack_redaction_browsers_required == 'true'",
    );
    expect(
      workflowStep(
        stackRedaction,
        "Verify Firefox and WebKit in the pinned image",
      ),
    ).toContain("browsers: firefox webkit");
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
    expect(jobOf(marketingWorkflow, "update")).toContain(
      "environment: release-app",
    );
    expect(jobOf(marketingWorkflow, "check")).not.toContain("environment:");

    // A job that calls a reusable workflow cannot declare an environment:
    // GitHub allows only name, uses, with, secrets, needs, if, and
    // permissions there. A local reusable declares it on its own job (walked
    // below); a remote one must be handed the environment name. Pinned so
    // each caller stays a listed decision.
    const forwardingCallers = new Set([
      "marketing-screenshots-update.yml#update",
      "publish-npm.yml#release",
    ]);
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

test("every workflow browser command uses the pinned image and no reachable browser action installs system packages", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const stepSchema = v.object({
    run: v.optional(v.string()),
    uses: v.optional(v.string()),
  });
  const actionSteps = new Map<string, v.InferOutput<typeof stepSchema>[]>();
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
  const reachableSteps = (
    steps: v.InferOutput<typeof stepSchema>[],
  ): v.InferOutput<typeof stepSchema>[] =>
    steps.flatMap((step) => {
      if (!step.uses?.startsWith("./.github/actions/")) {
        return [step];
      }
      const cached = actionSteps.get(step.uses);
      if (cached !== undefined) {
        return [step, ...cached];
      }
      const action = v.parse(
        v.object({ runs: v.object({ steps: v.array(stepSchema) }) }),
        Bun.YAML.parse(
          readFileSync(path.join(root, step.uses, "action.yml"), "utf-8"),
        ),
      );
      const reached = reachableSteps(action.runs.steps);
      actionSteps.set(step.uses, reached);
      return [step, ...reached];
    });
  for (const file of readdirSync(path.join(root, ".github/workflows")).filter(
    (name) => name.endsWith(".yml"),
  )) {
    const jobs = v.parse(
      v.object({
        jobs: v.record(
          v.string(),
          v.object({
            steps: v.optional(v.array(stepSchema)),
            container: v.optional(v.object({ image: v.string() })),
          }),
        ),
      }),
      Bun.YAML.parse(
        readFileSync(path.join(root, ".github/workflows", file), "utf-8"),
      ),
    ).jobs;
    for (const [job, body] of Object.entries(jobs)) {
      const steps = reachableSteps(body.steps ?? []);
      const imageJob = file === "ci.yml" && job === "ci-browser";
      const browserSteps = steps.filter((step) =>
        browserCommand(step.run ?? ""),
      );
      if (!imageJob && browserSteps.length === 0) {
        continue;
      }
      if (imageJob) {
        expect(body.container?.image).toBe(
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
  const root = path.resolve(import.meta.dirname, "..");
  const cache = path.join(directory, ".bun/install/cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(
    path.join(directory, "bun"),
    '#!/usr/bin/env bash\ncase "$*" in\n  "-p process.execPath") echo /native/bun ;;\n  "pm cache") printf "%s\\n" "$BUN_INSTALL_CACHE_DIR" ;;\n  *) exit 4 ;;\nesac\n',
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(directory, "docker"),
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\nexit 17\n',
    { mode: 0o755 },
  );
  try {
    for (const offline of [false, true]) {
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
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
            GITHUB_WORKSPACE: root,
            BUN_INSTALL_CACHE_DIR: cache,
            CI: "true",
            E2E_EXECUTION_PROFILE: "network-baseline",
            E2E_EDGE_HEADER_VALUE: "fixture",
            GH_TOKEN: "must-not-forward",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(17);
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
