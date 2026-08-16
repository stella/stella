import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// The staging gate decides, per run, whether to deploy, defer, or escalate.
// Reading that decision out of the workflow text only proves the words are
// there, so this runs the real script against a stubbed API instead: the
// outcome of a push during an outage is exactly what regresses unnoticed.

const WORKFLOW_URL = new URL(
  "../.github/workflows/deploy-staging.yml",
  import.meta.url,
);
const STAGING_SETUP_URL = new URL(
  "../apps/web/e2e/staging/global-setup.ts",
  import.meta.url,
);
const TIP_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HOUR_SECONDS = 3600;

const extractDecideScript = (workflow: string) => {
  const stepStart = workflow.indexOf(
    "      - name: Decide deploy, defer, or escalate\n",
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
  committedHoursAgo?: number;
  deployedSha?: string;
  event: "push" | "schedule" | "workflow_dispatch";
  // Age of the oldest commit staging has not taken. Defaults to the tip's own
  // age; set it independently to model an outage that outlives its commits.
  pendingSinceHoursAgo?: number;
  servedCommit?: string;
  status: "not_ready" | "ready";
};

type Decision = { deploy: string; exitCode: number };

let workspace = "";
let scriptPath = "";
let probeScriptPath = "";
let currentScriptPath = "";

const runDecision = async ({
  committedHoursAgo = 1,
  deployedSha = OTHER_SHA,
  event,
  pendingSinceHoursAgo,
  servedCommit = "",
  status,
}: DecisionCase): Promise<Decision> => {
  const outputPath = path.join(workspace, `output-${Bun.randomUUIDv7()}.txt`);
  const summaryPath = path.join(workspace, `summary-${Bun.randomUUIDv7()}.md`);
  await Promise.all([Bun.write(outputPath, ""), Bun.write(summaryPath, "")]);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const committedEpoch = nowSeconds - committedHoursAgo * HOUR_SECONDS;
  const pendingSinceEpoch =
    nowSeconds - (pendingSinceHoursAgo ?? committedHoursAgo) * HOUR_SECONDS;

  const result = Bun.spawnSync(["bash", scriptPath], {
    env: {
      ...process.env,
      DEPLOY_ENVIRONMENT: "staging",
      GH_TOKEN: "stub",
      GITHUB_EVENT_NAME: event,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "stella/stella",
      GITHUB_SHA: TIP_SHA,
      GITHUB_STEP_SUMMARY: summaryPath,
      PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
      SERVED_COMMIT: servedCommit,
      STATUS: status,
      STUB_COMMITTED_EPOCH: String(committedEpoch),
      STUB_DEPLOYED_SHA: deployedSha,
      STUB_PENDING_SINCE_EPOCH: String(pendingSinceEpoch),
    },
  });

  const output = await Bun.file(outputPath).text();
  const deploy = output
    .split("\n")
    .findLast((line) => line.startsWith("deploy="));

  return { deploy: deploy ?? "", exitCode: result.exitCode };
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

const runCurrentCheck = async (currentSha: string) => {
  const outputPath = path.join(
    workspace,
    `current-output-${Bun.randomUUIDv7()}.txt`,
  );
  const summaryPath = path.join(
    workspace,
    `current-summary-${Bun.randomUUIDv7()}.md`,
  );
  await Promise.all([Bun.write(outputPath, ""), Bun.write(summaryPath, "")]);

  const result = Bun.spawnSync(["bash", currentScriptPath], {
    env: {
      ...process.env,
      GH_TOKEN: "stub",
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "stella/stella",
      GITHUB_SHA: TIP_SHA,
      GITHUB_STEP_SUMMARY: summaryPath,
      PATH: `${workspace}:${process.env["PATH"] ?? ""}`,
      STUB_CURRENT_SHA: currentSha,
    },
  });

  return {
    exitCode: result.exitCode,
    output: await Bun.file(outputPath).text(),
    summary: await Bun.file(summaryPath).text(),
  };
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "staging-deploy-decision-"));
  scriptPath = path.join(workspace, "decide.sh");
  probeScriptPath = path.join(workspace, "probe.sh");
  currentScriptPath = path.join(workspace, "current.sh");

  const workflow = await Bun.file(WORKFLOW_URL).text();
  const script = extractDecideScript(workflow);
  expect(script).toContain("set -euo pipefail");
  expect(script).toContain("readonly MAX_DEFERRAL_HOURS=");
  await Bun.write(scriptPath, script);
  await Bun.write(
    probeScriptPath,
    extractStepScript(
      workflow,
      "Probe staging health",
      "\n      # Absent staging defers",
    ),
  );
  await Bun.write(
    currentScriptPath,
    extractStepScript(
      workflow,
      "Confirm this SHA is still main",
      "\n      - name: Check staging deployment target",
    ),
  );
  // Stands in for the reads the script makes: the last recorded staging
  // deployment, the oldest commit staging has not taken, and the tip's own
  // timestamp.
  const stub = path.join(workspace, "gh");
  await Bun.write(
    stub,
    `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *"/git/ref/heads/main"*) echo "\${STUB_CURRENT_SHA:-${TIP_SHA}}"; exit 0 ;;
    *"/deployments?environment="*) echo "\${STUB_DEPLOYED_SHA}"; exit 0 ;;
    *"/compare/"*) echo "\${STUB_PENDING_SINCE_EPOCH}"; exit 0 ;;
    *"/commits/"*) echo "\${STUB_COMMITTED_EPOCH}"; exit 0 ;;
  esac
done
exit 0
`,
  );
  await chmod(stub, 0o755);

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
  await Bun.write(sleepStub, "#!/usr/bin/env bash\nexit 0\n");
  await chmod(sleepStub, 0o755);
});

afterAll(async () => {
  await rm(workspace, { force: true, recursive: true });
});

describe("staging deploy decision", () => {
  test("deploys what a push or dispatch carries once staging answers", async () => {
    expect(await runDecision({ event: "push", status: "ready" })).toEqual({
      deploy: "deploy=true",
      exitCode: 0,
    });
  });

  test("resumes a deferred deploy when staging serves an older commit", async () => {
    expect(
      await runDecision({
        event: "schedule",
        servedCommit: OTHER_SHA,
        status: "ready",
      }),
    ).toEqual({ deploy: "deploy=true", exitCode: 0 });
  });

  test("leaves staging alone when it already serves the tip", async () => {
    expect(
      await runDecision({
        event: "schedule",
        servedCommit: TIP_SHA,
        status: "ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 0 });
  });

  // An unreadable stamp once meant "staging is behind" forever, which
  // redeployed staging on every scheduled tick.
  test.each(["", "dev", TIP_SHA.toUpperCase(), `${TIP_SHA}extra`])(
    "does not resume on the unresolvable commit stamp %p",
    async (servedCommit) => {
      expect(
        await runDecision({ event: "schedule", servedCommit, status: "ready" }),
      ).toEqual({ deploy: "deploy=false", exitCode: 0 });
    },
  );

  test("deploys anyway when a dispatch bypasses the gate", async () => {
    expect(
      await runDecision({ event: "workflow_dispatch", status: "not_ready" }),
    ).toEqual({ deploy: "deploy=true", exitCode: 0 });
  });

  test("defers instead of failing while staging is unreachable", async () => {
    expect(
      await runDecision({
        committedHoursAgo: 11,
        event: "schedule",
        status: "not_ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 0 });
  });

  test("stays green when nothing is waiting on the environment", async () => {
    expect(
      await runDecision({
        committedHoursAgo: 240,
        deployedSha: TIP_SHA,
        event: "schedule",
        status: "not_ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 0 });
  });

  test("fails once a commit has waited past the deferral budget", async () => {
    expect(
      await runDecision({
        committedHoursAgo: 20,
        event: "schedule",
        status: "not_ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 1 });
  });

  // Measuring the tip would restart the clock on every push made during one
  // outage, so the alarm would never fire during the longest outages.
  test("keeps the clock running when a push lands mid-outage", async () => {
    expect(
      await runDecision({
        committedHoursAgo: 1,
        event: "schedule",
        pendingSinceHoursAgo: 20,
        status: "not_ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 1 });
  });

  test("does not escalate when only the tip is old but delivery is current", async () => {
    expect(
      await runDecision({
        committedHoursAgo: 240,
        event: "schedule",
        pendingSinceHoursAgo: 2,
        status: "not_ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 0 });
  });

  test("escalates when no deployment has ever been recorded", async () => {
    expect(
      await runDecision({
        committedHoursAgo: 20,
        deployedSha: "",
        event: "schedule",
        status: "not_ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 1 });
  });

  // A push has just started waiting, whatever its committer date says.
  test("never escalates on a push", async () => {
    expect(
      await runDecision({
        committedHoursAgo: 240,
        event: "push",
        status: "not_ready",
      }),
    ).toEqual({ deploy: "deploy=false", exitCode: 0 });
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
    expect(stagingSetup).toContain(`url: \`\${API_URL}/ready\`,`);
    expect(stagingSetup).not.toContain(`url: \`\${API_URL}/health\`,`);
  });
});

describe("private promotion coalescing", () => {
  test("allows the exact main tip to cross the private boundary", async () => {
    expect(await runCurrentCheck(TIP_SHA)).toEqual({
      exitCode: 0,
      output: "promoted=true\n",
      summary: "",
    });
  });

  test("turns an obsolete completed build into a successful no-op", async () => {
    const result = await runCurrentCheck(OTHER_SHA);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("promoted=false\n");
    expect(result.summary).toContain("Skipping private promotion");
    expect(result.summary).toContain(OTHER_SHA);
  });
});
