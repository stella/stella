import { expect, test } from "bun:test";
import { Script } from "node:vm";
import * as v from "valibot";

import {
  CANCEL_AFTER_JOB_POLL_MS,
  CANCEL_AFTER_JOB_SCRIPT,
  CANCEL_AFTER_JOB_STEP,
  CANCEL_AFTER_JOB_WAIT_MS,
  CANCEL_AFTER_JOB_WORKFLOW,
  CANCEL_FAILURE_SCRIPT,
} from "./ci-cancellation-contract";

type Job = {
  id?: number;
  name: string;
  html_url: string;
  status?: string;
  runner_name?: string;
  steps?: {
    number: number;
    name: string;
    conclusion: string;
    status?: string;
  }[];
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
  runnerName?: string;
  dispatchFails?: boolean;
  /** The job's own status, as the step's JOB_STATUS env passes it. */
  jobStatus?: string;
};

const execute = async ({
  source = CANCEL_FAILURE_SCRIPT,
  jobs = pages,
  lookupFails = false,
  lookupStalls = false,
  summaryFails = false,
  runnerName = "fixture-runner",
  dispatchFails = false,
  jobStatus,
}: ExecutionOptions = {}) => {
  const dispatches: unknown[] = [];
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
    process: {
      env: {
        GITHUB_RUN_ATTEMPT: "3",
        RUNNER_NAME: runnerName,
        ...(jobStatus === undefined ? {} : { JOB_STATUS: jobStatus }),
      },
    },
    core: {
      notice: (message: string) => {
        annotations.push(message);
        events.push("notice");
      },
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
          createWorkflowDispatch: async (parameters: unknown) => {
            events.push("dispatch");
            if (dispatchFails) {
              throw new Error("fixture dispatch failure");
            }
            dispatches.push(parameters);
          },
        },
      },
    },
  });
  return {
    dispatches,
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
  const firstLine = result.summaries.at(0)?.split("\n").at(0);
  if (
    firstLine !==
    "Merge group failed: CI tests (api-1) / 4: Run API tests (https://example.test/jobs/11); Screenshots / capture / 3: Capture screenshot (https://example.test/jobs/12). Other jobs were cancelled to free runners."
  ) {
    violations.push(
      "summary must open with failed steps and cancellation reason",
    );
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
    expect(result.summaries.at(0)).toMatch(
      /^Merge group failed: .+\. Other jobs were cancelled to free runners\.\n/u,
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
    CANCEL_FAILURE_SCRIPT.replace("Merge group failed:", "Workflow cancelled:"),
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

// This job, still running on its runner, with the step that failed it.
const ownFailedJob = (runner: string): Job => ({
  id: 77,
  name: "ci-tests (rest-web)",
  html_url: "https://example.test/jobs/77",
  status: "in_progress",
  runner_name: runner,
  steps: [
    { number: 17, name: "Test web", conclusion: "failure" },
    { number: 18, name: "Upload failed web test output", conclusion: "" },
  ],
});

test("a job whose own step failed hands the cancellation off and keeps its failure conclusion", async () => {
  const result = await execute({
    runnerName: "runner-7",
    jobs: [[ownFailedJob("runner-7")], ...pages],
  });
  expect(result.cancellations).toEqual([]);
  expect(result.dispatches).toEqual([
    {
      owner: "fixture-owner",
      repo: "fixture-repo",
      workflow_id: CANCEL_AFTER_JOB_WORKFLOW,
      ref: "main",
      inputs: { run_id: "42", run_attempt: "3", job_id: "77" },
    },
  ]);
  // The failed step is named before the hand-off, as before a cancellation.
  expect(result.summaries.at(0)).toStartWith(
    "Merge group failed: ci-tests (rest-web) / 17: Test web (https://example.test/jobs/77);",
  );
  expect(result.events.indexOf("summary-written")).toBeLessThan(
    result.events.indexOf("dispatch"),
  );
  expect(result.events.at(-1)).toBe("notice");
});

test("a refused hand-off, a helper job and an unknown runner cancel the run at once", async () => {
  const refused = await execute({
    runnerName: "runner-7",
    jobs: [[ownFailedJob("runner-7")]],
    dispatchFails: true,
  });
  expect(refused.annotations.join("\n")).toContain("could not be handed off");
  expect(refused.events.slice(-3)).toEqual([
    "dispatch",
    "annotation",
    "cancel",
  ]);
  expect(refused.cancellations).toHaveLength(1);

  // A helper job runs after the failed job ended: its own steps passed.
  const helper = await execute({
    runnerName: "runner-8",
    jobs: [
      [
        { ...ownFailedJob("runner-7"), status: "completed" },
        {
          id: 78,
          name: "marketing-screenshots-cancel",
          html_url: "https://example.test/jobs/78",
          status: "in_progress",
          runner_name: "runner-8",
          steps: [{ number: 1, name: "Set up job", conclusion: "success" }],
        },
      ],
    ],
  });
  expect(helper.dispatches).toEqual([]);
  expect(helper.cancellations).toHaveLength(1);

  const unknown = await execute({
    runnerName: "runner-9",
    jobs: [[ownFailedJob("runner-7")]],
  });
  expect(unknown.events).not.toContain("dispatch");
  expect(unknown.cancellations).toHaveLength(1);
});

// The jobs API can list this job before the step that failed it: the failed
// step is still running or has no conclusion yet.
const ownUnlistedJob = (runner: string): Job => ({
  ...ownFailedJob(runner),
  steps: [
    { number: 17, name: "Test web", conclusion: "" },
    {
      number: 18,
      name: "Cancel merge group after failure in this job",
      conclusion: "",
    },
  ],
});

test("a job that failed itself hands off and is named while the jobs API lags behind its failed step", async () => {
  const result = await execute({
    runnerName: "runner-7",
    jobStatus: "failure",
    jobs: [[ownUnlistedJob("runner-7")]],
  });
  expect(result.cancellations).toEqual([]);
  expect(result.dispatches).toEqual([
    {
      owner: "fixture-owner",
      repo: "fixture-repo",
      workflow_id: CANCEL_AFTER_JOB_WORKFLOW,
      ref: "main",
      inputs: { run_id: "42", run_attempt: "3", job_id: "77" },
    },
  ]);
  expect(result.annotations.at(0)).toBe(
    "ci-tests: cancelling failed merge group; failed steps: ci-tests (rest-web): failed step not yet listed",
  );
  expect(result.summaries.at(0)).toStartWith(
    "Merge group failed: ci-tests (rest-web): failed step not yet listed. Other jobs were cancelled to free runners.",
  );
  expect(result.annotations.at(-1)).toContain("keeps its failure conclusion");

  // Steps other jobs failed are named too, and this job is not left out.
  const alongside = await execute({
    runnerName: "runner-7",
    jobStatus: "failure",
    jobs: [[ownUnlistedJob("runner-7")], ...pages],
  });
  expect(alongside.dispatches).toHaveLength(1);
  expect(alongside.annotations.at(0)).toEndWith(
    "Screenshots / capture / 3: Capture screenshot (https://example.test/jobs/12); ci-tests (rest-web): failed step not yet listed",
  );
});

test("a job that failed itself is named even when its record is not found, and cancels at once", async () => {
  const result = await execute({
    runnerName: "runner-9",
    jobStatus: "failure",
    jobs: [[ownUnlistedJob("runner-7")]],
  });
  expect(result.dispatches).toEqual([]);
  expect(result.annotations.at(0)).toBe(
    "ci-tests: cancelling failed merge group; failed steps: ci-tests: failed step not yet listed",
  );
  expect(result.cancellations).toHaveLength(1);
});

test("a lost runner elsewhere does not keep a job that failed itself from cancelling", async () => {
  const lost: Job = {
    id: 79,
    name: "ci-tests (api-2)",
    html_url: "https://example.test/jobs/79",
    status: "completed",
    conclusion: "failure",
    steps: [
      {
        number: 4,
        name: "Run API tests",
        conclusion: "cancelled",
        status: "completed",
      },
    ],
  };
  const result = await execute({
    runnerName: "runner-7",
    jobStatus: "failure",
    jobs: [[ownUnlistedJob("runner-7"), lost]],
  });
  expect(result.annotations.join("\n")).not.toContain("runner was lost");
  expect(result.dispatches).toHaveLength(1);

  // A helper job, whose own status is success, still lets the run continue.
  const helper = await execute({
    runnerName: "runner-8",
    jobStatus: "success",
    jobs: [[lost]],
  });
  expect(helper.annotations).toEqual([
    "ci-tests (api-2): the runner was lost before any step failed; the run continues.",
  ]);
  expect(helper.cancellations).toEqual([]);
});

type AfterJobOptions = {
  runId?: string;
  runAttempt?: string;
  jobId?: string;
  runPath?: string;
  jobRunId?: number;
  jobRunAttempt?: number;
  /** The run's attempt when it is read again before cancelling. */
  currentRunAttempt?: number;
  /** The job's states, one per poll; the last one repeats. A number is a
   *  failed lookup with that HTTP status (0: a network error, no status). */
  jobStates?: readonly (
    | {
        status: string;
        conclusion: string | null;
        failedStep: boolean;
      }
    | number
  )[];
  /** How long each job lookup takes on the fake clock. */
  lookupMs?: number;
  runStatus?: string;
};

const executeAfterJob = async ({
  runId = "42",
  runAttempt = "2",
  jobId = "77",
  runPath = ".github/workflows/ci.yml",
  jobRunId = 42,
  jobRunAttempt = 2,
  currentRunAttempt = 2,
  jobStates = [
    { status: "in_progress", conclusion: null, failedStep: true },
    { status: "in_progress", conclusion: null, failedStep: true },
    { status: "completed", conclusion: "failure", failedStep: true },
  ],
  lookupMs = 0,
  runStatus = "in_progress",
}: AfterJobOptions = {}) => {
  const events: string[] = [];
  const failures: string[] = [];
  const notices: string[] = [];
  const cancellations: unknown[] = [];
  const delays: number[] = [];
  const lookupTimeouts: number[] = [];
  let clock = 1_000_000;
  const started = clock;
  let polls = 0;
  let runReads = 0;
  await new Script(
    `(async () => { ${CANCEL_AFTER_JOB_SCRIPT} })()`,
  ).runInNewContext({
    Date: { now: () => clock },
    setTimeout: (callback: () => void, delay: number) => {
      delays.push(delay);
      clock += delay;
      queueMicrotask(callback);
    },
    context: { repo: { owner: "fixture-owner", repo: "fixture-repo" } },
    process: { env: { RUN_ID: runId, RUN_ATTEMPT: runAttempt, JOB_ID: jobId } },
    core: {
      setFailed: (message: string) => {
        failures.push(message);
        events.push("failed");
      },
      info: () => {
        events.push("info");
      },
      notice: (message: string) => {
        notices.push(message);
        events.push("notice");
      },
      summary: {
        addRaw: () => ({
          write: async () => {
            events.push("summary");
          },
        }),
      },
    },
    github: {
      rest: {
        actions: {
          getWorkflowRun: async ({ run_id }: { run_id: number }) => {
            runReads += 1;
            events.push("run");
            return {
              data: {
                id: run_id,
                path: runPath,
                run_attempt: runReads === 1 ? jobRunAttempt : currentRunAttempt,
                status: runReads === 1 ? "in_progress" : runStatus,
              },
            };
          },
          getJobForWorkflowRun: async ({
            job_id,
            request,
          }: {
            job_id: number;
            request: { timeout: number };
          }) => {
            const state = jobStates[Math.min(polls, jobStates.length - 1)];
            if (state === undefined) {
              throw new TypeError("The fixture has no job state");
            }
            polls += 1;
            lookupTimeouts.push(request.timeout);
            clock += lookupMs;
            if (typeof state === "number") {
              events.push(`job-error:${state}`);
              throw Object.assign(
                new Error("fixture lookup failure"),
                state === 0 ? {} : { status: state },
              );
            }
            events.push(`job:${state.status}`);
            return {
              data: {
                id: job_id,
                run_id: jobRunId,
                run_attempt: jobRunAttempt,
                name: "ci-tests (rest-web)",
                html_url: "https://example.test/jobs/77",
                status: state.status,
                conclusion: state.conclusion,
                steps: [
                  {
                    name: "Test web",
                    conclusion: state.failedStep ? "failure" : "success",
                  },
                ],
              },
            };
          },
          cancelWorkflowRun: async (parameters: unknown) => {
            cancellations.push(parameters);
            events.push("cancel");
          },
        },
      },
    },
  });
  return {
    events,
    failures,
    notices,
    cancellations,
    delays,
    lookupTimeouts,
    polls,
    elapsed: clock - started,
  };
};

const running = { status: "in_progress", conclusion: null, failedStep: true };
const failedJob = {
  status: "completed",
  conclusion: "failure",
  failedStep: true,
};

test("the dispatched run cancels only after the failed job has ended", async () => {
  const result = await executeAfterJob();
  expect(result.failures).toEqual([]);
  expect(result.cancellations).toEqual([
    { owner: "fixture-owner", repo: "fixture-repo", run_id: 42 },
  ]);
  expect(result.events.indexOf("job:completed")).toBeLessThan(
    result.events.indexOf("cancel"),
  );
  expect(result.delays).toEqual([
    CANCEL_AFTER_JOB_POLL_MS,
    CANCEL_AFTER_JOB_POLL_MS,
  ]);
});

test("the dispatched run cancels nothing it cannot tie to a failed CI job", async () => {
  for (const [label, options] of [
    ["empty run id", { runId: "" }],
    ["empty run attempt", { runAttempt: "" }],
    ["zero job id", { jobId: "0" }],
    ["exponent run id", { runId: "1e3" }],
    ["suffixed job id", { jobId: "77abc" }],
    ["another workflow", { runPath: ".github/workflows/release.yml" }],
    ["a job of another run", { jobRunId: 41 }],
    ["a job of an earlier attempt", { jobRunAttempt: 1 }],
    ["a job that cannot be read", { jobStates: [404] }],
    [
      "a job that passed",
      {
        jobStates: [
          { status: "completed", conclusion: "success", failedStep: false },
        ],
      },
    ],
    [
      "a running job with no failed step at the deadline",
      {
        jobStates: [
          { status: "in_progress", conclusion: null, failedStep: false },
        ],
      },
    ],
    ["a job never read before the deadline", { jobStates: [502] }],
  ] as const) {
    const result = await executeAfterJob(options);
    expect(result.cancellations, label).toEqual([]);
    expect(result.failures, label).toHaveLength(1);
  }
});

test("the dispatched run retries a transient job lookup failure", async () => {
  for (const status of [502, 429, 0]) {
    const result = await executeAfterJob({
      jobStates: [running, status, status, failedJob],
    });
    expect(result.failures, String(status)).toEqual([]);
    expect(result.events.filter((event) => event === "info")).toHaveLength(2);
    expect(result.cancellations, String(status)).toHaveLength(1);
  }
});

test("the dispatched run leaves a rerun of the failed run alone", async () => {
  const result = await executeAfterJob({ currentRunAttempt: 3 });
  expect(result.cancellations).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.notices.join("\n")).toContain("attempt 3, not 2");
});

test("the dispatched run gives up waiting at its deadline and still cancels a failed job's run", async () => {
  for (const lookupMs of [0, 1000, 7000]) {
    const result = await executeAfterJob({ jobStates: [running], lookupMs });
    expect(result.cancellations, String(lookupMs)).toHaveLength(1);
    // The deadline is elapsed time, however long each lookup takes.
    expect(result.elapsed, String(lookupMs)).toBeLessThanOrEqual(
      CANCEL_AFTER_JOB_WAIT_MS + lookupMs,
    );
    expect(result.elapsed, String(lookupMs)).toBeGreaterThanOrEqual(
      CANCEL_AFTER_JOB_WAIT_MS,
    );
    // Each lookup and sleep is bounded by the time left.
    expect(
      result.lookupTimeouts.every(
        (timeout) => timeout > 0 && timeout <= CANCEL_AFTER_JOB_WAIT_MS,
      ),
      String(lookupMs),
    ).toBe(true);
  }
  // The wait stays inside the job's five-minute limit.
  expect(CANCEL_AFTER_JOB_WAIT_MS).toBeLessThan(4 * 60_000);
});

test("a run that already ended is left alone", async () => {
  const result = await executeAfterJob({ runStatus: "completed" });
  expect(result.cancellations).toEqual([]);
  expect(result.failures).toEqual([]);
  expect(result.events.at(-1)).toBe("notice");
});

test("the dispatched workflow runs the pinned script from main with only the actions grant", async () => {
  const workflow = v.parse(
    v.object({
      on: v.object({
        workflow_dispatch: v.object({
          inputs: v.record(
            v.string(),
            v.looseObject({ required: v.boolean() }),
          ),
        }),
      }),
      permissions: v.record(v.string(), v.string()),
      jobs: v.record(
        v.string(),
        v.looseObject({
          if: v.string(),
          permissions: v.record(v.string(), v.string()),
          "timeout-minutes": v.number(),
          steps: v.array(v.unknown()),
        }),
      ),
    }),
    Bun.YAML.parse(
      await Bun.file(
        `${import.meta.dir}/../.github/workflows/${CANCEL_AFTER_JOB_WORKFLOW}`,
      ).text(),
    ),
  );
  expect(Object.keys(workflow.on.workflow_dispatch.inputs).toSorted()).toEqual([
    "job_id",
    "run_attempt",
    "run_id",
  ]);
  expect(workflow.permissions).toEqual({});
  const jobs = Object.values(workflow.jobs);
  expect(jobs).toHaveLength(1);
  const [job] = jobs;
  expect(job?.if).toBe("github.ref == 'refs/heads/main'");
  expect(job?.permissions).toEqual({ actions: "write" });
  expect(job?.["timeout-minutes"]).toBe(5);
  expect(job?.steps).toEqual([CANCEL_AFTER_JOB_STEP]);
});
