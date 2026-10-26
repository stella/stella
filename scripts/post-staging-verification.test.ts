import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repository = "stella/stella";
const head = "a".repeat(40);
const runId = 4242;
const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;

type ScenarioOptions = {
  newestRun: number;
  ownerRun: number;
  ownerState: string;
};
const scenario = async ({
  newestRun,
  ownerRun,
  ownerState,
}: ScenarioOptions) => {
  const directory = await mkdtemp(path.join(tmpdir(), "staging-status-owner-"));
  try {
    const helper = path.join(directory, "gh-retry.sh");
    await writeFile(
      helper,
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'--method POST'*) cat > "$STATUS_LOG" ;;
  *'actions/workflows/'*) cat "$RUN_RESPONSE" ;;
  *'/statuses?per_page=100'*) cat "$STATUS_RESPONSE" ;;
  *) echo 'Unexpected endpoint' >&2; exit 1 ;;
esac
`,
    );
    const runResponse = path.join(directory, "runs.json");
    const statusResponse = path.join(directory, "statuses.json");
    const log = path.join(directory, "posted.json");
    await writeFile(log, "");
    await writeFile(
      runResponse,
      JSON.stringify({
        workflow_runs: [
          {
            id: newestRun,
            html_url: runUrl,
            head_branch: "main",
            path: ".github/workflows/deploy-staging.yml",
            display_title: `Staging release proof ${head}`,
            repository: { full_name: repository },
          },
        ],
      }),
    );
    // The run listing can still show A when B has posted its result. This
    // reproduces the three ownership variants from the reconciliation fix.
    const statuses = JSON.stringify([
      [
        {
          context: "staging/verified",
          state: ownerState,
          creator: { login: "github-actions[bot]", type: "Bot" },
          target_url: `https://github.com/${repository}/actions/runs/${ownerRun}`,
        },
      ],
    ]);
    await writeFile(statusResponse, statuses);
    const process = Bun.spawn(
      [
        "bash",
        path.join(import.meta.dir, "post-staging-verification.sh"),
        "success",
        "proof passed",
      ],
      {
        env: {
          ...Bun.env,
          GH_RETRY_SCRIPT: helper,
          GITHUB_REPOSITORY: repository,
          DEPLOY_SHA: head,
          GITHUB_RUN_ID: String(runId),
          GITHUB_SERVER_URL: "https://github.com",
          RUN_RESPONSE: runResponse,
          STATUS_RESPONSE: statusResponse,
          STATUS_LOG: log,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exit, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(await readFile(statusResponse, "utf-8")).toBe(statuses);
    return await readFile(log, "utf-8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

for (const ownerState of ["success", "failure", "pending"]) {
  test(`an older run cannot repost over a newer ${ownerState} status`, async () => {
    expect(
      await scenario({ newestRun: runId, ownerRun: runId + 1, ownerState }),
    ).toBe("");
  });
}

test("re-reading the newest run prevents an older pending writer taking ownership", async () => {
  expect(
    await scenario({
      newestRun: runId + 1,
      ownerRun: runId,
      ownerState: "pending",
    }),
  ).toBe("");
});

test("the current owner can publish its result", async () => {
  expect(
    JSON.parse(
      await scenario({
        newestRun: runId,
        ownerRun: runId,
        ownerState: "pending",
      }),
    ),
  ).toEqual({
    state: "success",
    description: "proof passed",
    context: "staging/verified",
    target_url: runUrl,
  });
});
