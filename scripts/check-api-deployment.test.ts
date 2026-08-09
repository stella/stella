import { describe, expect, test } from "bun:test";

import { getApiHealthUrl, parseHealthCommit } from "./api-health";
import { advanceDeploymentStability } from "./check-api-deployment";

describe("API deployment health receipt", () => {
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
  });

  test("ties staging promotion to the current health gate", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
    ).text();
    const healthJobStart = workflow.indexOf("\n  staging-health:\n");
    const deployJobStart = workflow.indexOf("\n  build-and-deploy:\n");
    const verifyJobStart = workflow.indexOf("\n  verify-staging:\n");
    const healthJob = workflow.slice(healthJobStart, deployJobStart);
    const deployJob = workflow.slice(deployJobStart, verifyJobStart);

    expect(healthJobStart).toBeGreaterThanOrEqual(0);
    expect(deployJobStart).toBeGreaterThan(healthJobStart);
    expect(verifyJobStart).toBeGreaterThan(deployJobStart);
    // The gate only reads: it decides whether to promote, never promotes.
    // Both delimiters are asserted so a missing block cannot slice to "" and
    // satisfy the write check by being empty.
    const permissionsStart = healthJob.indexOf("permissions:");
    const outputsStart = healthJob.indexOf("outputs:");
    expect(permissionsStart).toBeGreaterThanOrEqual(0);
    expect(outputsStart).toBeGreaterThan(permissionsStart);
    const healthPermissions = healthJob.slice(permissionsStart, outputsStart);
    expect(healthPermissions).toContain("contents: read");
    expect(healthPermissions).toContain("deployments: read");
    expect(healthPermissions).not.toContain("write");
    expect(healthJob).toContain(
      "STAGING_HEALTH_URL: https://api-staging.stll.app/ready",
    );
    expect(healthJob).toContain('readonly NOT_READY_STATUS="not_ready"');
    expect(healthJob).toContain('readonly READY_STATUS="ready"');
    expect(healthJob).toContain('status="$NOT_READY_STATUS"');
    expect(healthJob).toContain('status="$READY_STATUS"');
    expect(healthJob).toContain(`echo "status=\${status}" >> "$GITHUB_OUTPUT"`);
    expect(healthJob).toContain(
      "workflow_dispatch bypasses the gate and deploys anyway.",
    );
    // An unreachable environment defers; only a wait past the budget fails.
    expect(healthJob).toContain("readonly MAX_DEFERRAL_HOURS=");
    expect(healthJob).toContain("the environment needs attention.");
    expect(deployJob).toContain("needs: staging-health");
    expect(deployJob).toContain(
      "needs.staging-health.outputs.deploy == 'true'",
    );
  });

  test("release promotion preserves the full online-migration window", async () => {
    const [releaseWorkflow, stagingWorkflow, promoteAction] = await Promise.all(
      [
        Bun.file(
          new URL("../.github/workflows/release.yml", import.meta.url),
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
      ],
    );
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
    expect(webBuildJob).toContain(`-f "inputs[release_sha]=\${RELEASE_SHA}"`);
    expect(webBuildJob).toContain(`-f "inputs[request_id]=\${REQUEST_ID}"`);
    expect(webBuildJob).toContain(".releaseSha == $release_sha");
    expect(webBuildJob).toContain("stella-web.intoto.jsonl");
    expect(webBuildJob).toContain(
      "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
    );
    expect(webBuildJob).toContain(
      `candidate_tag="candidate-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"`,
    );
    expect(webBuildJob).toContain(".targetEnvironment == $target_environment");
    expect(webBuildJob).not.toContain(`tags+=("\${IMAGE}:latest")`);
    expect(manifestJob).toContain(
      "bash .workflow-source/scripts/create-release-manifest.sh",
    );
    expect(manifestJob).toContain("Publish immutable release image tags");
    expect(manifestJob).toContain(
      `Immutable image tag \${image}:\${tag} points to a different digest.`,
    );
    expect(manifestJob).toContain('"STELLA_COMMIT_SHA=" + $commit');
    expect(manifestJob.indexOf("Publish GitHub release manifest")).toBeLessThan(
      manifestJob.indexOf("Advance stable image tags"),
    );
    expect(releaseWorkflow).toContain(
      `group: release-\${{ github.event_name == 'workflow_dispatch' && inputs.release_ref || github.ref_name }}`,
    );
    expect(releaseWorkflow).toContain(
      "needs: [resolve, build, prepare-web-image, smoke]",
    );
    expect(releaseWorkflow.match(/web-image-digest:/gu)).toHaveLength(2);
    expect(releaseWorkflow).toContain("curl -fsS http://127.0.0.1:3001/live");
    expect(releaseWorkflow).toContain(
      `grep -q '"message":"scheduler.started"'`,
    );
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
      "Tagged frontend promotions require a prebuilt web image digest.",
    );
    expect(promoteJob).not.toContain("steps.app-token.outputs.token");
    expect(stagingWorkflow).not.toContain(
      "steps.deployment-token.outputs.token",
    );
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
