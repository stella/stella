import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Execute workflow scripts against fixture boundaries so an off staging
// cannot report success and status writes use the selected deploy commit.

const WORKFLOW_URL = new URL(
  "../.github/workflows/deploy-staging.yml",
  import.meta.url,
);
const STAGING_SETUP_URL = new URL(
  "../apps/web/e2e/staging/global-setup.ts",
  import.meta.url,
);
const RESOLVER_URL = new URL("resolve-staging-deploy-sha.sh", import.meta.url);
const TIP_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const extractDecideScript = (workflow: string) => {
  const stepStart = workflow.indexOf(
    "      - name: Decide whether staging can deploy\n",
  );
  const jobEnd = workflow.indexOf("\n  build-api:\n", stepStart);
  const runStart = workflow.indexOf("run: |\n", stepStart);
  if (stepStart === -1 || jobEnd === -1 || runStart === -1) {
    throw new Error("deploy-staging.yml no longer exposes the decide step");
  }

  const body = workflow.slice(runStart + "run: |\n".length, jobEnd);
  const indents = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const dedent = Math.min(...indents);
  return body
    .split("\n")
    .map((line) => line.slice(dedent))
    .join("\n");
};

const extractStepScript = (
  workflow: string,
  stepName: string,
  nextMarker: string,
) => {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  const runStart = workflow.indexOf("run: |\n", stepStart);
  const stepEnd = workflow.indexOf(nextMarker, runStart);
  if (stepStart === -1 || runStart === -1 || stepEnd === -1) {
    throw new Error(
      `deploy-staging.yml no longer exposes the ${stepName} step`,
    );
  }

  const body = workflow.slice(runStart + "run: |\n".length, stepEnd);
  const indents = body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const dedent = Math.min(...indents);
  return body
    .split("\n")
    .map((line) => line.slice(dedent))
    .join("\n");
};

type DecisionCase = {
  deployWhenUnreachable?: boolean;
  status: "not_ready" | "ready";
  script?: string;
  statusWriteExitCode?: number;
};

type Decision = {
  deploy: string;
  exitCode: number;
  summary: string;
  calls: string;
};

let workspace = "";
let scriptPath = "";
let probeScriptPath = "";
let recordScriptPath = "";
let fixtureRepo = "";
let baseSha = "";
let mainSha = "";
let sideSha = "";

const runDecision = async ({
  deployWhenUnreachable = false,
  status,
  script = scriptPath,
  statusWriteExitCode = 0,
}: DecisionCase): Promise<Decision> => {
  const outputPath = path.join(workspace, `output-${Bun.randomUUIDv7()}.txt`);
  const summaryPath = path.join(workspace, `summary-${Bun.randomUUIDv7()}.md`);
  const callsPath = path.join(
    workspace,
    `decision-calls-${Bun.randomUUIDv7()}.txt`,
  );
  await Promise.all([
    Bun.write(outputPath, ""),
    Bun.write(summaryPath, ""),
    Bun.write(callsPath, ""),
  ]);

  const result = Bun.spawnSync(["bash", script], {
    env: {
      ...process.env,
      DEPLOY_WHEN_UNREACHABLE: String(deployWhenUnreachable),
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GH_TOKEN: "stub",
      GH_RETRY_SCRIPT: path.resolve(import.meta.dirname, "gh-retry.sh"),
      GITHUB_REPOSITORY: "stella/stella",
      GITHUB_RUN_ID: "9",
      GITHUB_SERVER_URL: "https://github.com",
      PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
      STUB_CALLS_PATH: callsPath,
      STUB_GH_EXIT_CODE: String(statusWriteExitCode),
      GITHUB_OUTPUT: outputPath,
      DEPLOY_SHA: TIP_SHA,
      GITHUB_STEP_SUMMARY: summaryPath,
      STATUS: status,
    },
  });

  const output = await Bun.file(outputPath).text();
  const deploy = output
    .split("\n")
    .findLast((line) => line.startsWith("deploy="));

  return {
    deploy: deploy ?? "",
    exitCode: result.exitCode,
    summary: await Bun.file(summaryPath).text(),
    calls: await Bun.file(callsPath).text(),
  };
};

type ProbeCase = {
  healthBody?: string;
  healthStatus?: string;
  readyBody?: string;
  readyStatus?: string;
};

const runProbe = async ({
  healthBody = `{"status":"ok","commit":"${OTHER_SHA}"}`,
  healthStatus = "200",
  readyBody = `{"status":"ok","commit":"${TIP_SHA}"}`,
  readyStatus = "200",
}: ProbeCase) => {
  const outputPath = path.join(
    workspace,
    `probe-output-${Bun.randomUUIDv7()}.txt`,
  );
  const callsPath = path.join(
    workspace,
    `probe-calls-${Bun.randomUUIDv7()}.txt`,
  );
  await Promise.all([Bun.write(outputPath, ""), Bun.write(callsPath, "")]);

  const result = Bun.spawnSync(["bash", probeScriptPath], {
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputPath,
      PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
      RUNNER_TEMP: workspace,
      STAGING_HEALTH_URL: "https://api-staging.stll.app/ready",
      STAGING_LEGACY_HEALTH_URL: "https://api-staging.stll.app/health",
      STUB_CALLS_PATH: callsPath,
      STUB_HEALTH_BODY: healthBody,
      STUB_HEALTH_STATUS: healthStatus,
      STUB_READY_BODY: readyBody,
      STUB_READY_STATUS: readyStatus,
    },
  });

  return {
    calls: await Bun.file(callsPath).text(),
    exitCode: result.exitCode,
    output: await Bun.file(outputPath).text(),
  };
};

const git = (...args: string[]) => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: fixtureRepo },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
};

const commit = (message: string) => {
  git("commit", "--allow-empty", "-qm", message);
  return git("rev-parse", "HEAD");
};

const resolve = (requested: string) => {
  const result = Bun.spawnSync(
    ["bash", Bun.fileURLToPath(RESOLVER_URL), "--sha", requested],
    { cwd: fixtureRepo },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const runRecord = async (deploySha: string) => {
  const callsPath = path.join(workspace, `gh-calls-${Bun.randomUUIDv7()}`);
  await Bun.write(callsPath, "");
  const result = Bun.spawnSync(["bash", recordScriptPath], {
    env: {
      ...process.env,
      API_SMOKE: "success",
      DEPLOYMENT_ID: "1",
      DEPLOY_SHA: deploySha,
      GH_TOKEN: "stub",
      GH_RETRY_SCRIPT: path.resolve(import.meta.dirname, "gh-retry.sh"),
      GITHUB_REPOSITORY: "stella/stella",
      GITHUB_RUN_ID: "9",
      GITHUB_SERVER_URL: "https://github.com",
      JOB_STATUS: "success",
      MCP_SMOKE: "success",
      PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
      STUB_CALLS_PATH: callsPath,
      WEB_SMOKE: "success",
    },
  });
  return {
    calls: await Bun.file(callsPath).text(),
    exitCode: result.exitCode,
  };
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "staging-deploy-decision-"));
  scriptPath = path.join(workspace, "decide.sh");
  probeScriptPath = path.join(workspace, "probe.sh");
  recordScriptPath = path.join(workspace, "record.sh");

  const workflow = await Bun.file(WORKFLOW_URL).text();
  const script = extractDecideScript(workflow);
  expect(script).toContain("set -euo pipefail");
  await Bun.write(scriptPath, script);
  await Bun.write(
    probeScriptPath,
    extractStepScript(
      workflow,
      "Probe staging health",
      "\n      # Staging that does not answer",
    ),
  );
  const recordStart = workflow.indexOf(
    "      - name: Record staging verification\n",
  );
  const recordRun = workflow.indexOf("run: |\n", recordStart);
  if (recordStart === -1 || recordRun === -1) {
    throw new Error(
      "deploy-staging.yml no longer records staging verification",
    );
  }
  const recordBody = workflow.slice(recordRun + "run: |\n".length);
  await Bun.write(
    recordScriptPath,
    recordBody
      .split("\n")
      .map((line) => line.slice("          ".length))
      .join("\n"),
  );
  // Records each status or deployment write the verification step makes.
  const ghStub = path.join(workspace, "gh");
  await Bun.write(
    ghStub,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\\n' "$*" "$(jq -c .)" >> "$STUB_CALLS_PATH"
exit "\${STUB_GH_EXIT_CODE:-0}"
`,
  );
  await chmod(ghStub, 0o755);

  // Base and tip on main, plus a commit main does not contain.
  fixtureRepo = path.join(workspace, "repo");
  await mkdir(fixtureRepo);
  git("init", "-q", "-b", "main");
  baseSha = commit("base");
  mainSha = commit("tip");
  const origin = path.join(workspace, "origin.git");
  git("init", "--bare", "-q", "-b", "main", origin);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  git("checkout", "-q", "-b", "side", baseSha);
  sideSha = commit("side");

  const curlStub = path.join(workspace, "curl");
  await Bun.write(
    curlStub,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
for ((index = 1; index <= $#; index += 1)); do
  arg="\${!index}"
  if [[ "$arg" == "--output" ]]; then
    next=$((index + 1))
    output="\${!next}"
  elif [[ "$arg" == https://* ]]; then
    url="$arg"
  fi
done
echo "$url" >> "$STUB_CALLS_PATH"
if [[ "$url" == */ready ]]; then
  if [[ "$STUB_READY_STATUS" == "000" ]]; then
    exit 7
  fi
  printf '%s' "$STUB_READY_BODY" > "$output"
  printf '%s' "$STUB_READY_STATUS"
  exit 0
fi
printf '%s' "$STUB_HEALTH_BODY" > "$output"
printf '%s' "$STUB_HEALTH_STATUS"
`,
  );
  await chmod(curlStub, 0o755);

  const sleepStub = path.join(workspace, "sleep");
  await Bun.write(
    sleepStub,
    '#!/usr/bin/env bash\nif [[ "$1" -gt 10 ]]; then exec /bin/sleep "$@"; fi\nexit 0\n',
  );
  await chmod(sleepStub, 0o755);
});

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("staging deploy decision", () => {
  test("deploys what a dispatch carries once staging answers", async () => {
    expect(await runDecision({ status: "ready" })).toMatchObject({
      deploy: "deploy=true",
      exitCode: 0,
    });
  });

  test("refuses a green dispatch without deployment and records staging off", async () => {
    const result = await runDecision({ status: "not_ready" });

    expect(result).toMatchObject({ deploy: "deploy=false", exitCode: 1 });
    expect(result.calls).toBe(
      `api repos/stella/stella/statuses/${TIP_SHA} --method POST --input - {"state":"error","context":"staging/verified","description":"staging off","target_url":"https://github.com/stella/stella/actions/runs/9"}\n`,
    );
    expect(result.summary).toContain("Staging is off");
    expect(result.summary).toContain(TIP_SHA);
  });

  test("deploys into an unhealthy staging when asked to", async () => {
    expect(
      await runDecision({ deployWhenUnreachable: true, status: "not_ready" }),
    ).toMatchObject({ deploy: "deploy=true", exitCode: 0 });
  });

  test("a failed status write cannot turn an off dispatch green", async () => {
    const result = await runDecision({
      status: "not_ready",
      statusWriteExitCode: 7,
    });
    expect(result.exitCode).toBe(7);
    expect(result.deploy).toBe("deploy=false");
    expect(result.calls).toContain(`statuses/${TIP_SHA}`);
    expect(result.calls.trim().split("\n")).toHaveLength(1);
  });

  test("every successful decision selects deployment", async () => {
    for (const status of ["ready", "not_ready"] as const) {
      for (const deployWhenUnreachable of [false, true]) {
        const result = await runDecision({ status, deployWhenUnreachable });
        if (result.exitCode === 0) {
          expect(result.deploy).toBe("deploy=true");
          expect(result.calls).toBe("");
        } else {
          expect(result.deploy).toBe("deploy=false");
          expect(result.exitCode).toBe(1);
        }
      }
    }
  });

  test("restoring the former green skip breaks the decision contract", async () => {
    const script = await Bun.file(scriptPath).text();
    const mutated = script.replace(/exit 1\s*$/u, "exit 0\n");
    expect(mutated).not.toBe(script);
    const mutationPath = path.join(workspace, "green-skip.sh");
    await Bun.write(mutationPath, mutated);
    const assertRefusal = (result: Decision) =>
      expect(result.exitCode, "staging off must fail").toBe(1);
    assertRefusal(await runDecision({ status: "not_ready" }));
    const result = await runDecision({
      status: "not_ready",
      script: mutationPath,
    });
    expect(() => assertRefusal(result)).toThrow("staging off must fail");
  });

  test("the off status belongs to the selected source with confined write permission", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const start = workflow.indexOf("  staging-health:\n");
    const end = workflow.indexOf("\n  build-api:", start);
    const healthJob = workflow.slice(start, end);
    expect(healthJob).toContain("if: github.ref == 'refs/heads/main'");
    expect(healthJob).toContain("      statuses: write");
    expect(healthJob).toContain(`GH_TOKEN: \${{ github.token }}`);
    expect(healthJob).toContain(
      `DEPLOY_SHA: \${{ needs.resolve.outputs.sha }}`,
    );
    expect(workflow).toContain("needs.staging-health.outputs.deploy == 'true'");
    expect(workflow).toContain('"$MCP_SMOKE" == "success"');
  });

  test("runs only when dispatched", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();

    expect(workflow).not.toMatch(/^\s+schedule:/mu);
    expect(workflow).toContain("  workflow_dispatch:\n");
  });
});

describe("staging readiness cutover", () => {
  test("accepts a legacy health response only after /ready returns exact 404", async () => {
    const result = await runProbe({
      healthBody: `{"status":"ok","commit":"${OTHER_SHA}"}`,
      healthStatus: "200",
      readyBody: '{"status":"missing"}',
      readyStatus: "404",
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("status=ready");
    expect(result.output).toContain(`served_commit=${OTHER_SHA}`);
    expect(result.calls).toBe(
      "https://api-staging.stll.app/ready\nhttps://api-staging.stll.app/health\n",
    );
  });

  test.each(["503", "000"])(
    "does not fall back to /health when /ready returns %s",
    async (readyStatus) => {
      const result = await runProbe({
        healthBody: `{"status":"ok","commit":"${OTHER_SHA}"}`,
        healthStatus: "200",
        readyBody: '{"status":"not_ready"}',
        readyStatus,
      });

      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("status=not_ready");
      expect(result.calls).toBe(
        "https://api-staging.stll.app/ready\n".repeat(3),
      );
    },
  );

  test("delegates post-deploy readiness to the rollout-aware smoke waiter", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const stagingSetup = await Bun.file(STAGING_SETUP_URL).text();

    expect(workflow).not.toContain("      - name: Verify staging readiness\n");
    expect(stagingSetup).toContain("const READINESS_TIMEOUT_MS = 1_200_000;");
    expect(stagingSetup).toContain("const READINESS_STABLE_SAMPLES = 3;");
    expect(stagingSetup).toContain(`url: \`\${STAGING_API_URL}/ready\`,`);
    expect(stagingSetup).not.toContain(`url: \`\${STAGING_API_URL}/health\`,`);
  });
});

describe("staging deploy commit", () => {
  test("deploys the main tip when no commit is pinned", () => {
    expect(resolve("")).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `sha=${mainSha}\ntip=true\nmain-sha=${mainSha}\n`,
    });
  });

  test("deploys a pinned first-parent commit after main moved on", () => {
    expect(resolve(baseSha)).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `sha=${baseSha}\ntip=false\nmain-sha=${mainSha}\n`,
    });
    expect(resolve(mainSha)).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `sha=${mainSha}\ntip=true\nmain-sha=${mainSha}\n`,
    });
  });

  test("refuses a pinned commit that main does not contain", () => {
    const result = resolve(sideSha);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("STAGING_SHA_REFUSED");
    expect(result.stderr).toBe(
      `::error::STAGING_SHA_REFUSED: ${sideSha} is not on the first-parent history of origin/main (${mainSha})\n`,
    );
  });

  test.each([
    ["an abbreviated SHA", () => baseSha.slice(0, 12)],
    ["an unknown SHA", () => OTHER_SHA],
    ["a branch name", () => "main"],
  ])("refuses %s", (_label, requested) => {
    const result = resolve(requested());

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("STAGING_SHA_REFUSED");
  });

  test("records staging/verified on the pinned commit", async () => {
    const result = await runRecord(baseSha);

    expect(result.exitCode).toBe(0);
    const statusWrites = result.calls
      .split("\n")
      .filter((line) => line.includes("repos/stella/stella/statuses/"));
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0]).toContain(
      `repos/stella/stella/statuses/${baseSha} `,
    );
    expect(statusWrites[0]).toContain('"context":"staging/verified"');
    expect(statusWrites[0]).toContain('"state":"success"');
  });

  test("builds, promotes and verifies only the resolved commit", async () => {
    const workflow = await Bun.file(WORKFLOW_URL).text();
    const resolved = `\${{ needs.resolve.outputs.sha }}`;

    // No step reads the dispatch commit, and nothing skips a promotion.
    expect(workflow).not.toContain("github.sha");
    expect(workflow).not.toContain("GITHUB_SHA");
    expect(workflow).not.toContain("promoted=false");
    expect(workflow).toContain(
      'run: bash scripts/resolve-staging-deploy-sha.sh --sha "$REQUESTED_SHA" >> "$GITHUB_OUTPUT"',
    );
    expect(workflow).toContain(`REQUESTED_SHA: \${{ inputs.sha }}`);
    for (const consumer of [
      `ref: ${resolved}`,
      `STELLA_COMMIT_SHA=${resolved}`,
      `release-sha: ${resolved}`,
      `git-sha: ${resolved}`,
      `EXPECTED_COMMIT: ${resolved}`,
      `DEPLOY_SHA: ${resolved}`,
    ]) {
      expect(workflow).toContain(consumer);
    }
    for (const job of ["staging-health", "build-api", "build-web"]) {
      const start = workflow.indexOf(`\n  ${job}:\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(workflow.slice(start, workflow.indexOf("steps:", start))).toMatch(
        /needs: (resolve|\[resolve, )/u,
      );
    }
    expect(workflow).toContain("needs: [resolve, build-api, build-web]");
  });
});
