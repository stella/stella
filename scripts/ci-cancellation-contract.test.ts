import { expect, test } from "bun:test";
import { Script } from "node:vm";

import { CANCEL_FAILURE_SCRIPT } from "./ci-cancellation-contract";

type Job = {
  name: string;
  html_url: string;
  steps?: { number: number; name: string; conclusion: string }[];
};

const pages: Job[][] = [
  [
    {
      name: "CI tests (api-1)",
      html_url: "https://example.test/jobs/11",
      steps: [
        { number: 4, name: "Run API tests", conclusion: "failure" },
        { number: 5, name: "Upload logs", conclusion: "success" },
      ],
    },
  ],
  [
    {
      name: "Screenshots / capture",
      html_url: "https://example.test/jobs/12",
      steps: [{ number: 3, name: "Capture screenshot", conclusion: "failure" }],
    },
  ],
];

type ExecutionOptions = {
  source?: string;
  jobs?: Job[][];
  lookupFails?: boolean;
  lookupStalls?: boolean;
  summaryFails?: boolean;
};

const execute = async ({
  source = CANCEL_FAILURE_SCRIPT,
  jobs = pages,
  lookupFails = false,
  lookupStalls = false,
  summaryFails = false,
}: ExecutionOptions = {}) => {
  const annotations: string[] = [];
  const summaries: string[] = [];
  const events: string[] = [];
  const requests: unknown[] = [];
  const cancellations: unknown[] = [];
  const timerDelays: number[] = [];
  const clearedTimers: number[] = [];
  await new Script(`(async () => { ${source} })()`).runInNewContext({
    setTimeout: (callback: () => void, delay: number) => {
      timerDelays.push(delay);
      const timer = timerDelays.length;
      if (lookupStalls) {
        queueMicrotask(callback);
      }
      return timer;
    },
    clearTimeout: (timer: number) => {
      clearedTimers.push(timer);
      events.push("timer-cleared");
    },
    context: {
      repo: { owner: "fixture-owner", repo: "fixture-repo" },
      runId: 42,
      job: "ci-tests",
    },
    process: { env: { GITHUB_RUN_ATTEMPT: "3" } },
    core: {
      error: (message: string) => {
        annotations.push(message);
        events.push("annotation");
      },
      summary: {
        addRaw: (message: string) => {
          summaries.push(message);
          events.push("summary-start");
        },
        write: async () => {
          await Promise.resolve();
          if (summaryFails) {
            throw new Error("fixture summary failure");
          }
          events.push("summary-written");
        },
      },
    },
    github: {
      paginate: async (route: string, parameters: unknown) => {
        requests.push({ route, parameters });
        if (lookupFails) {
          throw new Error("fixture lookup failure");
        }
        if (lookupStalls) {
          return new Promise<never>(() => {});
        }
        return jobs.flat();
      },
      rest: {
        actions: {
          cancelWorkflowRun: async (parameters: unknown) => {
            cancellations.push(parameters);
            events.push("cancel");
          },
        },
      },
    },
  });
  return {
    annotations,
    summaries,
    events,
    requests,
    cancellations,
    timerDelays,
    clearedTimers,
  };
};

const evidenceViolations = (result: Awaited<ReturnType<typeof execute>>) => {
  const violations: string[] = [];
  for (const text of [
    "ci-tests",
    "CI tests (api-1) / 4: Run API tests (https://example.test/jobs/11)",
    "Screenshots / capture / 3: Capture screenshot (https://example.test/jobs/12)",
  ]) {
    if (!result.annotations.some((message) => message.includes(text))) {
      violations.push(`annotation missing ${text}`);
    }
    if (!result.summaries.some((message) => message.includes(text))) {
      violations.push(`summary missing ${text}`);
    }
  }
  const cancelIndex = result.events.indexOf("cancel");
  for (const event of ["annotation", "summary-written"]) {
    const index = result.events.indexOf(event);
    if (index === -1 || index >= cancelIndex) {
      violations.push(`${event} must precede cancellation`);
    }
  }
  return violations;
};

test("failed matrix and reusable steps are annotated and durably summarized before same-run cancellation", async () => {
  const result = await execute();
  expect(evidenceViolations(result)).toEqual([]);
  expect(result.timerDelays).toEqual([10_000]);
  expect(result.clearedTimers).toEqual([1]);
  expect(result.annotations.join("\n")).not.toContain("Upload logs");
  expect(result.requests).toEqual([
    {
      route:
        "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
      parameters: {
        owner: "fixture-owner",
        repo: "fixture-repo",
        run_id: 42,
        attempt_number: 3,
        per_page: 100,
        request: { timeout: 10_000 },
      },
    },
  ]);
  expect(result.cancellations).toEqual([
    { owner: "fixture-owner", repo: "fixture-repo", run_id: 42 },
  ]);
});

test("unavailable step evidence remains explicit and never prevents cancellation", async () => {
  for (const options of [
    { lookupFails: true },
    {
      jobs: [
        { name: "Queued job", html_url: "https://example.test/jobs/13" },
      ].map((job) => [job]),
    },
    { jobs: [[]] },
  ]) {
    const result = await execute(options);
    expect(result.annotations.join("\n")).toMatch(
      /lookup unavailable|not yet available/u,
    );
    expect(result.annotations.join("\n")).not.toMatch(
      /no failed steps|all steps succeeded/iu,
    );
    expect(result.events.at(-1)).toBe("cancel");
    expect(result.cancellations).toHaveLength(1);
  }
});

test("summary write failure is annotated before cancellation still occurs", async () => {
  const result = await execute({ summaryFails: true });
  expect(result.annotations.join("\n")).toContain(
    "step summary could not be written",
  );
  expect(result.events.slice(-2)).toEqual(["annotation", "cancel"]);
  expect(result.cancellations).toHaveLength(1);
});

test("stalled failed-step lookup has a total deadline and clears its timer before cancellation completes", async () => {
  const result = await execute({ lookupStalls: true });
  expect(result.timerDelays).toEqual([10_000]);
  expect(result.clearedTimers).toEqual([1]);
  expect(result.events.indexOf("timer-cleared")).toBeLessThan(
    result.events.indexOf("cancel"),
  );
  expect(result.annotations.join("\n")).toContain("lookup unavailable");
  expect(result.events.at(-1)).toBe("cancel");
  expect(result.cancellations).toEqual([
    { owner: "fixture-owner", repo: "fixture-repo", run_id: 42 },
  ]);
});

test("evidence guard rejects missing annotation, missing summary, unawaited summary and premature cancellation", async () => {
  const cancel =
    "await github.rest.actions.cancelWorkflowRun({\n  ...context.repo,\n  run_id: context.runId,\n});";
  const mutations = [
    CANCEL_FAILURE_SCRIPT.replace("core.error(diagnostic);", ""),
    CANCEL_FAILURE_SCRIPT.replace("core.summary.addRaw", "void"),
    CANCEL_FAILURE_SCRIPT.replace(
      "await core.summary.write();",
      "core.summary.write();",
    ),
    `${cancel}\n${CANCEL_FAILURE_SCRIPT.replace(cancel, "")}`,
  ];
  for (const source of mutations) {
    expect(source).not.toBe(CANCEL_FAILURE_SCRIPT);
    expect(
      evidenceViolations(await execute({ source })).length,
    ).toBeGreaterThan(0);
  }
});

test("request contract detects a mutation dropping current-attempt identity", async () => {
  const source = CANCEL_FAILURE_SCRIPT.replace(
    "attempt_number: Number(process.env.GITHUB_RUN_ATTEMPT),",
    "",
  );
  expect(source).not.toBe(CANCEL_FAILURE_SCRIPT);
  const baseline = await execute();
  const mutated = await execute({ source });
  expect(mutated.requests).not.toEqual(baseline.requests);
});
