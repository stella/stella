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

    // Descends from the latest-pointer policy fix and adds the release job
    // environment input.
    expect(workflow).toContain(
      "stella/.github/.github/workflows/npm-independent-release.yml@68f07b8d089564fcbd9383824ddc8af31ff8d4ba # release job environment input",
    );
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
    expect(apiBuild).toContain("needs: staging-health");
    expect(apiBuild).toContain("needs.staging-health.outputs.deploy == 'true'");
    expect(webBuild).toContain("needs: staging-health");
    expect(webBuild).toContain("needs.staging-health.outputs.deploy == 'true'");
    expect(apiBuild).toContain("cancel-in-progress: true");
    expect(webBuild).toContain("cancel-in-progress: true");
    expect(promoteJob).toContain("cancel-in-progress: false");
    expect(promoteJob).toContain("Confirm this SHA is still main");
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
