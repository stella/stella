import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WORKFLOW_URL = new URL(
  "../.github/workflows/ci-full-label.yml",
  import.meta.url,
);
const EVENT_HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

const workflowScript = async () => {
  const workflow = await Bun.file(WORKFLOW_URL).text();
  const marker = "        run: |\n";
  const start = workflow.indexOf(marker);
  if (start === -1) {
    throw new Error("ci-full-label.yml no longer exposes the rerun script");
  }

  return workflow
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
};

type RerunCase = {
  liveHeads: readonly string[];
  runStatus: "completed" | "in_progress";
};

const runLabelStep = async ({ liveHeads, runStatus }: RerunCase) => {
  const dir = await mkdtemp(path.join(tmpdir(), "stella-ci-full-label-"));
  try {
    const scriptPath = path.join(dir, "step.sh");
    const ghPath = path.join(dir, "gh");
    const callsPath = path.join(dir, "calls");
    const counterPath = path.join(dir, "head-counter");
    await Promise.all([
      Bun.write(scriptPath, await workflowScript()),
      Bun.write(callsPath, ""),
      Bun.write(counterPath, "0"),
      Bun.write(
        ghPath,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$STUB_CALLS"
if [[ "$1" == "api" && "$2" == "repos/stella/stella/pulls/17" ]]; then
  index="$(cat "$STUB_HEAD_COUNTER")"
  printf '%s' "$((index + 1))" > "$STUB_HEAD_COUNTER"
  live_head="$(printf '%s' "$STUB_LIVE_HEADS" | cut -d, -f"$((index + 1))")"
  if [[ -z "$live_head" ]]; then
    live_head="$(printf '%s' "$STUB_LIVE_HEADS" | awk -F, '{print $NF}')"
  fi
  printf '%s\\n' "$live_head"
elif [[ "$1" == "api" && "$2" == *"/workflows/ci.yml/runs?"* ]]; then
  printf '91 %s\\n' "$STUB_RUN_STATUS"
elif [[ "$1" == "api" && "$2" == "repos/stella/stella/actions/runs/91" ]]; then
  printf 'completed\\n'
fi
`,
      ),
    ]);
    await chmod(ghPath, 0o755);

    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", scriptPath], {
      env: {
        ...process.env,
        GH_TOKEN: "stub",
        HEAD_SHA: EVENT_HEAD,
        PR_NUMBER: "17",
        REPO: "stella/stella",
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        STUB_CALLS: callsPath,
        STUB_HEAD_COUNTER: counterPath,
        STUB_LIVE_HEADS: liveHeads.join(","),
        STUB_RUN_STATUS: runStatus,
      },
    });
    return {
      calls: (await Bun.file(callsPath).text()).trim().split("\n"),
      exitCode: result.exitCode,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("a delayed label event leaves a newer head's CI run alone", async () => {
  const result = await runLabelStep({
    liveHeads: [NEW_HEAD],
    runStatus: "in_progress",
  });

  expect(result.exitCode).toBe(0);
  expect(result.calls.filter((call) => call.startsWith("run "))).toEqual([]);
  expect(
    result.calls.some((call) => call.includes("/workflows/ci.yml/runs?")),
  ).toBe(false);
});

test("a head change while waiting prevents rerunning the superseded run", async () => {
  const result = await runLabelStep({
    liveHeads: [EVENT_HEAD, NEW_HEAD],
    runStatus: "in_progress",
  });

  expect(result.exitCode).toBe(0);
  expect(result.calls.filter((call) => call.startsWith("run "))).toEqual([
    "run cancel 91 --repo stella/stella",
  ]);
});

test("a current head can still rerun its completed CI run", async () => {
  const result = await runLabelStep({
    liveHeads: [EVENT_HEAD, EVENT_HEAD],
    runStatus: "completed",
  });

  expect(result.exitCode).toBe(0);
  expect(result.calls.filter((call) => call.startsWith("run "))).toEqual([
    "run rerun 91 --repo stella/stella",
  ]);
});

test("a current head can cancel and rerun its in-progress CI run", async () => {
  const result = await runLabelStep({
    liveHeads: [EVENT_HEAD, EVENT_HEAD],
    runStatus: "in_progress",
  });

  expect(result.exitCode).toBe(0);
  expect(result.calls.filter((call) => call.startsWith("run "))).toEqual([
    "run cancel 91 --repo stella/stella",
    "run rerun 91 --repo stella/stella",
  ]);
});
