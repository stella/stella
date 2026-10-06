import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
      ({ run }) => run.includes("previous=$(gh api"),
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
          ["bash", "-c", `gh() { printf '%s' "$TEST_HISTORY"; }\n${script}`],
          {
            env: {
              ...process.env,
              GITHUB_OUTPUT: outputPath,
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
      MCP_SMOKE: "success",
      JOB_STATUS: "success",
    };
    const cases = [
      { outcomes: success, state: "success" },
      ...["WEB_SMOKE", "API_SMOKE", "MCP_SMOKE"].flatMap((smoke) =>
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
          `gh() { cat >/dev/null; }\n${script}\nprintf '%s' "$state"`,
        ],
        {
          env: {
            ...process.env,
            ...outcomes,
            GITHUB_REPOSITORY: "stella/stella",
            GITHUB_RUN_ID: "1",
            GITHUB_SERVER_URL: "https://github.com",
            GITHUB_SHA: "a".repeat(40),
            DEPLOY_SHA: "a".repeat(40),
            DEPLOYMENT_ID: "1",
          },
        },
      );
      expect(result.exitCode, JSON.stringify(outcomes)).toBe(0);
      expect(result.stdout.toString(), JSON.stringify(outcomes)).toBe(state);
    }
  });

  test("uses only the existing canary and staging session secrets for MCP journeys", async () => {
    const cases = [
      {
        file: "mcp-canary.yml",
        environment: "production",
        secrets: ["MCP_CANARY_TOKEN"],
      },
      {
        file: "deploy-staging.yml",
        environment: "staging",
        secrets: ["SMOKE_SESSION_SECRET", "STAGING_VIEWER_ACCESS_TOKEN"],
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
      const prefix = run.includes("$STAGING_HEALTH_URL") ? "" : "E2E_";
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
    expect(apiBuild).toContain("needs: [resolve, staging-health]");
    expect(apiBuild).toContain("needs.staging-health.outputs.deploy == 'true'");
    expect(webBuild).toContain("needs: [resolve, staging-health]");
    expect(webBuild).toContain("needs.staging-health.outputs.deploy == 'true'");
    expect(apiBuild).toContain("cancel-in-progress: true");
    expect(webBuild).toContain("cancel-in-progress: true");
    expect(promoteJob).toContain("cancel-in-progress: false");
    expect(promoteJob).toContain("needs: [resolve, build-api, build-web]");
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
    expect(production).not.toContain('"VITE_SEO_INDEXABLE"');
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
    const promoteJobStart = releaseWorkflow.indexOf("\n  promote:\n");
    const stagingJobStart = releaseWorkflow.indexOf(
      "\n  promote-staging:\n",
      promoteJobStart,
    );
    const promoteJob = releaseWorkflow.slice(promoteJobStart, stagingJobStart);
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
    expect(webBuildJob).not.toContain("gh run download");
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
    // Publication is the promote job's last act: the release object is a
    // draft and the mutable image aliases stay put until production
    // verifiably serves the release.
    expect(manifestJob).toContain("gh release create");
    expect(manifestJob).toContain(
      "*-rc.*) extra_args+=(--draft --prerelease) ;;",
    );
    expect(manifestJob).toContain("*) extra_args+=(--draft) ;;");
    expect(manifestJob).not.toContain("Advance stable image tags");
    expect(manifestJob).not.toContain(":latest");
    const productionVerified = promoteJob.indexOf(
      "Verify production web serves the release commit",
    );
    const releasePublished = promoteJob.indexOf("Publish GitHub release");
    const aliasesAdvanced = promoteJob.indexOf("Advance stable image tags");
    expect(productionVerified).toBeGreaterThan(-1);
    expect(releasePublished).toBeGreaterThan(productionVerified);
    expect(aliasesAdvanced).toBeGreaterThan(releasePublished);
    expect(promoteJob).toContain("--draft=false --latest=false");
    // A rerun against an already published release must not touch it: the
    // publish is gated on the draft state, so Latest is never cleared.
    const publishStep = promoteJob.slice(releasePublished, aliasesAdvanced);
    expect(publishStep.indexOf("--json isDraft")).toBeGreaterThan(-1);
    expect(publishStep.indexOf("--json isDraft")).toBeLessThan(
      publishStep.indexOf("--draft=false --latest=false"),
    );
    const stagingJob = releaseWorkflow.slice(stagingJobStart);
    expect(stagingJob.indexOf("Publish GitHub prerelease")).toBeGreaterThan(
      stagingJob.indexOf("Promote to staging"),
    );
    expect(stagingJob).toContain("--draft=false --prerelease");
    expect(stagingJob.indexOf("--json isDraft")).toBeLessThan(
      stagingJob.indexOf("--draft=false --prerelease"),
    );
    expect(releaseWorkflow).toContain(
      `group: release-\${{ github.event_name == 'workflow_dispatch' && inputs.release_ref || github.ref_name }}`,
    );
    expect(releaseWorkflow).toContain(
      "needs: [resolve, build, prepare-web-image, smoke]",
    );
    expect(releaseWorkflow.match(/web-image-digest:/gu)).toHaveLength(2);
    expect(releaseWorkflow).toContain(
      "bash scripts/smoke-api-image.sh stella-api:smoke",
    );
    const apiSmoke = await Bun.file(
      new URL("smoke-api-image.sh", import.meta.url),
    ).text();
    expect(apiSmoke).toContain('fetch("http://127.0.0.1:3001/live")');
    expect(apiSmoke).toContain(`grep -F '"message":"scheduler.started"'`);
    expect(promoteAction).toContain("readonly TOKEN_REFRESH_SECONDS=2700");
    expect(promoteAction).toContain("readonly TOKEN_REFRESH_ATTEMPTS=20");
    expect(promoteAction).toContain("refresh_app_token");
    expect(promoteAction).toContain(
      "now - token_refreshed_at >= TOKEN_REFRESH_SECONDS",
    );
    expect(promoteAction).toContain('"/installation/token"');
    expect(promoteAction).toContain("retaining the current token and retrying");
    expect(promoteAction).toContain(`echo "::add-mask::\${jwt}" >&2`);
    expect(promoteAction).toContain(`printf '%s\\n' "$APP_PRIVATE_KEY"`);
    expect(
      promoteAction.match(/Authorization: Bearer \$\{jwt\}/gu),
    ).toHaveLength(2);
    expect(promoteAction).not.toContain("gh run watch");
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
    const desktopBuild = releaseDesktopWorkflow.slice(
      desktopBuildStart,
      desktopVerifyStart,
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
    expect(desktopResolve).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(desktopResolve).not.toContain('["success", "failure"]');
    const psGalleryPreflight = desktopBuild.indexOf(
      "Ensure PSGallery is registered (Windows only)",
    );
    const azureSigning = desktopBuild.indexOf("azure/trusted-signing-action@");
    expect(psGalleryPreflight).toBeGreaterThanOrEqual(0);
    expect(azureSigning).toBeGreaterThan(psGalleryPreflight);
    expect(desktopBuild).toContain(
      "Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue",
    );
    expect(desktopBuild).toContain("if (-not $repository) {");
    expect(desktopBuild).toContain("Register-PSRepository -Default");
    expect(desktopBuild).toContain("https://www.powershellgallery.com/api/v2");
    expect(desktopVerify).toContain("API_DEPLOYMENT_PROBE_PATH: ready");
    expect(desktopVerify).toContain("API_DEPLOYMENT_PROBE_PATH: version.json");
    expect(desktopManifest).toContain(
      "needs: [resolve, build, verify-production]",
    );
    expect(desktopManifest).toContain(
      "needs.verify-production.result == 'success'",
    );
    expect(desktopManifest).toContain("needs.build.result == 'success'");
    expect(desktopManifest).not.toContain("gh release edit");
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
    ).toBeGreaterThan(desktopCarry.indexOf('gh release upload "$RELEASE_REF"'));
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
