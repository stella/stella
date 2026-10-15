import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  RELIEF_DESCRIPTION,
  YIELD_CONTEXT,
  reliefCancel,
} from "./relief-cancel-pr-runs";

const statusBody = v.object({
  state: v.string(),
  context: v.string(),
  description: v.string(),
});

type Run = {
  id: number;
  event: string;
  path: string;
  status: string;
  conclusion?: string | null;
  head_sha: string;
  html_url: string;
  head_repository: { full_name: string } | null;
  pull_requests?: { number: number }[];
};

const prRun = (id: number, overrides: Partial<Run> = {}): Run => ({
  id,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  status: "in_progress",
  head_sha: `head-${id}`,
  html_url: `https://github.com/stella/stella/actions/runs/${id}`,
  head_repository: { full_name: "stella/stella" },
  pull_requests: [{ number: id * 100 }],
  ...overrides,
});

const fake = (
  runs: Run[],
  {
    refuseCancel = false,
    afterFailedCancel,
    unreadableAfterCancel = false,
    protectedPulls = [],
  }: {
    protectedPulls?: number[];
    refuseCancel?: boolean;
    afterFailedCancel?: Partial<Run>;
    unreadableAfterCancel?: boolean;
  } = {},
) => {
  let cancelFailed = false;
  const calls: string[] = [];
  const statuses: { sha: string; state: string; description: string }[] = [];
  const request = async (args: readonly string[], input?: unknown) => {
    const [endpoint] = args;
    calls.push(endpoint ?? "");
    const status = endpoint?.match(/statuses\/(.+)$/u);
    if (status) {
      const body = v.parse(statusBody, input);
      expect(body.context).toBe(YIELD_CONTEXT);
      statuses.push({
        sha: status[1] ?? "",
        state: body.state,
        description: body.description,
      });
      return null;
    }
    const pullRead = endpoint?.match(/pulls\/(\d+)$/u);
    if (pullRead) {
      const number = Number(pullRead[1]);
      return {
        labels: protectedPulls.includes(number) ? [{ name: "ci-protect" }] : [],
      };
    }
    if (endpoint?.endsWith("/cancel")) {
      if (refuseCancel) {
        cancelFailed = true;
        throw new Error("cancel request failed");
      }
      return null;
    }
    const id = Number(endpoint?.split("/").at(-1));
    if (cancelFailed && unreadableAfterCancel) {
      throw new Error("read failed");
    }
    const run = runs.find((candidate) => candidate.id === id);
    if (!run) {
      throw new Error("run not found");
    }
    return cancelFailed ? { ...run, ...afterFailedCancel } : run;
  };
  return { request, calls, statuses };
};

test("a relief cancellation records the deferral before cancelling", async () => {
  const { request, calls, statuses } = fake([prRun(7)]);
  expect(await reliefCancel([7], request)).toEqual([
    { runId: 7, outcome: "deferred", headSha: "head-7" },
  ]);
  expect(statuses).toEqual([
    { sha: "head-7", state: "pending", description: RELIEF_DESCRIPTION },
  ]);
  expect(calls.indexOf("repos/stella/stella/statuses/head-7")).toBeLessThan(
    calls.indexOf("repos/stella/stella/actions/runs/7/cancel"),
  );
});

test("a refused cancellation clears the deferral record", async () => {
  const { request, statuses } = fake([prRun(8)], {
    refuseCancel: true,
    afterFailedCancel: { status: "completed", conclusion: "success" },
  });
  expect(await reliefCancel([8], request)).toEqual([
    { runId: 8, outcome: "skipped", reason: "cancel refused" },
  ]);
  expect(statuses.map(({ state }) => state)).toEqual(["pending", "success"]);
});

test("a cancellation that took effect despite a failed request keeps its record", async () => {
  const { request, statuses } = fake([prRun(11)], {
    refuseCancel: true,
    afterFailedCancel: { status: "completed", conclusion: "cancelled" },
  });
  expect(await reliefCancel([11], request)).toEqual([
    { runId: 11, outcome: "deferred", headSha: "head-11" },
  ]);
  expect(statuses.map(({ state }) => state)).toEqual(["pending"]);
});

test("a run still active after a failed request keeps its record and is reported", async () => {
  const { request, statuses } = fake([prRun(12)], {
    refuseCancel: true,
    afterFailedCancel: { status: "in_progress" },
  });
  expect(await reliefCancel([12], request)).toEqual([
    { runId: 12, outcome: "uncertain", headSha: "head-12" },
  ]);
  expect(statuses.map(({ state }) => state)).toEqual(["pending"]);
});

test("an unreadable run after a failed cancel keeps its record and is reported", async () => {
  const { request, statuses } = fake([prRun(13)], {
    refuseCancel: true,
    unreadableAfterCancel: true,
  });
  expect(await reliefCancel([13], request)).toEqual([
    { runId: 13, outcome: "uncertain", headSha: "head-13" },
  ]);
  expect(statuses.map(({ state }) => state)).toEqual(["pending"]);
});

test("one failing run never stops the others, and outcomes report as they happen", async () => {
  const { request } = fake([prRun(14), prRun(16)]);
  const reported: number[] = [];
  const outcomes = await reliefCancel([14, 15, 16], request, ({ runId }) => {
    reported.push(runId);
  });
  expect(outcomes).toEqual([
    { runId: 14, outcome: "deferred", headSha: "head-14" },
    { runId: 15, outcome: "failed" },
    { runId: 16, outcome: "deferred", headSha: "head-16" },
  ]);
  expect(reported).toEqual([14, 15, 16]);
});

test("a protected pull request's run is never touched", async () => {
  const { request, calls, statuses } = fake([prRun(17)], {
    protectedPulls: [1700],
  });
  expect(await reliefCancel([17], request)).toEqual([
    { runId: 17, outcome: "skipped", reason: "protected" },
  ]);
  expect(statuses).toEqual([]);
  expect(calls.some((call) => call.endsWith("/cancel"))).toBe(false);
});

test("a run without a resolvable pull request is never touched", async () => {
  const { request, statuses } = fake([prRun(18, { pull_requests: [] })]);
  expect(await reliefCancel([18], request)).toEqual([
    { runId: 18, outcome: "skipped", reason: "pull request unresolved" },
  ]);
  expect(statuses).toEqual([]);
});

test.each([
  ["merge_group", { event: "merge_group" }],
  ["schedule", { event: "schedule" }],
  ["another workflow", { path: ".github/workflows/codeql.yml" }],
  ["a fork", { head_repository: { full_name: "fork/stella" } }],
] as const)("a %s run is never touched", async (_label, overrides) => {
  const { request, calls, statuses } = fake([prRun(9, overrides)]);
  const [outcome] = await reliefCancel([9], request);
  expect(outcome?.outcome).toBe("skipped");
  expect(statuses).toEqual([]);
  expect(calls.some((call) => call.endsWith("/cancel"))).toBe(false);
});

test("a completed run is left alone", async () => {
  const { request, statuses } = fake([prRun(10, { status: "completed" })]);
  expect(await reliefCancel([10], request)).toEqual([
    { runId: 10, outcome: "skipped", reason: "already completed" },
  ]);
  expect(statuses).toEqual([]);
});
