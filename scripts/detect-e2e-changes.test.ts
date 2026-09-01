import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

  test("runs Redis collaboration checks for every owning boundary", () => {
    const plan = workflowJob("ci-plan");
    const collabRedis = workflowJob("collab-redis");

    for (const collaborationPath of [
      "apps/collab/*",
      "apps/api/src/handlers/folio-collab/*",
      "apps/api/src/handlers/entities/join-folio-collab-room.ts",
      "apps/api/src/lib/folio-collab-*",
      "packages/api-contract/src/folio-collab*",
    ]) {
      expect(plan).toContain(collaborationPath);
    }
    expect(collabRedis).toContain(
      "needs.ci-plan.outputs.collab_redis_required",
    );
    expect(collabRedis).toContain(
      "bun --filter @stll/collab test src/server.test.ts",
    );
    expect(workflowJob("ci-result")).toContain("collab-redis");
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

    const guardedSteps = {
      "e2e-production-shard": [
        "Install Playwright browsers",
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
    const plan = workflowJob("ci-plan");
    const codeQuality = workflowJob("code-quality");
    expect(plan).not.toContain(".github/*|.provenance.yml|provenance/*)");
    expect(plan).toContain(".provenance.yml|provenance/*)");
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
    expect(workflowStep(update, "Push regenerated baselines")).toContain(
      `BRANCH: ${githubExpression("inputs.ref || github.ref_name")}`,
    );

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
    const webBuild = workflowJob("web-build");
    expect(webBuild).toContain("needs: ci-plan");
    expect(webBuild).toContain("Upload production E2E web build");
    expect(webBuild).toContain("VITE_FEATURE_TIME_BILLING");

    const production = workflowJob("e2e-production-shard");
    expect(production).not.toContain("Build web for route checks");
    expect(production).toContain("needs: [ci-plan, web-build]");
    expect(production).toContain("always()");
    expect(production).toContain("needs.web-build.result == 'success'");
    expect(production).not.toContain("Wait for production web build");
    expect(production).toContain("Download production web build");
    expect(production).toContain("Validate production web build");

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

  test("shares and launch-verifies a version-keyed browser cache", () => {
    expect(
      workflow.match(/uses: \.\/\.github\/actions\/setup-playwright/gu),
    ).toHaveLength(4);
    const ciChecks = workflowJob("ci-checks");
    expect(ciChecks).toContain("Check UI browser test scope");
    expect(ciChecks).toContain("apps/web/src/routes/dev");
    expect(ciChecks).toContain("Test UI browser interactions");
    expect(ciChecks).toContain("Test UI playground visuals");
    expect(ciChecks).toContain("bun --filter @stll/web test:e2e:ui-playground");
    expect(workflowStep(ciChecks, "Install UI browser test runtime")).toContain(
      "dependency-mode: full",
    );
    expect(marketingCapture).toContain(
      [
        "uses: ./.github/actions/setup-playwright",
        "      with:",
        "        dependency-mode: full",
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

  test("isolates cross-engine stack redaction from Chromium E2E", () => {
    const plan = workflowJob("ci-plan");
    const stackRedaction = workflowJob("stack-redaction-browsers");
    const result = workflowJob("ci-result");

    expect(plan).toContain("stack_redaction_browsers_required:");
    for (const owningPath of [
      "apps/web/src/lib/analytics/stack-redaction.ts",
      "apps/web/e2e/stack-redaction/*",
      "apps/web/e2e/playwright.stack-redaction.config.ts",
      "apps/web/e2e/tsconfig.json",
      "apps/web/tsconfig.json",
      "scripts/bun-ci-retry.sh",
      "bunfig.toml",
      ".npmrc",
    ]) {
      expect(plan).toContain(owningPath);
    }
    expect(stackRedaction).toContain(
      "needs.ci-plan.outputs.stack_redaction_browsers_required == 'true'",
    );
    expect(stackRedaction).toContain(
      "bunx playwright install --with-deps firefox webkit",
    );
    expect(stackRedaction).toContain(
      "bun --filter @stll/web test:e2e:stack-redaction",
    );
    expect(stackRedaction).not.toContain("setup-playwright");
    expect(result).toContain("stack-redaction-browsers");
    expect(result).toContain("STACK_REDACTION_BROWSERS_RESULT");
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
    expect([...seenCallers].sort()).toEqual([...forwardingCallers].sort());
  });

  test("uploads blob reports from the configured Playwright output directory", () => {
    expect(
      workflow.match(/path: apps\/web\/e2e\/test-results\/blob-report\//gu),
    ).toHaveLength(2);
    expect(workflow).not.toContain("path: apps/web/test-results/blob-report/");
  });
});
