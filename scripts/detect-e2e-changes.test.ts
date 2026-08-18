import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

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

const workflowJob = (jobId: string): string => {
  const marker = `\n  ${jobId}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error(`CI workflow is missing ${jobId}`);
  }
  const bodyStart = start + marker.length;
  const nextJob = workflow.slice(bodyStart).search(/\n {2}[a-z][\w-]*:\n/u);
  return nextJob === -1
    ? workflow.slice(bodyStart)
    : workflow.slice(bodyStart, bodyStart + nextJob);
};

const workflowStep = (job: string, stepName: string): string => {
  const marker = `\n      - name: ${stepName}\n`;
  const start = job.indexOf(marker);
  if (start === -1) {
    throw new Error(`CI job is missing step ${stepName}`);
  }
  const bodyStart = start + marker.length;
  const nextStep = job.slice(bodyStart).search(/\n {6}- name:/u);
  const step =
    nextStep === -1
      ? job.slice(bodyStart)
      : job.slice(bodyStart, bodyStart + nextStep);
  return step;
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
    for (const file of [
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
    expect(
      plan.match(/steps\.check\.outputs\.trusted == 'true'/gu),
    ).toHaveLength(2);
    expect(workflow).not.toContain("needs.trust-check");
    expect(workflow).not.toContain("needs.ci-changes");
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
        "          bun --filter @stll/web test:e2e --",
        "          e2e/specs/vite-dependency-canary.spec.ts",
        "          --project chromium",
      ].join("\n"),
    );
    expect(canaryRun).not.toMatch(/--grep(?:=|\s)+["']?@dev-canary/u);

    const landing = workflowJob("e2e-landing");
    expect(landing).not.toContain("Start docker stack");
    expect(landing).not.toContain("Start API server");

    const aggregate = workflowJob("e2e");
    for (const requiredJob of [
      "e2e-production-shard",
      "e2e-vite-canary",
      "e2e-landing",
    ]) {
      expect(aggregate).toContain(requiredJob);
    }
  });

  test("starts only infrastructure exercised by pull request E2E", () => {
    for (const jobId of ["e2e-production-shard", "e2e-vite-canary"]) {
      const job = workflowJob(jobId);
      expect(job).toContain("uses: ./.github/actions/setup-e2e-stack");
      expect(job).not.toContain("gotenberg");
    }
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
    expect(marketingWorkflow).toContain("extra-services: gotenberg");
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

    const guardedSteps = {
      "e2e-production-shard": [
        "Install Playwright browsers",
        "Wait for production web build",
        "Download production web build",
        "Validate production web build",
        "Start production web server",
        "Wait for production web server",
        "Run Playwright shard",
        "Upload Playwright blob report",
        "Upload server logs",
      ],
      "e2e-vite-canary": [
        "Start web dev server",
        "Wait for web dev server",
        "Install Playwright browsers",
        "Run Vite dependency canary",
        "Guard against mid-test Vite re-optimize",
        "Stop web dev server",
        "Upload Playwright blob report",
        "Upload server logs",
      ],
    } as const;

    for (const [jobId, stepNames] of Object.entries(guardedSteps)) {
      const job = workflowJob(jobId);
      expect(workflowStep(job, "Start docker stack and API server")).toContain(
        "id: e2e-stack",
      );
      for (const stepName of stepNames) {
        expect(workflowStep(job, stepName)).toContain(
          "steps.e2e-stack.outputs.status == 'ready'",
        );
      }
    }
  });

  test("keeps full code quality for manual sweeps and scopes pull requests", () => {
    const codeQuality = workflowJob("code-quality");
    expect(codeQuality).toContain(
      `EVENT_NAME: ${githubExpression("github.event_name")}`,
    );
    expect(codeQuality).toContain(
      'if [[ "$EVENT_NAME" == "workflow_dispatch" ]]',
    );
    expect(codeQuality).toContain("bun run code-check\n");
    expect(codeQuality).not.toContain("bun run typecheck\n");
    expect(codeQuality).toContain(
      'bun run code-check:affected -- --base "origin/$BASE_REF"',
    );
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
    expect(releaseTypecheck).toContain("github.event_name == 'pull_request'");
    expect(releaseTypecheck).toContain(
      "run: bun run typecheck && bun run typecheck:repo",
    );
    expect(releaseTypecheck).toContain('TURBO_FORCE: "true"');

    const result = workflowJob("ci-result");
    expect(result).toContain("release-typecheck");
    expect(result).toContain(
      `RELEASE_TYPECHECK_RESULT: ${githubExpression("needs.release-typecheck.result")}`,
    );
    expect(result).toContain('$RELEASE_TYPECHECK_RESULT" == "failure"');
    expect(result).toContain('$RELEASE_TYPECHECK_RESULT" == "cancelled"');
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
    expect(screenshots).toContain(
      "needs.ci-plan.outputs.marketing_screenshots_required == 'true'",
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
    expect(result).toContain(
      `MARKETING_SCREENSHOTS_RESULT: ${githubExpression("needs.marketing-screenshots.result")}`,
    );
    expect(result).toContain('$MARKETING_SCREENSHOTS_RESULT" == "failure"');
    expect(result).toContain('$MARKETING_SCREENSHOTS_RESULT" == "cancelled"');
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

    const validate = workflowStep(marketingWorkflow, "Validate inputs");
    expect(validate).toContain('if [[ "$WORKFLOW_REF" != "main" ]]');
    expect(validate).toContain('if [[ "$BRANCH" == "main" ]]');
    expect(validate).toContain('"$BRANCH" =~ ^[A-Za-z0-9._/-]+$');
    expect(validate).toContain('"$BRANCH" == *".."*');
    expect(validate).toContain('"$BRANCH" == -*');
    // Nothing is minted for a branch that does not exist here.
    expect(
      marketingWorkflow.indexOf("- name: Verify the branch exists"),
    ).toBeLessThan(marketingWorkflow.indexOf("- name: Mint App token"));

    // The checked-out code and the push target are the named branch, never
    // the ref the workflow itself runs from.
    expect(workflowStep(marketingWorkflow, "Checkout")).toContain(
      `ref: ${githubExpression("inputs.ref")}`,
    );
    expect(
      workflowStep(marketingWorkflow, "Push regenerated baselines"),
    ).toContain(`BRANCH: ${githubExpression("inputs.ref || github.ref_name")}`);

    // Check-mode callers pass no ref and stay on their own triggering ref.
    expect(workflowJob("marketing-screenshots")).not.toContain("ref:");
    expect(nightlyWorkflow).not.toContain("ref: ");
  });

  test("builds the production web artifact once per workflow run", () => {
    const webBuild = workflowJob("web-build");
    expect(webBuild).toContain("needs: ci-plan");
    expect(webBuild).toContain("Upload production E2E web build");
    expect(webBuild).toContain("VITE_FEATURE_TIME_BILLING");

    const production = workflowJob("e2e-production-shard");
    expect(production).not.toContain("Build web for route checks");
    expect(production).toContain("Wait for production web build");
    expect(production).toContain("Download production web build");
    expect(production).toContain("Validate production web build");
    expect(production.indexOf("Install Playwright browsers")).toBeLessThan(
      production.indexOf("Wait for production web build"),
    );
  });

  test("shares and launch-verifies a version-keyed browser cache", () => {
    expect(
      workflow.match(/uses: \.\/\.github\/actions\/setup-playwright/gu),
    ).toHaveLength(3);
    expect(marketingWorkflow).toContain(
      [
        "uses: ./.github/actions/setup-playwright",
        "        with:",
        "          dependency-mode: full",
      ].join("\n"),
    );
    // The nightly and PR checks share that one definition instead of
    // re-declaring the capture job.
    expect(nightlyWorkflow).toContain(
      "uses: ./.github/workflows/marketing-screenshots.yml",
    );
    expect(nightlyWorkflow).not.toContain("test:e2e:marketing");
    expect(playwrightSetup).toContain(
      'import metadata from "@playwright/test/package.json"',
    );
    expect(playwrightSetup).not.toContain("bunx playwright --version");
    expect(playwrightSetup).toContain("~/.cache/ms-playwright");
    expect(playwrightSetup).toContain(
      [
        "playwright",
        githubExpression("runner.os"),
        githubExpression("runner.arch"),
        githubExpression("steps.version.outputs.version"),
      ].join("-"),
    );
    expect(playwrightSetup).toContain(
      "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    );
    expect(playwrightSetup).toContain("id: browser-cache");
    expect(playwrightSetup).toContain("full|launch-verified");
    expect(playwrightSetup).toContain(
      "if: steps.browser-cache.outputs.cache-hit != 'true'",
    );
    expect(playwrightSetup).toContain(
      "if: steps.browser-cache.outputs.cache-hit == 'true' && inputs.dependency-mode == 'full'",
    );
    expect(playwrightSetup).toContain(
      `PLAYWRIGHT_CACHE_HIT: ${githubExpression("steps.browser-cache.outputs.cache-hit")}`,
    );
    expect(playwrightSetup).toContain("if verify_chromium; then");
    expect(playwrightSetup).toContain("bunx playwright install-deps chromium");
  });

  test("uploads blob reports from the configured Playwright output directory", () => {
    expect(
      workflow.match(/path: apps\/web\/e2e\/test-results\/blob-report\//gu),
    ).toHaveLength(2);
    expect(workflow).not.toContain("path: apps/web/test-results/blob-report/");
  });
});
