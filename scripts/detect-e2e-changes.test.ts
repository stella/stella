import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const script = path.join(import.meta.dirname, "detect-e2e-changes.sh");
const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");
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

const workflowStepRun = (job: string, stepName: string): string => {
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
  const runMarker = "\n        run: ";
  const runStart = step.indexOf(runMarker);
  if (runStart === -1) {
    throw new Error(`CI step ${stepName} is missing its run command`);
  }
  const run = step.slice(runStart + runMarker.length);
  const runEnd = run.search(/\n(?= {0,8}\S)/u);
  return (runEnd === -1 ? run : run.slice(0, runEnd)).trimEnd();
};

const detects = (scope: "core" | "landing", files: string[]) =>
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
      "if docker compose --profile dev up -d --wait postgres minio valkey \\",
    ]);
    expect(e2eStackSetup).not.toContain("gotenberg");
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
    expect(codeQuality).toContain(
      'bun run code-check:affected -- --base "origin/$BASE_REF"',
    );
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
    expect(nightlyWorkflow).toContain(
      [
        "uses: ./.github/actions/setup-playwright",
        "        with:",
        "          dependency-mode: full",
      ].join("\n"),
    );
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
