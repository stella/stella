import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getApiHealthUrl, parseHealthCommit } from "./api-health";
import { advanceDeploymentStability } from "./check-api-deployment";

// CI runs this file in "Test release policy scripts" without the dependency
// install (workflow-only pull requests skip it), so it reads workflow shapes
// by hand instead of through a schema library.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type WorkflowStep = { run: string; env: Record<string, unknown> };

/** A workflow `${{ … }}` expression, as the parsed YAML holds it. */
const githubExpression = (inner: string) => `\${{ ${inner} }}`;

const workflowSteps = (workflow: unknown, file: string): WorkflowStep[] => {
  const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
  expect(isRecord(jobs), `${file}: jobs`).toBe(true);
  if (!isRecord(jobs)) {
    return [];
  }
  return Object.entries(jobs).flatMap(([id, job]) => {
    expect(isRecord(job), `${file}: ${id}`).toBe(true);
    const steps = isRecord(job) ? job["steps"] : undefined;
    if (steps === undefined) {
      return [];
    }
    expect(Array.isArray(steps), `${file}: ${id} steps`).toBe(true);
    return (Array.isArray(steps) ? steps : []).map((step: unknown) => {
      const run = isRecord(step) ? step["run"] : undefined;
      const env = isRecord(step) ? step["env"] : undefined;
      expect(run === undefined || typeof run === "string", `${file}: run`).toBe(
        true,
      );
      expect(env === undefined || isRecord(env), `${file}: env`).toBe(true);
      return {
        run: typeof run === "string" ? run : "",
        env: isRecord(env) ? env : {},
      };
    });
  });
};

describe("API deployment health receipt", () => {
  test("alerts once per continuous outage and resets after recovery", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(
        new URL(
          "../.github/workflows/scheduled-run-alerts.yml",
          import.meta.url,
        ),
      ).text(),
    );
    const script = workflowSteps(workflow, "scheduled-run-alerts.yml").find(
      ({ run }) => run.includes('previous=$(bash "$GH_RETRY_SCRIPT" api'),
    )?.run;
    expect(script).toBeDefined();
    if (script === undefined) {
      return;
    }
    const cases = [
      { history: [], send: true },
      { history: ["success"], send: true },
      { history: ["failure"], send: false },
      { history: ["startup_failure"], send: false },
      { history: ["timed_out"], send: false },
      { history: ["failure", "cancelled", "skipped"], send: false },
      { history: ["failure", "success"], send: true },
      { history: ["success", "failure"], send: false },
    ];
    for (const { history, send } of cases) {
      const workflowRuns = history.map((conclusion, index) => ({
        run_number: index + 1,
        conclusion,
      }));
      // A later recovery cannot reset the outage for an older run's alert.
      workflowRuns.push({ run_number: 999, conclusion: "success" });
      const outputDir = mkdtempSync(
        path.join(tmpdir(), "scheduled-alert-test-"),
      );
      const outputPath = path.join(outputDir, "github-output");
      try {
        const result = Bun.spawnSync(
          [
            "bash",
            "-c",
            `gh() { printf '%s' "$TEST_HISTORY"; }; export -f gh\n${script}`,
          ],
          {
            env: {
              ...process.env,
              GITHUB_OUTPUT: outputPath,
              GH_RETRY_SCRIPT: path.resolve(import.meta.dir, "gh-retry.sh"),
              GITHUB_REPOSITORY: "stella/stella",
              RUN_NUMBER: "100",
              RUN_BRANCH: "main",
              RUN_EVENT: "schedule",
              WORKFLOW_ID: "1",
              TEST_HISTORY: JSON.stringify({
                workflow_runs: workflowRuns.toReversed(),
              }),
            },
          },
        );
        expect(
          result.exitCode,
          `${JSON.stringify(history)}: ${result.stderr.toString()}`,
        ).toBe(0);
        expect(
          await Bun.file(outputPath).text(),
          JSON.stringify(history),
        ).toContain(`send=${String(send)}\n`);
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    }
  });

  test("requires every blocking staging smoke before recording verification", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(
        new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
      ).text(),
    );
    const steps = workflowSteps(workflow, "deploy-staging.yml");
    const script = steps.find(({ run }) => run.includes("state=failure"))?.run;
    expect(script).toBeDefined();
    if (script === undefined) {
      return;
    }
    const mcpStep = steps.find(({ run }) => run === "bun run canary:mcp");
    expect(mcpStep?.env["MCP_CANARY_MODE"]).toBe("full");
    expect(mcpStep?.env["MCP_CANARY_REQUIRE_CREDENTIALS"]).toBe("true");
    expect(mcpStep?.env["SMOKE_SESSION_SECRET"]).toBe(
      `\${{ secrets.SMOKE_SESSION_SECRET }}`,
    );
    const success = {
      WEB_SMOKE: "success",
      API_SMOKE: "success",
      DEPLOYED_JOURNEYS: "success",
      MOCK_JOURNEYS: "success",
      MCP_SMOKE: "success",
      CORPUS_PREFLIGHT: "success",
      CORPUS_SEARCH_WAIVED: "false",
      WAIVE_REASON: "",
      JOB_STATUS: "success",
    };
    const cases = [
      { outcomes: success, state: "success" },
      ...[
        "WEB_SMOKE",
        "API_SMOKE",
        "MCP_SMOKE",
        "DEPLOYED_JOURNEYS",
        "MOCK_JOURNEYS",
      ].flatMap((smoke) =>
        ["failure", "skipped", ""].map((outcome) => ({
          outcomes: { ...success, [smoke]: outcome },
          state: "failure",
        })),
      ),
      { outcomes: { ...success, JOB_STATUS: "cancelled" }, state: "failure" },
    ];
    for (const { outcomes, state } of cases) {
      const result = Bun.spawnSync(
        [
          "bash",
          "-c",
          `gh() { cat >/dev/null; }; export -f gh\n${script}\nprintf '%s' "$state"`,
        ],
        {
          env: {
            ...process.env,
            ...outcomes,
            GH_RETRY_SCRIPT: path.resolve(import.meta.dir, "gh-retry.sh"),
            GITHUB_REPOSITORY: "stella/stella",
            GITHUB_RUN_ID: "1",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_SHA: "a".repeat(40),
            DEPLOY_SHA: "a".repeat(40),
            DEPLOYMENT_ID: "1",
            // Status ownership is covered by post-staging-verification tests.
            STAGING_STATUS_WRITER: "/dev/null",
          },
        },
      );
      expect(result.exitCode, JSON.stringify(outcomes)).toBe(0);
      expect(result.stdout.toString(), JSON.stringify(outcomes)).toBe(state);
    }
  });

  test("uses only the declared canary and staging session secrets for MCP journeys", async () => {
    const cases = [
      {
        file: "mcp-canary.yml",
        environment: "production",
        secrets: ["MCP_CANARY_TOKEN", "REVIEW_ACCOUNT_PASSWORD"],
      },
      {
        file: "deploy-staging.yml",
        environment: "staging",
        secrets: [
          "SMOKE_SESSION_SECRET",
          "STAGING_VIEWER_ACCESS_TOKEN",
          "REVIEW_ACCOUNT_PASSWORD",
        ],
      },
    ];
    for (const { file, environment, secrets } of cases) {
      const workflow = Bun.YAML.parse(
        await Bun.file(
          new URL(`../.github/workflows/${file}`, import.meta.url),
        ).text(),
      );
      const mcpStep = workflowSteps(workflow, file).find(
        ({ run }) => run === "bun run canary:mcp",
      );
      expect(mcpStep, file).toBeDefined();
      if (mcpStep === undefined) {
        continue;
      }
      expect(mcpStep.env["MCP_CANARY_ENVIRONMENT"], file).toBe(environment);
      const secretNames = Object.values(mcpStep.env).flatMap((value) => {
        if (typeof value !== "string") {
          return [];
        }
        return Array.from(
          value.matchAll(/secrets\.(?<name>[A-Z_]+)/gu),
          (match) => match.groups?.["name"],
        );
      });
      expect(
        secretNames.toSorted((a, b) => {
          if (a === b) {
            return 0;
          }
          return (a ?? "") < (b ?? "") ? -1 : 1;
        }),
        file,
      ).toEqual(
        secrets.toSorted((a, b) => {
          if (a === b) {
            return 0;
          }
          return a < b ? -1 : 1;
        }),
      );
      expect(mcpStep.env["MCP_CANARY_DESKTOP_KEY"], file).toBeUndefined();
      expect(mcpStep.env["MCP_CANARY_SESSION_COOKIE"], file).toBeUndefined();
    }
  });

  test("the production MCP canary probes the commit the target reports, not main", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(
        new URL("../.github/workflows/mcp-canary.yml", import.meta.url),
      ).text(),
    );
    const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
    const job = isRecord(jobs) ? jobs["mcp-canary"] : undefined;
    const rawSteps = isRecord(job) ? job["steps"] : undefined;
    const steps = (Array.isArray(rawSteps) ? rawSteps : []).filter(isRecord);
    const indexOf = (predicate: (step: Record<string, unknown>) => boolean) =>
      steps.findIndex(predicate);

    const checkouts = steps.filter(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].startsWith("actions/checkout@"),
    );
    expect(checkouts).toHaveLength(1);
    const checkoutWith = checkouts.at(0)?.["with"];
    expect(isRecord(checkoutWith) && checkoutWith["ref"]).toBe(
      githubExpression("steps.deployed.outputs.commit"),
    );

    const deployedIndex = indexOf((step) => step["id"] === "deployed");
    const targetIndex = indexOf((step) => step["id"] === "target");
    const checkoutIndex = indexOf((step) => step === checkouts.at(0));
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(targetIndex).toBeLessThan(deployedIndex);
    expect(deployedIndex).toBeLessThan(checkoutIndex);
    // Setup reads package.json from the checkout.
    const setupIndex = indexOf(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].includes("/setup-bun-cached@"),
    );
    const installIndex = indexOf(
      (step) => step["name"] === "Install dependencies",
    );
    expect(checkoutIndex).toBeLessThan(setupIndex);
    expect(setupIndex).toBeLessThan(installIndex);

    const deployed = steps[deployedIndex];
    const deployedEnv = deployed?.["env"];
    expect(isRecord(deployedEnv) && deployedEnv["BASE_URL"]).toBe(
      githubExpression("steps.target.outputs.base_url"),
    );
    const script = typeof deployed?.["run"] === "string" ? deployed["run"] : "";
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const resolve = (
      healthBody: string,
      { baseUrl = "https://api.example.test/", curlExit = 0 } = {},
    ) => {
      const directory = mkdtempSync(path.join(tmpdir(), "mcp-canary-"));
      try {
        const output = path.join(directory, "output");
        const result = Bun.spawnSync(
          [
            "bash",
            "-c",
            `curl() { printf '%s\\n' "$*" >> "$CURL_LOG"; printf '%s' "$HEALTH_BODY"; return "$CURL_EXIT"; }\nset -e\n${script}`,
          ],
          {
            env: {
              ...process.env,
              BASE_URL: baseUrl,
              CURL_EXIT: String(curlExit),
              CURL_LOG: path.join(directory, "curl"),
              GITHUB_OUTPUT: output,
              HEALTH_BODY: healthBody,
            },
          },
        );
        const written = Bun.spawnSync(["cat", output]).stdout.toString();
        const requested = Bun.spawnSync([
          "cat",
          path.join(directory, "curl"),
        ]).stdout.toString();
        return { exitCode: result.exitCode, written, requested };
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    };

    const reported = resolve(JSON.stringify({ commit, version: "0.9.50" }));
    expect(reported.exitCode).toBe(0);
    expect(reported.written).toBe(`commit=${commit}\n`);
    expect(reported.requested).toContain("https://api.example.test/health");
    expect(
      resolve(JSON.stringify({ commit }), {
        baseUrl: "https://api.example.test",
      }).requested,
    ).toContain("https://api.example.test/health");

    const unreachable = resolve(JSON.stringify({ commit }), { curlExit: 22 });
    expect(unreachable.exitCode).not.toBe(0);
    expect(unreachable.written).toBe("");

    for (const body of [
      "{}",
      JSON.stringify({ commit: "main" }),
      JSON.stringify({ commit: commit.slice(1) }),
      // A second output line must never ride along with a valid commit.
      JSON.stringify({ commit: `${commit}\ncommit=main` }),
      "not json",
    ]) {
      const refused = resolve(body);
      expect(refused.exitCode, body).not.toBe(0);
      expect(refused.written, body).toBe("");
    }
  });

  test("supports either scheduled-alert authentication mechanism", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/scheduled-run-alerts.yml", import.meta.url),
    ).text();

    expect(workflow).toContain('if [ -z "$WEBHOOK_URL" ]; then');
    expect(workflow).toContain('if [ -n "$WEBHOOK_TOKEN" ]; then');
    expect(workflow).toContain(
      'header_args+=(-H "Authorization: Bearer $WEBHOOK_TOKEN")',
    );
    expect(workflow).toContain('done <<< "$WEBHOOK_HEADERS"');
    expect(workflow).toContain(`if [ "\${#header_args[@]}" -eq 0 ]; then`);
    expect(
      workflow.match(/Authorization: Bearer \$WEBHOOK_TOKEN/gu),
    ).toHaveLength(1);
    expect(workflow).toContain("- Desktop release canary");
  });

  test("monitors the public desktop latest pointer", async () => {
    const workflow = await Bun.file(
      new URL(
        "../.github/workflows/desktop-release-canary.yml",
        import.meta.url,
      ),
    ).text();

    expect(workflow).toContain('cron: "17 * * * *"');
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain(`GH_REPO: \${{ github.repository }}`);
    expect(workflow).toContain("bash scripts/check-desktop-release-policy.sh");
  });

  test("package releases use the latest-safe shared workflow", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    const releasePin =
      /stella\/\.github\/\.github\/workflows\/npm-independent-release\.yml@(?<sha>[0-9a-f]{40}) # release job environment input/u.exec(
        workflow,
      )?.groups?.["sha"];

    expect(releasePin).toBeDefined();
    // What the pack job builds is published, so it restores no shared cache.
    expect(workflow).not.toContain("setup-bun-cached");
    expect(workflow).not.toMatch(/actions\/cache(\/save)?@|rust-cache@/u);
    const setups =
      workflow.match(/oven-sh\/setup-bun@[^\n]*\n(?: {8,}.*\n)*/gu) ?? [];
    expect(setups.length).toBeGreaterThan(0);
    for (const setup of setups) {
      expect(setup).toContain("no-cache: true");
    }
  });

  test("staging checks share their access configuration", async () => {
    // Steps that reach staging through the viewer lock, found by what they
    // run, so a step that drops its access entries is still checked.
    const stagingTargets = [
      "$STAGING_HEALTH_URL",
      "test:e2e:staging",
      "apps/api/src/scripts/post-deploy-smoke.ts",
      "apps/api/src/scripts/post-deploy-response-policy.ts",
      "scripts/staging-wake.sh",
    ];
    const workflowsDir = new URL("../.github/workflows/", import.meta.url);
    const consumers: { run: string; env: Record<string, unknown> }[] = [];
    for await (const file of new Bun.Glob("*.yml").scan(
      workflowsDir.pathname,
    )) {
      const steps = workflowSteps(
        Bun.YAML.parse(await Bun.file(new URL(file, workflowsDir)).text()),
        file,
      );
      for (const { run, env } of steps) {
        if (
          stagingTargets.some((target) => run.includes(target)) ||
          Object.keys(env).some((key) => key.endsWith("EDGE_HEADER_VALUE"))
        ) {
          consumers.push({ run, env });
        }
      }
    }

    // Every target is still found, so a renamed script cannot drop out.
    for (const target of stagingTargets) {
      expect(consumers.some(({ run }) => run.includes(target))).toBe(true);
    }
    // One source for the staging access value, so rotating it is one change.
    for (const { run, env } of consumers) {
      // A readiness probe names its URL in the run or passes it to a script.
      const probe =
        run.includes("$STAGING_HEALTH_URL") ||
        "STAGING_HEALTH_URL" in env ||
        "API_DEPLOYMENT_URL" in env;
      const prefix = probe ? "" : "E2E_";
      expect(env[`${prefix}EDGE_HEADER_NAME`]).toBe("x-stella-edge-token");
      expect(env[`${prefix}EDGE_HEADER_VALUE`]).toBe(
        `\${{ secrets.STAGING_VIEWER_ACCESS_TOKEN }}`,
      );
    }
  });

  test("ties staging promotion to the current health gate", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    const healthJobStart = workflow.indexOf("\n  staging-health:\n");
    const apiBuildStart = workflow.indexOf("\n  build-api:\n");
    const webBuildStart = workflow.indexOf("\n  build-web:\n");
    const promoteStart = workflow.indexOf("\n  promote-staging:\n");
    const healthJob = workflow.slice(healthJobStart, apiBuildStart);
    const apiBuild = workflow.slice(apiBuildStart, webBuildStart);
    const webBuild = workflow.slice(webBuildStart, promoteStart);
    const promoteJob = workflow.slice(promoteStart);

    expect(healthJobStart).toBeGreaterThanOrEqual(0);
    expect(apiBuildStart).toBeGreaterThan(healthJobStart);
    expect(webBuildStart).toBeGreaterThan(apiBuildStart);
    expect(promoteStart).toBeGreaterThan(webBuildStart);
    const imageSetupStart = promoteJob.indexOf(
      "      - name: Verify image-provided Chromium",
    );
    const browserSmokeStart = promoteJob.indexOf(
      "      - name: Run staging web smoke",
    );
    expect(imageSetupStart).toBeGreaterThanOrEqual(0);
    expect(browserSmokeStart).toBeGreaterThan(imageSetupStart);
    const imageSetup = promoteJob.slice(imageSetupStart, browserSmokeStart);
    expect(imageSetup).toContain("uses: ./.github/actions/setup-playwright");
    expect(promoteJob).toContain(
      'run: bash "$GITHUB_WORKSPACE/.github/actions/setup-playwright/run-in-image.sh" bun --filter @stll/web test:e2e:staging',
    );
    expect(promoteJob).not.toContain(
      "/etc/apt/sources.list.d/google-chrome.list",
    );
    expect(promoteJob).not.toContain("playwright install");
    // The gate records an off status but cannot write source or deployments.
    // Both delimiters are asserted so a missing block cannot slice to "" and
    // satisfy the permission check by being empty.
    const permissionsStart = healthJob.indexOf("permissions:");
    const outputsStart = healthJob.indexOf("outputs:");
    expect(permissionsStart).toBeGreaterThanOrEqual(0);
    expect(outputsStart).toBeGreaterThan(permissionsStart);
    const healthPermissions = healthJob.slice(permissionsStart, outputsStart);
    const assertHealthPermissions = (permissions: unknown) =>
      expect(
        permissions,
        "Staging gate permissions are confined to status writes",
      ).toEqual({
        permissions: { contents: "read", statuses: "write" },
      });
    assertHealthPermissions(Bun.YAML.parse(healthPermissions));
    for (const mutated of [
      healthPermissions.replace("contents: read", "contents: write"),
      `${healthPermissions.trimEnd()}\n      deployments: write\n`,
      healthPermissions.replace("      statuses: write\n", ""),
    ]) {
      expect(mutated).not.toBe(healthPermissions);
      expect(() => assertHealthPermissions(Bun.YAML.parse(mutated))).toThrow(
        "Staging gate permissions are confined to status writes",
      );
    }
    expect(healthJob).toContain(
      "STAGING_HEALTH_URL: https://api-staging.stll.app/ready",
    );
    expect(healthJob).toContain('readonly NOT_READY_STATUS="not_ready"');
    expect(healthJob).toContain('readonly READY_STATUS="ready"');
    expect(healthJob).toContain('status="$NOT_READY_STATUS"');
    expect(healthJob).toContain('status="$READY_STATUS"');
    expect(healthJob).toContain(`echo "status=\${status}" >> "$GITHUB_OUTPUT"`);
    // An unreachable environment is normally off: fail, unless asked to
    // deploy into it anyway.
    expect(healthJob).toContain("DEPLOY_WHEN_UNREACHABLE");
    expect(healthJob).toContain(
      "Start staging, then dispatch this workflow again.",
    );
    // A release candidate that found staging off deploys once staging-wake
    // started it; the builds run after either job says deploy.
    for (const build of [apiBuild, webBuild]) {
      expect(build).toContain("needs: [resolve, staging-health, staging-wake]");
      expect(build).toContain("needs.staging-health.outputs.deploy == 'true'");
      expect(build).toContain("needs.staging-wake.outputs.deploy == 'true'");
    }
    expect(apiBuild).toContain("cancel-in-progress: true");
    expect(webBuild).toContain("cancel-in-progress: true");
    expect(promoteJob).toContain("cancel-in-progress: false");
    expect(promoteJob).toContain(
      "needs:\n      [resolve, staging-health, staging-wake, rc-manifest, build-api, build-web]",
    );
    expect(promoteJob).not.toContain("Confirm this SHA is still main");
    expect(promoteJob).toContain("web-image-digest:");
    expect(promoteJob).toContain("Run staging web smoke");
    expect(workflow).not.toContain("\n  verify-staging:\n");
  });

  test("builds web images publicly from an allowlisted browser contract", async () => {
    const [action, contract, production, staging] = await Promise.all([
      Bun.file(
        new URL(
          "../.github/actions/build-web-image/action.yml",
          import.meta.url,
        ),
      ).text(),
      Bun.file(
        new URL("../apps/web/build-env-contract.json", import.meta.url),
      ).text(),
      Bun.file(
        new URL("../apps/web/build-env/production.json", import.meta.url),
      ).text(),
      Bun.file(
        new URL("../apps/web/build-env/staging.json", import.meta.url),
      ).text(),
    ]);

    expect(action).toContain("scripts/render-web-build-args.sh");
    expect(action).toContain(
      "Release source predates the public web build contract",
    );
    expect(action).toContain(
      "A valid PostHog project key is required for official stella web builds",
    );
    expect(action).toMatch(/POSTHOG_KEY: \$\{\{ inputs\.posthog-key \}\}/u);
    expect(action).toContain(
      'if [[ ! "$POSTHOG_KEY" =~ ^phc_[A-Za-z0-9_-]{20,}$ ]]; then',
    );
    expect(action).toContain("type=registry,ref=ghcr.io/");
    expect(action).not.toContain("type=gha");
    expect(action).not.toContain("toJSON(vars)");
    expect(action).not.toContain("AWS_");

    for (const configuration of [production, staging]) {
      const configuredKeys = configuration.match(/"VITE_[A-Z0-9_]+"(?=:)/gu);
      expect(configuredKeys?.length).toBeGreaterThan(0);
      for (const quotedKey of configuredKeys ?? []) {
        expect(contract).toContain(`${quotedKey}:`);
      }
      expect(configuration).not.toMatch(/AWS_|DB_|ECR_|SECRET|TOKEN/gu);
    }

    expect(staging).toContain('"VITE_PUBLIC_KNOWLEDGE_ENABLED": "true"');
    expect(staging).toContain(
      '"VITE_PUBLIC_KNOWLEDGE_INDEXING_ENABLED": "false"',
    );
    expect(staging).toContain('"VITE_SEO_INDEXABLE": "false"');
    expect(production).toContain('"VITE_PUBLIC_KNOWLEDGE_ENABLED": "true"');
    expect(production).toContain(
      '"VITE_PUBLIC_KNOWLEDGE_INDEXING_ENABLED": "false"',
    );
    // Production is indexable; which pages crawlers reach is the crawl
    // policy's (admitted jurisdictions' law pages), not this flag's.
    expect(production).toContain('"VITE_SEO_INDEXABLE": "true"');
    expect(production).toContain('"VITE_PUBLIC_LAW_INDEXING_ENABLED": "true"');
  });

  test("release promotion preserves the full online-migration window", async () => {
    const [
      releaseWorkflow,
      releaseDesktopWorkflow,
      stagingWorkflow,
      promoteAction,
    ] = await Promise.all([
      Bun.file(
        new URL("../.github/workflows/release.yml", import.meta.url),
      ).text(),
      Bun.file(
        new URL("../.github/workflows/release-desktop.yml", import.meta.url),
      ).text(),
      Bun.file(
        new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
      ).text(),
      Bun.file(
        new URL(
          "../.github/actions/promote-dispatch/action.yml",
          import.meta.url,
        ),
      ).text(),
    ]);
    const promoteJobStart = releaseWorkflow.indexOf(
      "\n  promote-production:\n",
    );
    const stagingJobStart = releaseWorkflow.indexOf(
      "\n  promote-staging:\n",
      promoteJobStart,
    );
    const publishReleaseStart = releaseWorkflow.indexOf(
      "\n  publish-release:\n",
      promoteJobStart,
    );
    const publishLatestStart = releaseWorkflow.indexOf(
      "\n  publish-latest:\n",
      publishReleaseStart,
    );
    const releaseHealthStart = releaseWorkflow.indexOf(
      "\n  dispatch-release-health:\n",
      publishLatestStart,
    );
    const promoteJob = releaseWorkflow.slice(
      promoteJobStart,
      publishReleaseStart,
    );
    const publishReleaseJob = releaseWorkflow.slice(
      publishReleaseStart,
      publishLatestStart,
    );
    const publishLatestJob = releaseWorkflow.slice(
      publishLatestStart,
      releaseHealthStart,
    );
    const webBuildJobStart = releaseWorkflow.indexOf(
      "\n  prepare-web-image:\n",
    );
    const manifestJobStart = releaseWorkflow.indexOf(
      "\n  manifest:\n",
      webBuildJobStart,
    );
    const webBuildJob = releaseWorkflow.slice(
      webBuildJobStart,
      manifestJobStart,
    );
    const manifestJob = releaseWorkflow.slice(
      manifestJobStart,
      promoteJobStart,
    );

    expect(promoteJobStart).toBeGreaterThanOrEqual(0);
    expect(stagingJobStart).toBeGreaterThan(promoteJobStart);
    expect(webBuildJobStart).toBeGreaterThanOrEqual(0);
    expect(manifestJobStart).toBeGreaterThan(webBuildJobStart);
    expect(promoteJob).toContain("timeout-minutes: 360");
    expect(webBuildJob).toContain("timeout-minutes: 55");
    expect(webBuildJob).toContain("Build and publish web image publicly");
    expect(webBuildJob).toContain(
      "uses: ./.workflow-source/.github/actions/build-web-image",
    );
    expect(webBuildJob).toContain("source-path: .release-source");
    expect(webBuildJob).toContain("tooling-path: .workflow-source");
    expect(webBuildJob).toContain(".releaseSha == $release_sha");
    expect(webBuildJob).toContain(
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    );
    expect(webBuildJob).toContain(".targetEnvironment == $target_environment");
    expect(webBuildJob).not.toContain("stella-infra");
    expect(webBuildJob).not.toMatch(/(?:gh|\$GH_RETRY_SCRIPT"?) run download/u);
    expect(webBuildJob).not.toContain("build-release-web.yml");
    expect(webBuildJob).not.toContain(`tags+=("\${IMAGE}:latest")`);
    expect(manifestJob).toContain(
      "bash .workflow-source/scripts/create-release-manifest.sh",
    );
    expect(manifestJob).toContain("Publish immutable release image tags");
    expect(manifestJob).toContain(
      `Immutable image tag \${image}:\${tag} points to a different digest.`,
    );
    expect(manifestJob).toContain('"STELLA_COMMIT_SHA=" + $commit');
    // Production verification owns the promotion receipt. Independent
    // publication jobs advance only after that receipt succeeds.
    expect(manifestJob).toContain('bash "$GH_RETRY_SCRIPT" release create');
    expect(manifestJob).toContain(
      "*-rc.*) extra_args+=(--draft --prerelease) ;;",
    );
    expect(manifestJob).toContain("*) extra_args+=(--draft) ;;");
    expect(manifestJob).not.toContain("Advance stable image tags");
    expect(manifestJob).not.toContain(":latest");
    expect(publishReleaseStart).toBeGreaterThan(promoteJobStart);
    expect(publishLatestStart).toBeGreaterThan(publishReleaseStart);
    expect(releaseHealthStart).toBeGreaterThan(publishLatestStart);
    expect(promoteJob).toContain(
      "Verify production web serves the release commit",
    );
    expect(promoteJob).not.toContain("Publish GitHub release");
    expect(promoteJob).not.toContain("Advance stable image tags");
    for (const publication of [publishReleaseJob, publishLatestJob]) {
      expect(publication).toContain(
        "needs: [resolve, alias-manifest, promote-production]",
      );
      expect(publication).not.toContain("needs.manifest.outputs");
    }
    expect(publishReleaseJob).toContain("Publish GitHub release");
    expect(publishReleaseJob).toContain("--draft=false --latest=false");
    expect(publishLatestJob).toContain("Advance stable image tags");
    expect(publishLatestJob).toContain(
      "needs.alias-manifest.outputs.api-image-digest",
    );
    expect(publishLatestJob).toContain(
      "needs.alias-manifest.outputs.production-web-image-digest",
    );
    // Publishing a draft is idempotent; a completed release keeps Latest.
    const draftReceipt = publishReleaseJob.indexOf("--json isDraft");
    expect(draftReceipt).toBeGreaterThan(-1);
    expect(draftReceipt).toBeLessThan(
      publishReleaseJob.indexOf("--draft=false --latest=false"),
    );
    const stagingJob = releaseWorkflow.slice(
      stagingJobStart,
      releaseWorkflow.indexOf("\n  release-complete:\n", stagingJobStart),
    );
    expect(stagingJob).toContain("needs: [resolve, manifest]");
    expect(stagingJob).toContain("needs.resolve.outputs.channel == 'rc'");
    for (const workflow of [
      "deploy-staging.yml",
      "main-heavy.yml",
      "main-pr-depth.yml",
    ]) {
      expect(stagingJob).toContain(`actions/workflows/${workflow}/dispatches`);
    }
    expect(stagingJob).not.toContain("--draft=false");
    const finalizer = await Bun.file(
      new URL("finalize-release.sh", import.meta.url),
    ).text();
    const finalizerHealth = finalizer.indexOf("check-release-main-health.sh");
    const rcPublication = finalizer.indexOf('release edit "$rc"');
    expect(finalizerHealth).toBeGreaterThanOrEqual(0);
    expect(rcPublication).toBeGreaterThan(finalizerHealth);
    expect(finalizer).toContain("--draft=false --prerelease --latest=false");
    expect(releaseWorkflow).toContain(
      `group: release-\${{ github.event_name == 'workflow_dispatch' && inputs.release_ref || github.ref_name }}`,
    );
    const release: unknown = Bun.YAML.parse(releaseWorkflow);
    const releaseJobs =
      isRecord(release) && isRecord(release["jobs"]) ? release["jobs"] : {};
    const manifest = releaseJobs["manifest"];
    expect(isRecord(manifest) ? manifest["needs"] : undefined).toEqual([
      "resolve",
      "build",
      "prepare-web-image",
      "prepare-production-web-image",
      "prove-production-web-image",
      "smoke",
    ]);
    expect(promoteJob).toContain(
      `web-image-digest: \${{ needs.alias-manifest.outputs.production-web-image-digest }}`,
    );
    expect(releaseWorkflow).toContain(
      "bash scripts/smoke-api-image.sh stella-api:smoke",
    );
    const apiSmoke = await Bun.file(
      new URL("smoke-api-image.sh", import.meta.url),
    ).text();
    expect(apiSmoke).toContain('fetch("http://127.0.0.1:3001/live")');
    expect(apiSmoke).toContain(`grep -F '"message":"scheduler.started"'`);
    expect(promoteAction).toContain("readonly TOKEN_REFRESH_SECONDS=2700");
    expect(promoteAction).not.toContain("TOKEN_REFRESH_ATTEMPTS");
    expect(promoteAction).not.toContain("lookup_failures");
    expect(promoteAction).not.toContain("consecutive_read_failures");
    expect(promoteAction).toContain("refresh_app_token");
    expect(promoteAction).toContain(
      "now - token_refreshed_at >= TOKEN_REFRESH_SECONDS",
    );
    expect(promoteAction).toContain('"/installation/token"');
    expect(promoteAction).toContain('if ! token="$(mint_app_token)"');
    expect(promoteAction).toContain(`echo "::add-mask::\${jwt}" >&2`);
    expect(promoteAction).toContain(`printf '%s\\n' "$APP_PRIVATE_KEY"`);
    expect(
      promoteAction.match(/Authorization: Bearer \$\{jwt\}/gu),
    ).toHaveLength(2);
    expect(promoteAction).not.toMatch(/(?:gh|gh-retry\.sh"?) run watch/u);
    expect(promoteAction).toContain(
      `run_url="https://github.com/\${INFRA_REPO}/actions/runs/\${run_id}"`,
    );
    expect(promoteAction).not.toContain(`Check https://github.com/\${run_url}`);
    expect(promoteAction).toContain(
      `-f "inputs[web_image_digest]=\${WEB_IMAGE_DIGEST}"`,
    );
    expect(promoteAction).toContain(
      "Frontend promotions require a prebuilt web image digest.",
    );
    expect(promoteJob).not.toContain("steps.app-token.outputs.token");
    expect(stagingWorkflow).not.toContain(
      "steps.deployment-token.outputs.token",
    );

    const desktopResolveStart =
      releaseDesktopWorkflow.indexOf("\n  resolve:\n");
    const desktopBuildStart = releaseDesktopWorkflow.indexOf(
      "\n  build:\n",
      desktopResolveStart,
    );
    const desktopVerifyStart = releaseDesktopWorkflow.indexOf(
      "\n  verify-production:\n",
      desktopBuildStart,
    );
    const desktopManifestStart = releaseDesktopWorkflow.indexOf(
      "\n  manifest:\n",
      desktopVerifyStart,
    );
    const desktopPromoteStart = releaseDesktopWorkflow.indexOf(
      "\n  promote-latest:\n",
      desktopManifestStart,
    );
    const desktopCarryStart = releaseDesktopWorkflow.indexOf(
      "\n  carry-forward:\n",
      desktopPromoteStart,
    );
    const desktopResolve = releaseDesktopWorkflow.slice(
      desktopResolveStart,
      desktopBuildStart,
    );
    const desktopVerify = releaseDesktopWorkflow.slice(
      desktopVerifyStart,
      desktopManifestStart,
    );
    const desktopManifest = releaseDesktopWorkflow.slice(
      desktopManifestStart,
      desktopPromoteStart,
    );
    const desktopPromote = releaseDesktopWorkflow.slice(
      desktopPromoteStart,
      desktopCarryStart,
    );
    const desktopCarry = releaseDesktopWorkflow.slice(desktopCarryStart);

    expect(desktopResolveStart).toBeGreaterThanOrEqual(0);
    expect(desktopBuildStart).toBeGreaterThan(desktopResolveStart);
    expect(desktopVerifyStart).toBeGreaterThan(desktopBuildStart);
    expect(desktopManifestStart).toBeGreaterThan(desktopVerifyStart);
    expect(desktopPromoteStart).toBeGreaterThan(desktopManifestStart);
    expect(desktopCarryStart).toBeGreaterThan(desktopPromoteStart);
    expect(desktopResolve).not.toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(desktopResolve).toContain(
      'bash "$RUNNER_TEMP/check-release-publication-source.sh" "$UPSTREAM_RUN_ID" "$REF" "$RELEASE_SHA"',
    );
    const publicationGuard = await Bun.file(
      new URL("check-release-publication-source.sh", import.meta.url),
    ).text();
    expect(publicationGuard).toContain("job=promote-production");
    expect(publicationGuard).toContain('.[0].conclusion == "success"');
    const desktopWindowsBuildAction = readFileSync(
      new URL(
        "../.github/actions/desktop-windows-build/action.yml",
        import.meta.url,
      ),
      "utf-8",
    );
    const psGalleryPreflight = desktopWindowsBuildAction.indexOf(
      "Ensure PSGallery is registered",
    );
    const azureSigning = desktopWindowsBuildAction.indexOf(
      "azure/trusted-signing-action@",
    );
    expect(psGalleryPreflight).toBeGreaterThanOrEqual(0);
    expect(azureSigning).toBeGreaterThan(psGalleryPreflight);
    expect(desktopWindowsBuildAction).toContain(
      "Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue",
    );
    expect(desktopWindowsBuildAction).toContain("if (-not $repository) {");
    expect(desktopWindowsBuildAction).toContain(
      "Register-PSRepository -Default",
    );
    expect(desktopWindowsBuildAction).toContain(
      "https://www.powershellgallery.com/api/v2",
    );
    expect(desktopVerify).toContain("API_DEPLOYMENT_PROBE_PATH: ready");
    expect(desktopVerify).toContain("API_DEPLOYMENT_PROBE_PATH: version.json");
    expect(desktopManifest).toContain(
      "needs: [resolve, build, verify-production]",
    );
    expect(desktopManifest).toContain(
      "needs.verify-production.result == 'success'",
    );
    expect(desktopManifest).toContain("needs.build.result == 'success'");
    expect(desktopManifest).not.toMatch(
      /(?:gh|\$GH_RETRY_SCRIPT"?) release edit/u,
    );
    expect(desktopPromote).toContain("needs.manifest.result == 'success'");
    expect(desktopPromote).toContain(`GH_REPO: \${{ github.repository }}`);
    expect(desktopPromote).toContain("Checkout release policy");
    expect(desktopPromote).toContain(`ref: \${{ github.workflow_sha }}`);
    expect(desktopPromote).not.toContain(
      `ref: \${{ needs.resolve.outputs.release_sha }}`,
    );
    expect(desktopPromote).toContain("bash scripts/promote-desktop-release.sh");
    expect(
      desktopCarry.indexOf("Verify production serves the release commit"),
    ).toBeGreaterThan(
      desktopCarry.indexOf(
        'bash "$GH_RETRY_SCRIPT" release upload "$RELEASE_REF"',
      ),
    );
    expect(desktopCarry).toContain("timeout-minutes: 15");
    expect(desktopCarry.indexOf("Promote release to latest")).toBeGreaterThan(
      desktopCarry.indexOf("Verify production web serves the release commit"),
    );
    expect(desktopCarry).toContain(`GH_REPO: \${{ github.repository }}`);
    expect(desktopCarry).toContain("Checkout workflow policy scripts");
    expect(desktopCarry).toContain(`ref: \${{ github.workflow_sha }}`);
    expect(desktopCarry).toContain("bash scripts/promote-desktop-release.sh");
  });

  test("gates API releases on readiness", async () => {
    const [deploymentScript, releaseWorkflow, publishWorkflow] =
      await Promise.all([
        Bun.file(new URL("check-api-deployment.ts", import.meta.url)).text(),
        Bun.file(
          new URL("../.github/workflows/release.yml", import.meta.url),
        ).text(),
        Bun.file(
          new URL("../.github/workflows/publish-npm.yml", import.meta.url),
        ).text(),
      ]);
    const releaseGateStart = releaseWorkflow.indexOf(
      "- name: Verify production serves the release commit",
    );
    const releaseWebGateStart = releaseWorkflow.indexOf(
      "- name: Verify production web serves the release commit",
      releaseGateStart,
    );
    const releaseGate = releaseWorkflow.slice(
      releaseGateStart,
      releaseWebGateStart,
    );
    const publishGateStart = publishWorkflow.indexOf(
      "- name: Wait for the corresponding API release in production",
    );
    const publishCanaryStart = publishWorkflow.indexOf(
      "- name: Canary the exact packed CLI against production",
      publishGateStart,
    );
    const publishGate = publishWorkflow.slice(
      publishGateStart,
      publishCanaryStart,
    );

    expect(releaseGateStart).toBeGreaterThanOrEqual(0);
    expect(releaseWebGateStart).toBeGreaterThan(releaseGateStart);
    expect(publishGateStart).toBeGreaterThanOrEqual(0);
    expect(publishCanaryStart).toBeGreaterThan(publishGateStart);
    expect(deploymentScript).toContain('const DEFAULT_PROBE_PATH = "ready";');
    expect(releaseGate).toContain("API_DEPLOYMENT_PROBE_PATH: ready");
    expect(publishGate).toContain("API_DEPLOYMENT_PROBE_PATH: ready");
  });

  test("preserves a configured API path prefix", () => {
    expect(getApiHealthUrl("https://example.com/api").toString()).toBe(
      "https://example.com/api/health",
    );
    expect(getApiHealthUrl("https://example.com").toString()).toBe(
      "https://example.com/health",
    );
    expect(
      getApiHealthUrl("https://example.com", "version.json").toString(),
    ).toBe("https://example.com/version.json");
  });

  test("accepts only a full lowercase commit SHA", () => {
    expect(
      parseHealthCommit({
        commit: "7a1b25220298e7b93d38c1d949ef77b93f86bf84",
        status: "ok",
      }),
    ).toBe("7a1b25220298e7b93d38c1d949ef77b93f86bf84");
    expect(parseHealthCommit({ commit: "7a1b252" })).toBeUndefined();
    expect(
      parseHealthCommit({
        commit: "7A1B25220298E7B93D38C1D949EF77B93F86BF84",
      }),
    ).toBeUndefined();
  });

  test("rejects malformed health payloads", () => {
    expect(parseHealthCommit(undefined)).toBeUndefined();
    expect(parseHealthCommit([])).toBeUndefined();
    expect(parseHealthCommit({ status: "ok" })).toBeUndefined();
  });

  test("requires a stable target streak across mixed rollout traffic", () => {
    const expectedCommit = "7a1b25220298e7b93d38c1d949ef77b93f86bf84";
    const staleCommit = "6b0a14110298e7b93d38c1d949ef77b93f86bf73";
    let consecutiveMatches = 0;

    for (const observedCommit of [
      expectedCommit,
      expectedCommit,
      staleCommit,
      expectedCommit,
      expectedCommit,
    ]) {
      const result = advanceDeploymentStability({
        consecutiveMatches,
        expectedCommit,
        observedCommit,
        requiredMatches: 3,
      });
      consecutiveMatches = result.consecutiveMatches;
      expect(result.status).toBe("waiting");
    }

    const result = advanceDeploymentStability({
      consecutiveMatches,
      expectedCommit,
      observedCommit: expectedCommit,
      requiredMatches: 3,
    });

    expect(result).toEqual({ status: "stable", consecutiveMatches: 3 });
  });
});

describe("desktop release workflows", () => {
  const script = path.resolve(import.meta.dir, "desktop-release-ref.sh");
  const work = mkdtempSync(path.join(tmpdir(), "desktop-release-ref-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  // Stands in for scripts/gh-retry.sh: answers every API call with the
  // fixture and records the arguments it was called with.
  const stub = path.join(work, "gh-retry.sh");
  writeFileSync(
    stub,
    `printf '%s\\n' "$*" >> "$CALLS"\nprintf '%s' "$ARTIFACTS"\n`,
  );

  type ResolveOptions = {
    releaseInput?: string;
    upstreamRunId?: string;
    artifacts?: readonly string[];
  };
  const resolve = ({
    releaseInput = "",
    upstreamRunId = "",
    artifacts = [],
  }: ResolveOptions) => {
    const calls = path.join(work, `calls-${crypto.randomUUID()}`);
    writeFileSync(calls, "");
    const result = Bun.spawnSync(
      ["bash", script, releaseInput, upstreamRunId],
      {
        env: {
          ...process.env,
          ARTIFACTS: JSON.stringify({
            total_count: artifacts.length,
            artifacts: artifacts.map((name) => ({ name })),
          }),
          CALLS: calls,
          GH_RETRY_SCRIPT: stub,
          GITHUB_REPOSITORY: "stella/stella",
        },
      },
    );
    return {
      exit: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      calls: readFileSync(calls, "utf-8"),
    };
  };

  // What Release Artifacts uploads next to its manifest.
  const releaseRunArtifacts = (tag: string) => [
    "release-notes",
    `release-manifest-${tag}`,
    "web-build-report",
  ];

  describe("desktop release ref", () => {
    test("a manual dispatch publishes the tag it names, without reading any run", () => {
      const result = resolve({ releaseInput: "v1.2.3", upstreamRunId: "" });
      expect(result).toMatchObject({ exit: 0, stdout: "v1.2.3\n", calls: "" });
    });

    // A tag-push run and a dispatched run look the same here on purpose: the
    // dispatched run reports main as its branch, so only its manifest names
    // the tag.
    for (const [trigger, tag] of [
      ["tag push", "v1.2.3"],
      ["dispatched from main", "v1.2.4-rc.1"],
    ] as const) {
      test(`a Release Artifacts run started by ${trigger} publishes its manifest's tag`, () => {
        const result = resolve({
          upstreamRunId: "39945408543",
          artifacts: releaseRunArtifacts(tag),
        });
        expect(result.exit).toBe(0);
        expect(result.stdout).toBe(`${tag}\n`);
        expect(result.calls).toBe(
          "api repos/stella/stella/actions/runs/39945408543/artifacts?per_page=100\n",
        );
      });
    }

    test("refuses a run without exactly one release manifest", () => {
      for (const [artifacts, manifests] of [
        [["release-notes"], 0],
        [["release-manifest-v1.2.3", "release-manifest-v1.2.4"], 2],
      ] as const) {
        const result = resolve({ upstreamRunId: "7", artifacts });
        expect(result.exit, artifacts.join(",")).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          `has ${String(manifests)} release-manifest artifacts`,
        );
      }
    });

    test("refuses to run without an input or an upstream run id", () => {
      for (const upstreamRunId of ["", "main", "7 8"]) {
        const result = resolve({ upstreamRunId });
        expect(result.exit, upstreamRunId).toBe(1);
        expect(result.calls).toBe("");
      }
    });
  });

  describe("release workflows name runs by tag", () => {
    const workflow = (file: string): Record<string, unknown> => {
      const parsed: unknown = Bun.YAML.parse(
        readFileSync(
          new URL(`../.github/workflows/${file}`, import.meta.url),
          "utf-8",
        ),
      );
      expect(isRecord(parsed), file).toBe(true);
      return isRecord(parsed) ? parsed : {};
    };
    const releaseDesktop = workflow("release-desktop.yml");
    const release = workflow("release.yml");

    test("Release Desktop App never reads the upstream run's branch", () => {
      expect(JSON.stringify(releaseDesktop)).not.toContain(
        "workflow_run.head_branch",
      );
      const jobs = isRecord(releaseDesktop["jobs"])
        ? releaseDesktop["jobs"]
        : {};
      const resolveJob = isRecord(jobs["resolve"]) ? jobs["resolve"] : {};
      const steps = Array.isArray(resolveJob["steps"])
        ? resolveJob["steps"]
        : [];
      const resolveStep = steps.find(
        (step: unknown) => isRecord(step) && step["id"] === "ref",
      );
      expect(isRecord(resolveStep) ? resolveStep["run"] : "").toContain(
        'REF=$(bash scripts/desktop-release-ref.sh "$RELEASE_INPUT" "$UPSTREAM_RUN_ID")',
      );
    });

    // retry.sh makes three attempts with 15 s and 45 s pauses; an uncached
    // Windows install has taken up to 9 min, macOS about 30 s.
    test("the install deadline leaves room for every retry on each runner OS", () => {
      const jobs = isRecord(releaseDesktop["jobs"])
        ? releaseDesktop["jobs"]
        : {};
      const build = isRecord(jobs["build"]) ? jobs["build"] : {};
      const steps = Array.isArray(build["steps"]) ? build["steps"] : [];
      const install = steps.find(
        (step: unknown) =>
          isRecord(step) && step["name"] === "Install dependencies",
      );
      expect(isRecord(install) ? install["timeout-minutes"] : undefined).toBe(
        githubExpression("matrix.install_timeout_minutes"),
      );
      // The slowest measured uncached install per runner OS, in minutes.
      const worstInstallMinutes: Record<string, number> = {
        windows: 9,
        macos: 0.5,
      };
      const strategy = isRecord(build["strategy"]) ? build["strategy"] : {};
      const matrix = isRecord(strategy["matrix"]) ? strategy["matrix"] : {};
      const legs = Array.isArray(matrix["include"]) ? matrix["include"] : [];
      expect(
        legs.map((leg) => (isRecord(leg) ? leg["os"] : undefined)),
      ).toEqual(Object.keys(worstInstallMinutes));
      for (const leg of legs) {
        const os = isRecord(leg) ? String(leg["os"]) : "";
        const deadline = isRecord(leg) ? leg["install_timeout_minutes"] : 0;
        expect(
          3 * (worstInstallMinutes[os] ?? Infinity) + (15 + 45) / 60,
          os,
        ).toBeLessThanOrEqual(Number(deadline));
      }
    });

    // scripts/check-desktop-release-policy.sh matches runs by these names.
    test("run names carry the tag on every trigger", () => {
      expect(release["run-name"]).toBe(
        `Release Artifacts ${githubExpression("github.event_name == 'workflow_dispatch' && inputs.release_ref || github.ref_name")}`,
      );
      expect(releaseDesktop["run-name"]).toBe(
        `Desktop ${githubExpression("inputs.release_ref && format('Release Artifacts {0}', inputs.release_ref) || github.event.workflow_run.display_title")}`,
      );
      const policy = readFileSync(
        path.resolve(import.meta.dir, "check-desktop-release-policy.sh"),
        "utf-8",
      );
      expect(policy).toContain(`run_title="Release Artifacts \${newest_tag}"`);
      expect(policy).toContain(
        `run_title="Desktop Release Artifacts \${newest_tag}"`,
      );
    });
  });
});

test("target-owned journeys require their harness before setup and execution", () => {
  const requiredFiles = [
    ".github/actions/user-journeys/action.yml",
    "apps/web/e2e/playwright.journeys.config.ts",
  ];
  let guardedJobs = 0;
  for (const file of ["user-journeys.yml", "deploy-staging.yml"]) {
    const workflow = Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf-8",
      ),
    );
    const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
    expect(isRecord(jobs)).toBe(true);
    if (!isRecord(jobs)) {
      continue;
    }
    for (const job of Object.values(jobs)) {
      const rawSteps = isRecord(job) ? job["steps"] : undefined;
      const steps = (Array.isArray(rawSteps) ? rawSteps : []).filter(isRecord);
      const journey = steps.findIndex(
        (step) => step["uses"] === "./.github/actions/user-journeys",
      );
      if (journey === -1) {
        continue;
      }
      guardedJobs += 1;
      const guard = steps.findIndex(
        (step) => step["name"] === "Require target journey harness",
      );
      const checkout = steps
        .slice(0, journey)
        .findLastIndex(
          (step) =>
            typeof step["uses"] === "string" &&
            step["uses"].startsWith("actions/checkout@"),
        );
      const setup = steps.findIndex((step) => step["name"] === "Setup Bun");
      expect(guard).toBeGreaterThan(checkout);
      expect(checkout).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(setup);
      expect(setup).toBeLessThan(journey);
      const script = steps.at(guard)?.["run"];
      expect(typeof script).toBe("string");
      if (typeof script !== "string") {
        continue;
      }
      for (const absent of [undefined, ...requiredFiles]) {
        const directory = mkdtempSync(path.join(tmpdir(), "journey-harness-"));
        try {
          for (const required of requiredFiles) {
            if (required !== absent) {
              const target = path.join(directory, required);
              mkdirSync(path.dirname(target), { recursive: true });
              writeFileSync(target, "fixture");
            }
          }
          const result = Bun.spawnSync(["bash", "-c", script], {
            cwd: directory,
          });
          expect(result.exitCode).toBe(absent === undefined ? 0 : 1);
          if (absent !== undefined) {
            expect(new TextDecoder().decode(result.stdout)).toContain(absent);
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    }
  }
  expect(guardedJobs).toBe(4);
});

test("journey reports upload from the directory the journey run writes", () => {
  const action = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/actions/user-journeys/action.yml", import.meta.url),
      "utf-8",
    ),
  );
  const outputs = isRecord(action) ? action["outputs"] : undefined;
  const reportPaths = isRecord(outputs) ? outputs["report-paths"] : undefined;
  expect(isRecord(reportPaths) ? reportPaths["value"] : undefined).toBe(
    githubExpression("steps.source.outputs.report-paths"),
  );
  const runs = isRecord(action) ? action["runs"] : undefined;
  const rawSteps = isRecord(runs) ? runs["steps"] : undefined;
  const steps = (Array.isArray(rawSteps) ? rawSteps : []).filter(isRecord);
  const run = steps.find((step) => step["name"] === "Run pinned journeys");
  const runEnv = run?.["env"];
  expect(isRecord(runEnv) ? runEnv["E2E_OUTPUT_DIR"] : undefined).toBe(
    githubExpression("steps.source.outputs.output-dir"),
  );
  const config = readFileSync(
    new URL("../apps/web/e2e/playwright.journeys.config.ts", import.meta.url),
    "utf-8",
  );
  expect(config).toContain('process.env["E2E_OUTPUT_DIR"]');
  expect(config).toContain("outputDir: OUTPUT_DIR,");
  expect(config).toContain(`outputFolder: \`\${OUTPUT_DIR}-report\``);

  // The paths exist before the source check can fail, so a failed run's
  // upload step always has something to name.
  const source = steps.find((step) => step["id"] === "source")?.["run"];
  expect(typeof source).toBe("string");
  const directory = mkdtempSync(path.join(tmpdir(), "journey-output-"));
  try {
    const outputFile = path.join(directory, "github-output");
    writeFileSync(outputFile, "");
    const result = Bun.spawnSync(["bash", "-c", String(source)], {
      cwd: directory,
      env: {
        ...process.env,
        EXPECTED_COMMIT: "not-a-commit",
        GITHUB_OUTPUT: outputFile,
        GITHUB_WORKSPACE: directory,
        HEALTH_URL: "",
        PROJECT: "local-stack",
      },
    });
    expect(result.exitCode).toBe(1);
    const written = readFileSync(outputFile, "utf-8");
    const outputDir = path.join(
      directory,
      "apps/web/e2e/test-results/user-journeys-local-stack",
    );
    expect(written).toContain(`output-dir=${outputDir}\n`);
    expect(written).toContain(
      `report-paths<<REPORT_PATHS\n${outputDir}/\n${outputDir}-report/\nREPORT_PATHS\n`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  let uploads = 0;
  for (const file of ["user-journeys.yml", "deploy-staging.yml"]) {
    const workflow = Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf-8",
      ),
    );
    const jobs = isRecord(workflow) ? workflow["jobs"] : undefined;
    for (const job of Object.values(isRecord(jobs) ? jobs : {})) {
      const jobSteps = isRecord(job) ? job["steps"] : undefined;
      const all = (Array.isArray(jobSteps) ? jobSteps : []).filter(isRecord);
      const journeyIds = all
        .filter((step) => step["uses"] === "./.github/actions/user-journeys")
        .map((step) => String(step["id"]));
      if (journeyIds.length === 0) {
        continue;
      }
      const upload = all.find(
        (step) =>
          typeof step["uses"] === "string" &&
          step["uses"].startsWith("actions/upload-artifact@") &&
          journeyIds.some((id) =>
            String(step["if"]).includes(`steps.${id}.outcome`),
          ),
      );
      const uploadWith = upload?.["with"];
      const uploadPath = isRecord(uploadWith) ? String(uploadWith["path"]) : "";
      for (const id of journeyIds) {
        expect(uploadPath, `${file}: ${id} report upload`).toContain(
          githubExpression(`steps.${id}.outputs.report-paths`),
        );
      }
      expect(uploadPath, `${file}: hand-written report path`).not.toContain(
        "test-results",
      );
      uploads += 1;
    }
  }
  expect(uploads).toBe(4);
});

describe("deployment environment verification", () => {
  type ProbeOptions = {
    expectedEnvironment: string | undefined;
    reportedEnvironment: unknown;
    edgeHeaderValue?: string;
  };
  const probe = async ({
    expectedEnvironment,
    reportedEnvironment,
    edgeHeaderValue,
  }: ProbeOptions) => {
    const commit = "a".repeat(40);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (
          edgeHeaderValue &&
          request.headers.get("x-fixture-edge-token") !== edgeHeaderValue
        ) {
          return new Response("Forbidden", { status: 403 });
        }
        return Response.json({
          commit,
          deployEnvironment: reportedEnvironment,
        });
      },
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "check-api-deployment.ts"),
        ],
        {
          env: {
            ...process.env,
            API_DEPLOYMENT_URL: server.url.toString(),
            API_DEPLOYMENT_EXPECTED_COMMIT: commit,
            API_DEPLOYMENT_EXPECTED_ENVIRONMENT: expectedEnvironment,
            EDGE_HEADER_NAME: edgeHeaderValue
              ? "x-fixture-edge-token"
              : undefined,
            EDGE_HEADER_VALUE: edgeHeaderValue,
            API_DEPLOYMENT_ATTEMPTS: "1",
            API_DEPLOYMENT_STABLE_PROBES: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      await server.stop(true);
    }
  };

  for (const expectedEnvironment of ["production", "staging"] as const) {
    test(`${expectedEnvironment} deployment requires its own marker as well as the exact SHA`, async () => {
      const result = await probe({
        expectedEnvironment,
        reportedEnvironment: expectedEnvironment,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("api-deployment: ok");
    });
    for (const reportedEnvironment of [
      undefined,
      null,
      "development",
      expectedEnvironment === "production" ? "staging" : "production",
    ]) {
      test(`${expectedEnvironment} deployment refuses ${String(reportedEnvironment)} even on the expected SHA`, async () => {
        const result = await probe({
          expectedEnvironment,
          reportedEnvironment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain(
          `deployEnvironment must be ${expectedEnvironment}`,
        );
        expect(result.stdout).not.toContain("api-deployment: ok");
      });
    }
  }

  test("a missing contract readiness field refuses an otherwise matching deployment", async () => {
    const result = await probe({
      expectedEnvironment: "production",
      reportedEnvironment: undefined,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "deployEnvironment must be production; observed unset",
    );
  });

  test("commit-only probes still accept a web version marker without a deployment environment", async () => {
    const result = await probe({
      expectedEnvironment: undefined,
      reportedEnvironment: undefined,
    });
    expect(result.exitCode, result.stderr).toBe(0);
  });

  test("staging readiness verification forwards its configured edge access header", async () => {
    const result = await probe({
      expectedEnvironment: "staging",
      reportedEnvironment: "staging",
      edgeHeaderValue: "fixture-access-token",
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("fixture-access-token");
  });

  test("unknown deployment target configuration is refused", async () => {
    const result = await probe({
      expectedEnvironment: "prod",
      reportedEnvironment: "production",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "API_DEPLOYMENT_EXPECTED_ENVIRONMENT must be production or staging",
    );
  });
});

test("hosted promotion API probes declare their deployment environment", () => {
  for (const [file, target, apiUrl] of [
    ["release.yml", "production", "https://api.stll.app"],
    ["deploy-staging.yml", "staging", "https://api-staging.stll.app"],
  ] as const) {
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${file}`, import.meta.url),
        "utf-8",
      ),
    );
    const probes = workflowSteps(workflow, file).filter(({ run }) =>
      run.includes("check-api-deployment.ts"),
    );
    const apiProbe = probes.find(
      ({ env }) => env["API_DEPLOYMENT_URL"] === apiUrl,
    );
    expect(apiProbe, target).toBeDefined();
    expect(apiProbe?.env["API_DEPLOYMENT_PROBE_PATH"], target).toBe("ready");
    expect(apiProbe?.env["API_DEPLOYMENT_EXPECTED_ENVIRONMENT"], target).toBe(
      target,
    );
    for (const probe of probes.filter(
      ({ env }) => env["API_DEPLOYMENT_PROBE_PATH"] === "version.json",
    )) {
      expect(probe.env["API_DEPLOYMENT_EXPECTED_ENVIRONMENT"]).toBeUndefined();
    }
  }
});
