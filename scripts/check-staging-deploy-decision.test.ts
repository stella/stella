import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The staging gate decides, per run, whether to deploy, defer, or escalate.
// Reading that decision out of the workflow text only proves the words are
// there, so this runs the real script against a stubbed API instead: the
// outcome of a push during an outage is exactly what regresses unnoticed.

const WORKFLOW_URL = new URL(
  "../.github/workflows/deploy-staging.yml",
  import.meta.url,
);
const TIP_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HOUR_SECONDS = 3600;

const extractDecideScript = (workflow: string) => {
  const stepStart = workflow.indexOf(
    "      - name: Decide deploy, defer, or escalate\n",
  );
  const jobEnd = workflow.indexOf("\n  build-and-deploy:\n", stepStart);
  const runStart = workflow.indexOf("run: |\n", stepStart);
  if (stepStart < 0 || jobEnd < 0 || runStart < 0) {
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

type DecisionCase = {
  committedHoursAgo?: number;
  deployedSha?: string;
  event: "push" | "schedule" | "workflow_dispatch";
  servedCommit?: string;
  status: "not_ready" | "ready";
};

type Decision = { deploy: string; exitCode: number };

let workspace = "";
let scriptPath = "";

const runDecision = async ({
  committedHoursAgo = 1,
  deployedSha = OTHER_SHA,
  event,
  servedCommit = "",
  status,
}: DecisionCase): Promise<Decision> => {
  const outputPath = join(workspace, `output-${Bun.randomUUIDv7()}.txt`);
  const summaryPath = join(workspace, `summary-${Bun.randomUUIDv7()}.md`);
  await Promise.all([Bun.write(outputPath, ""), Bun.write(summaryPath, "")]);

  const committedEpoch =
    Math.floor(Date.now() / 1000) - committedHoursAgo * HOUR_SECONDS;

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
    },
  });

  const output = await Bun.file(outputPath).text();
  const deploy = output
    .split("\n")
    .filter((line) => line.startsWith("deploy="))
    .at(-1);

  return { deploy: deploy ?? "", exitCode: result.exitCode };
};

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "staging-deploy-decision-"));
  scriptPath = join(workspace, "decide.sh");

  const script = extractDecideScript(await Bun.file(WORKFLOW_URL).text());
  expect(script).toContain("set -euo pipefail");
  expect(script).toContain("readonly MAX_DEFERRAL_HOURS=");
  await Bun.write(scriptPath, script);

  // Stands in for the two reads the script makes: the last recorded staging
  // deployment, and the commit's timestamp.
  const stub = join(workspace, "gh");
  await Bun.write(
    stub,
    `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *"/deployments?environment="*) echo "\${STUB_DEPLOYED_SHA}"; exit 0 ;;
    *"/commits/"*) echo "\${STUB_COMMITTED_EPOCH}"; exit 0 ;;
  esac
done
exit 0
`,
  );
  await chmod(stub, 0o755);
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
