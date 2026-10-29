import { Result } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ownsCodeCheckPath } from "../packages/scripts/src/code-quality-partition";
import { planCheck, scopedCommands } from "./code-check-affected";
import {
  createTaskExecutionTracker,
  createTaskProgressWatchdog,
  DEFAULT_TASK_BUDGETS,
  evaluateTaskBudgets,
  ownedProcessGroupMembers,
  ownedProcessTreeRows,
  parseTaskBudgets,
  parseTurboRunSummary,
  processCpuSnapshot,
  runBudgetedCheck,
  TaskBudgetInputError,
} from "./code-quality-task-budget";
import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };

// Shape serialized by Turbo v2.11.6's RunSummary and TaskExecutionSummary.
const task = (
  taskId: string,
  milliseconds: number,
  status: "HIT" | "MISS" = "MISS",
  exitCode: number | null = 0,
) => ({
  taskId,
  task: taskId.split("#").at(1),
  package: taskId.split("#").at(0),
  cache: { local: status === "HIT", remote: false, status, timeSaved: 999_999 },
  execution: { startTime: 1000, endTime: 1000 + milliseconds, exitCode },
});
const summary = (...tasks: unknown[]) => ({
  version: "1",
  turboVersion: "2.11.6",
  execution: { startTime: 0, endTime: 1_000_000, exitCode: 0 },
  tasks,
});

test("cache-miss execution milliseconds enforce the central web and default budgets", () => {
  const budgetCases = [
    ...Object.entries(DEFAULT_TASK_BUDGETS.overrides),
    ["//#typecheck:repo", DEFAULT_TASK_BUDGETS.defaultSeconds] as const,
  ];
  for (const [taskId, budget] of budgetCases) {
    const positive = summary(task(taskId, budget * 1000));
    const mutation = summary(task(taskId, budget * 1000 + 1));
    expect(positive).not.toEqual(mutation);
    expect(
      evaluateTaskBudgets({ summary: parseTurboRunSummary(positive) })
        .violations,
    ).toEqual([]);
    const report = evaluateTaskBudgets({
      summary: parseTurboRunSummary(mutation),
    });
    expect(report.violations).toMatchObject([
      { taskId, budgetSeconds: budget },
    ]);
    expect(report.markdown).toContain("OVER BUDGET");
    expect(report.markdown).toContain(`${budget + 0.001}s`);
  }
});

test("budgets cover measured cold p95 and twice the uncached measurement", () => {
  const { default: defaultSamples, ...taskSamples } =
    configuredBudgets.coldSamplesSeconds;
  expect(Object.keys(taskSamples).toSorted()).toEqual(
    Object.keys(DEFAULT_TASK_BUDGETS.overrides)
      .filter(
        (taskId) =>
          !configuredBudgets.retainedApiTaskDefaults.some(
            (retained) => retained === taskId,
          ),
      )
      .toSorted(),
  );
  for (const [taskId, samples] of Object.entries({
    default: defaultSamples,
    ...taskSamples,
  })) {
    const sorted = samples.toSorted((left, right) => left - right);
    const p95 = sorted.at(Math.ceil(sorted.length * 0.95) - 1);
    const largest = sorted.at(-1);
    if (p95 === undefined || largest === undefined) {
      throw new Error("Missing cold measurements");
    }
    const floor = Math.max(p95 * 1.5, largest * 2);
    const budget =
      taskId === "default"
        ? DEFAULT_TASK_BUDGETS.defaultSeconds
        : DEFAULT_TASK_BUDGETS.overrides[taskId];
    expect(budget).toBeGreaterThanOrEqual(floor);
    if (taskId !== "default") {
      expect(budget).toBeGreaterThanOrEqual(floor + 30);
    }
  }
  const coldApi = parseTurboRunSummary(
    summary(
      task("@stll/api#lint", 407_816),
      task("@stll/api#typecheck", 148_427),
    ),
  );
  expect(evaluateTaskBudgets({ summary: coldApi }).violations).toEqual([]);
  expect(
    evaluateTaskBudgets({
      summary: coldApi,
      budgets: { defaultSeconds: 90, overrides: {} },
    }).violations,
  ).toHaveLength(2);
});

test("the declaration producer has a measured budget instead of the default bucket", () => {
  const taskId = "@stll/api#generate:typecheck-declarations";
  const samples = configuredBudgets.coldSamplesSeconds[taskId];
  expect(samples.length).toBeGreaterThanOrEqual(3);
  const measured = Math.max(...samples);
  const expected = Math.ceil(Math.max(measured * 1.5, measured * 2) + 30);
  expect(DEFAULT_TASK_BUDGETS.overrides[taskId]).toBe(expected);
  expect(measured).toBeGreaterThan(DEFAULT_TASK_BUDGETS.defaultSeconds);
  const coldProducer = parseTurboRunSummary(
    summary(task(taskId, measured * 1000)),
  );
  expect(evaluateTaskBudgets({ summary: coldProducer }).violations).toEqual([]);
  expect(
    evaluateTaskBudgets({
      summary: coldProducer,
      budgets: {
        defaultSeconds: DEFAULT_TASK_BUDGETS.defaultSeconds,
        overrides: {},
      },
    }).violations,
  ).toMatchObject([{ taskId }]);
});

test("API budget fixtures bind completed cold observations to their task entries", () => {
  for (const [taskId, observations] of Object.entries(
    configuredBudgets.apiTaskSamples,
  )) {
    expect(observations.length, taskId).toBeGreaterThanOrEqual(3);
    expect(
      new Set(observations.map(({ runId, jobId }) => `${runId}/${jobId}`)).size,
      taskId,
    ).toBe(observations.length);
    for (const observation of observations) {
      expect(observation.cache).toBe("MISS");
      expect(observation.outcome).toBe("completed");
      expect(configuredBudgets.sourceJobs).toContain(
        `https://github.com/stella/stella/actions/runs/${observation.runId}/job/${observation.jobId}`,
      );
    }
    const registered = Object.entries(
      configuredBudgets.coldSamplesSeconds,
    ).find(([id]) => id === taskId);
    expect(registered?.[1], taskId).toEqual(
      observations.map(({ seconds }) => seconds),
    );
    const largest = Math.max(...observations.map(({ seconds }) => seconds));
    expect(DEFAULT_TASK_BUDGETS.overrides[taskId], taskId).toBe(
      Math.ceil(Math.max(largest * 1.5, largest * 2) + 30),
    );
  }
});

const turboTaskSchema = v.looseObject({
  dependsOn: v.optional(v.array(v.string()), []),
});
type ApiQualityGraphOptions = {
  tasks: Readonly<Record<string, v.InferOutput<typeof turboTaskSchema>>>;
  entryPoints: readonly string[];
  packages: ReadonlyMap<
    string,
    {
      scripts: Readonly<Record<string, string>>;
      dependencies: readonly string[];
    }
  >;
};
const apiQualityTasks = ({
  tasks,
  entryPoints,
  packages,
}: ApiQualityGraphOptions) => {
  const pending = [...entryPoints];
  const visited = new Set<string>();
  const apiTasks = new Set<string>();
  for (const taskId of pending) {
    if (visited.has(taskId)) {
      continue;
    }
    visited.add(taskId);
    const separator = taskId.indexOf("#");
    const owner = taskId.slice(0, separator);
    const name = taskId.slice(separator + 1);
    if (
      owner === "@stll/api" &&
      Object.hasOwn(packages.get(owner)?.scripts ?? {}, name)
    ) {
      apiTasks.add(taskId);
    }
    const definition = tasks[taskId] ?? tasks[name];
    for (const dependency of definition?.dependsOn ?? []) {
      if (dependency.startsWith("^")) {
        for (const upstream of packages.get(owner)?.dependencies ?? []) {
          pending.push(`${upstream}#${dependency.slice(1)}`);
        }
        continue;
      }
      pending.push(
        dependency.includes("#") ? dependency : `${owner}#${dependency}`,
      );
    }
  }
  return [...apiTasks].toSorted();
};
const missingApiTaskBudgets = (
  tasks: readonly string[],
  budgets: Readonly<Record<string, number>>,
) => tasks.filter((taskId) => !Object.hasOwn(budgets, taskId));

test("every API code-quality graph task has an explicit budget entry", async () => {
  const configuration = v.parse(
    v.object({ tasks: v.record(v.string(), turboTaskSchema) }),
    Bun.JSONC.parse(
      await readFile(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
  );
  const root = path.resolve(import.meta.dirname, "..");
  const manifestSchema = v.object({
    name: v.string(),
    scripts: v.optional(v.record(v.string(), v.string()), {}),
    dependencies: v.optional(v.record(v.string(), v.string()), {}),
    devDependencies: v.optional(v.record(v.string(), v.string()), {}),
    optionalDependencies: v.optional(v.record(v.string(), v.string()), {}),
  });
  const manifests = await Promise.all(
    [...new Bun.Glob("{apps,packages}/*/package.json").scanSync(root)].map(
      async (file) => ({
        directory: path.dirname(file),
        ...v.parse(
          manifestSchema,
          JSON.parse(await readFile(path.join(root, file), "utf-8")),
        ),
      }),
    ),
  );
  const names = new Set(manifests.map(({ name }) => name));
  const packages = new Map(
    manifests.map(
      ({
        name,
        scripts,
        dependencies,
        devDependencies,
        optionalDependencies,
      }) =>
        [
          name,
          {
            scripts,
            dependencies: Object.keys({
              ...dependencies,
              ...devDependencies,
              ...optionalDependencies,
            }).filter((dependency) => names.has(dependency)),
          },
        ] as const,
    ),
  );
  const workspaces = new Set(manifests.map(({ directory }) => directory));
  const changedPaths = ["package.json"];
  const plan = planCheck({
    changedPaths,
    presentChangedPaths: changedPaths,
    repositoryPaths: changedPaths,
    affectedWorkspacePaths: [...workspaces],
    workspacePaths: workspaces,
    pluginModulePaths: new Set(),
  });
  if (plan.type !== "scoped") {
    throw new Error("Expected API code-quality entry-point plan");
  }
  const owners = manifests.filter(({ directory }) =>
    ownsCodeCheckPath(`${directory}/package.json`, "api"),
  );
  const entryPoints = scopedCommands(plan, { leg: "api", workspaces }).flatMap(
    (command) => {
      if (command[2] !== "turbo" || command[3] !== "run") {
        return [];
      }
      const option = command.findIndex(
        (value, index) => index >= 4 && value.startsWith("--"),
      );
      return command
        .slice(4, option === -1 ? undefined : option)
        .flatMap((entryPoint) =>
          entryPoint.includes("#")
            ? [entryPoint]
            : owners.map(({ name }) => `${name}#${entryPoint}`),
        );
    },
  );
  const graph = { tasks: configuration.tasks, entryPoints, packages };
  const tasks = apiQualityTasks(graph);
  expect(tasks.length).toBeGreaterThan(0);
  expect(missingApiTaskBudgets(tasks, DEFAULT_TASK_BUDGETS.overrides)).toEqual(
    [],
  );
  for (const taskId of tasks) {
    const withoutEntry = Object.fromEntries(
      Object.entries(DEFAULT_TASK_BUDGETS.overrides).filter(
        ([id]) => id !== taskId,
      ),
    );
    expect(missingApiTaskBudgets(tasks, withoutEntry)).toEqual([taskId]);
  }
  for (const name of [
    "typecheck:new-project",
    "generate:new-inputs",
    "new-task",
  ]) {
    const taskId = `@stll/api#${name}`;
    const mutation = {
      ...graph,
      packages: new Map([
        ...packages,
        [
          "@stll/api",
          {
            scripts: {
              ...packages.get("@stll/api")?.scripts,
              [name]: "echo new-check",
            },
            dependencies: packages.get("@stll/api")?.dependencies ?? [],
          },
        ],
      ]),
      tasks: {
        ...configuration.tasks,
        [taskId]: { dependsOn: [] },
        "@stll/api#typecheck": {
          dependsOn: [
            ...(configuration.tasks["@stll/api#typecheck"]?.dependsOn ?? []),
            name,
          ],
        },
      },
    };
    expect(
      missingApiTaskBudgets(
        apiQualityTasks(mutation),
        DEFAULT_TASK_BUDGETS.overrides,
      ),
    ).toEqual([taskId]);
  }
  expect(
    apiQualityTasks({
      ...graph,
      tasks: {
        ...configuration.tasks,
        "@stll/api#build": { dependsOn: ["new-task"] },
      },
    }),
  ).toEqual(tasks);
});

test("unmeasured existing API tasks preserve their previous default budget", () => {
  const retained = configuredBudgets.retainedApiTaskDefaults;
  expect(new Set(retained).size).toBe(retained.length);
  for (const taskId of retained) {
    expect(DEFAULT_TASK_BUDGETS.overrides[taskId]).toBe(
      DEFAULT_TASK_BUDGETS.defaultSeconds,
    );
    expect(Object.hasOwn(configuredBudgets.coldSamplesSeconds, taskId)).toBe(
      false,
    );
  }
});

test("cached replay and unexecuted dependencies never consume task execution budgets", () => {
  const parsed = parseTurboRunSummary(
    summary(
      task("@stll/web#lint", 999_999, "HIT"),
      { taskId: "@stll/api#lint", cache: { status: "MISS" } },
      task("@stll/errors#lint", 1000, "MISS", 1),
    ),
  );
  const report = evaluateTaskBudgets({ summary: parsed });
  expect(report.violations).toEqual([]);
  expect(report.rows).toMatchObject([
    { taskId: "@stll/api#lint", status: "not executed" },
    { taskId: "@stll/errors#lint", seconds: 1, status: "completed" },
    { taskId: "@stll/web#lint", status: "cache hit" },
  ]);
});

test("invalid schema, cache classifications and execution intervals fail rather than suppress budgets", () => {
  for (const value of [
    {},
    { version: "2", tasks: [] },
    summary({ taskId: "@stll/web#lint", cache: { status: "UNKNOWN" } }),
    summary(task("@stll/web#lint", -1)),
    summary({
      ...task("@stll/web#lint", 1),
      execution: { startTime: 0, endTime: Infinity, exitCode: 0 },
    }),
    summary({
      ...task("@stll/web#lint", 1),
      execution: { startTime: 0, endTime: 1000 },
    }),
    summary(task("@stll/web#lint", 1), task("@stll/web#lint", 2)),
  ]) {
    expect(() => parseTurboRunSummary(value)).toThrow(TaskBudgetInputError);
  }
  for (const value of [
    { defaultSeconds: 0, overrides: {} },
    { defaultSeconds: 90, overrides: { lint: 240 } },
    { defaultSeconds: 90, overrides: {}, ignoreCacheMisses: true },
  ]) {
    expect(() => parseTaskBudgets(value)).toThrow(TaskBudgetInputError);
  }
});

test("streamed miss headers retain starts until summary confirms completion, including split ANSI output", () => {
  let now = 1000;
  const tracker = createTaskExecutionTracker({ now: () => now });
  tracker.observe("\u001b[32m@stll/web:li", "stdout");
  tracker.observe("@stll/api:typecheck: cache miss, executing aaa\n", "stderr");
  tracker.observe("nt: cache miss, executing bbb\u001b[0m\n", "stdout");
  tracker.observe(
    "@stll/cli:generate:api: cache bypass, force executing ccc\n",
  );
  tracker.observe("@stll/cache:lint: cache hit, replaying logs ddd\n");
  tracker.observe("@stll/web:lint: all checks passed\n");
  now = 4000;
  expect(tracker.unfinished().map(({ taskId }) => taskId)).toEqual([
    "@stll/api#typecheck",
    "@stll/web#lint",
    "@stll/cli#generate:api",
  ]);
  tracker.confirm(
    parseTurboRunSummary(
      summary(
        task("@stll/web#lint", 1000),
        task("@stll/api#typecheck", 2000, "MISS", null),
      ),
    ),
  );
  expect(tracker.unfinished()).toEqual([
    { taskId: "@stll/api#typecheck", elapsedSeconds: 3 },
    { taskId: "@stll/cli#generate:api", elapsedSeconds: 3 },
  ]);
  expect(tracker.diagnostics("SIGTERM")).toContain(
    "started without confirmed completion",
  );
});

const scratch = async () =>
  await mkdtemp(path.join(tmpdir(), "code-quality-budget-"));

test("slow task progress warns once beyond its budget and finishing stops the watchdog", () => {
  let now = 0;
  const events: string[] = [];
  const watchdog = createTaskProgressWatchdog({
    budgetMs: 90,
    stallMs: 120,
    now: () => now,
    warn: () => {
      events.push("warning");
    },
    kill: () => {
      events.push("stall");
    },
  });
  for (now = 50; now <= 500; now += 50) {
    watchdog.progress();
    watchdog.tick();
  }
  watchdog.finish();
  now = 1000;
  watchdog.tick();
  expect(events).toEqual(["warning"]);
  expect(watchdog.wasStalled()).toBe(false);
});

test("silent task hangs warn then kill exactly once at the stall threshold", () => {
  let now = 0;
  const events: string[] = [];
  const watchdog = createTaskProgressWatchdog({
    budgetMs: 90,
    stallMs: 120,
    now: () => now,
    warn: () => {
      events.push("warning");
    },
    kill: () => {
      events.push("stall");
    },
  });
  now = 90;
  watchdog.tick();
  now = 119;
  watchdog.tick();
  expect(events).toEqual(["warning"]);
  now = 120;
  watchdog.tick();
  now = 500;
  watchdog.tick();
  watchdog.finish();
  expect(events).toEqual(["warning", "stall"]);
  expect(watchdog.wasStalled()).toBe(true);
});

test("continuous progress cannot outlast the deadline, which fires exactly once", () => {
  let now = 0;
  const events: string[] = [];
  const deadlined = createTaskProgressWatchdog({
    budgetMs: 90,
    stallMs: 120,
    now: () => now,
    warn: () => {
      events.push("warning");
    },
    kill: () => {
      events.push("stall");
    },
    deadline: {
      ms: 180,
      overrun: () => {
        events.push("overrun");
      },
    },
  });
  // A spinning leftover: CPU time advances on every probe, so it never stalls.
  for (now = 50; now <= 175; now += 25) {
    deadlined.progress();
    deadlined.tick();
  }
  expect(events).toEqual(["warning"]);
  for (now = 180; now <= 400; now += 20) {
    deadlined.progress();
    deadlined.tick();
  }
  expect(events).toEqual(["warning", "overrun"]);
  expect(deadlined.wasStalled()).toBe(true);

  // Without a deadline the same progress runs on (diagnostics have none).
  const unbounded: string[] = [];
  const open = createTaskProgressWatchdog({
    budgetMs: 90,
    stallMs: 120,
    now: () => now,
    warn: () => {
      unbounded.push("warning");
    },
    kill: () => {
      unbounded.push("stall");
    },
  });
  for (now = 400; now <= 2000; now += 50) {
    open.progress();
    open.tick();
  }
  expect(unbounded).toEqual(["warning"]);
});

test.each([0, 7])(
  "progressing tasks preserve exit %i after their warning budget",
  async (exitCode) => {
    const cwd = await scratch();
    try {
      const check = run(
        [
          process.execPath,
          "-e",
          `const timer = setInterval(() => console.log('progress'), 10); setTimeout(() => { clearInterval(timer); process.exit(${exitCode}); }, 4000);`,
        ],
        cwd,
        // A second past the 3 s warning budget; output every 10 ms keeps the
        // 2 s stall window from firing, which is half the run.
        3000,
        2000,
      );
      const result = await check.result;
      expect(result.exitCode, result.output).toBe(exitCode);
      expect(result.outcome).toBe("completed");
      expect(result.output).toContain("::warning title=task-budget::");
      expect(result.output).not.toContain("class=task-stall");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "a quiet compiler with advancing CPU time survives beyond the stall window",
  async () => {
    const cwd = await scratch();
    const stdout: string[] = [];
    try {
      const result = await runBudgetedCheck({
        command: [
          process.execPath,
          "-e",
          `const fs = require("node:fs"); const end = Date.now() + 6000; while (Date.now() < end) {} const cpu = process.cpuUsage(); fs.writeFileSync("cpu-ms", String((cpu.user + cpu.system) / 1000));`,
        ],
        cwd,
        // The 6 s compile outlasts both the 5 s warning budget and the stall
        // window; only advancing CPU time keeps it alive.
        timeoutMs: 5000,
        stallMs: 4000,
        graceMs: 200,
        deadline: "none",
        summary: "none",
        writeStdout: (text) => {
          stdout.push(text);
        },
        writeStderr: () => {},
        writeSummary: () => {},
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.outcome).toBe("completed");
      expect(stdout.join("")).toBe("");
      expect(result.output).toContain("::warning title=task-budget::");
      expect(result.output).not.toContain("class=task-stall");
      expect(result.output).not.toContain("task-progress-probe");
      expect(
        Number(await readFile(path.join(cwd, "cpu-ms"), "utf-8")),
      ).toBeGreaterThan(1000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "a silent process spinning past twice its budget fails closed",
  async () => {
    const cwd = await scratch();
    try {
      const started = Date.now();
      const result = await runBudgetedCheck({
        command: [process.execPath, "-e", "while (true) {}"],
        cwd,
        timeoutMs: 500,
        stallMs: 10_000,
        graceMs: 200,
        summary: "none",
        writeStdout: () => {},
        writeStderr: () => {},
        writeSummary: () => {},
      });
      expect(result.exitCode, result.output).toBe(124);
      expect(result.outcome).toBe("stalled");
      expect(result.output).toContain("class=task-overrun");
      expect(result.output).not.toContain("class=task-stall");
      // Killed at the deadline, well before the stall window could end it.
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "the deadline applies by default and only an explicit opt-out removes it",
  async () => {
    const cwd = await scratch();
    try {
      const check = async (deadline: "twice-budget" | "none" | undefined) =>
        runBudgetedCheck({
          // Spins well past twice the 200 ms budget, then exits cleanly.
          command: [
            process.execPath,
            "-e",
            "const end = Date.now() + 1500; while (Date.now() < end) {}",
          ],
          cwd,
          timeoutMs: 200,
          stallMs: 10_000,
          graceMs: 200,
          ...(deadline === undefined ? {} : { deadline }),
          summary: "none",
          writeStdout: () => {},
          writeStderr: () => {},
          writeSummary: () => {},
        });
      for (const deadline of [undefined, "twice-budget"] as const) {
        const result = await check(deadline);
        expect(result.outcome, result.output).toBe("stalled");
        expect(result.output).toContain("class=task-overrun");
      }
      const exempt = await check("none");
      expect(exempt.exitCode, exempt.output).toBe(0);
      expect(exempt.outcome).toBe("completed");
      expect(exempt.output).not.toContain("class=task-overrun");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  15_000,
);

const run = (
  command: string[],
  cwd: string,
  timeoutMs = 5000,
  stallMs = timeoutMs,
) => {
  const markdown: string[] = [];
  const stderr: string[] = [];
  return {
    markdown,
    stderr,
    result: runBudgetedCheck({
      command,
      cwd,
      timeoutMs,
      stallMs,
      graceMs: 200,
      deadline: "none",
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr.push(text);
      },
      writeSummary: (text) => {
        markdown.push(text);
      },
    }),
  };
};

test("fresh Turbo summaries are enforced and stale or missing summaries cannot validate success", async () => {
  const cwd = await scratch();
  try {
    await mkdir(path.join(cwd, ".turbo/runs"), { recursive: true });
    await writeFile(
      path.join(cwd, ".turbo/runs/stale.json"),
      JSON.stringify(summary(task("@stll/web#lint", 1))),
    );
    const source = (seconds: number) =>
      `const fs=require('fs'); const report=${JSON.stringify(summary(task("@stll/web#lint", seconds * 1000)))}; report.execution={startTime:Date.now(),endTime:Date.now(),exitCode:0}; fs.writeFileSync('.turbo/runs/new.json',JSON.stringify(report)); console.log('Summary: '+require('path').resolve('.turbo/runs/new.json'));`;
    const file = path.join(cwd, "turbo");
    await writeFile(file, source(240));
    const positive = run([process.execPath, file], cwd);
    expect((await positive.result).exitCode).toBe(0);
    expect(positive.markdown.join("\n")).toContain("@stll/web#lint");
    await rm(path.join(cwd, ".turbo/runs/new.json"));
    await writeFile(file, source(241));
    const mutation = await run([process.execPath, file], cwd).result;
    expect(mutation.exitCode).toBe(0);
    expect(mutation.output).toContain("::warning title=task-budget::");
    expect(mutation.output).toContain("241.000s exceeds 240s");
    await writeFile(file, "process.exit(0)");
    const missing = await run([process.execPath, file], cwd).result;
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain("Expected one fresh Turbo summary");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("progress stall kills a real command group and reports unconfirmed streamed starts", async () => {
  const cwd = await scratch();
  try {
    const grandchild =
      "const fs=require('fs'); process.on('SIGTERM',()=>fs.writeFileSync('group-signal','received')); process.stdout.write('ready'); setInterval(()=>{},1000)";
    const child = run(
      [
        process.execPath,
        "-e",
        `
      const {spawn}=require('child_process');
      const nested=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});
      nested.stdout.once('data',()=>{ process.stdout.write('@stll/web:li'); setTimeout(()=>process.stdout.write('nt: cache miss, executing abc\\n'),10); });
      process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
    `,
      ],
      cwd,
      1000,
    );
    const result = await child.result;
    expect(result.exitCode).toBe(124);
    expect(result.outcome).toBe("stalled");
    expect(result.output).toContain("class=task-stall");
    expect(result.output).not.toContain("Cannot terminate command group");
    expect(result.output).toContain(
      "@stll/web#lint: started without confirmed completion",
    );
    expect(await Bun.file(path.join(cwd, "group-signal")).text()).toBe(
      "received",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a delegated fallback cannot orphan a TERM-resistant descendant after the outer stall", async () => {
  const cwd = await scratch();
  const pidFile = Bun.file(path.join(cwd, "delegated-descendant-pid"));
  try {
    const module = path.join(
      import.meta.dirname,
      "code-quality-task-budget.ts",
    );
    const descendant = [
      "const fs = require('fs');",
      "fs.writeFileSync('delegated-descendant-pid', String(process.pid));",
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('delegated descendant ready\\n');",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ scripts: { "code-check": "bun delegated.ts" } }),
    );
    await writeFile(
      path.join(cwd, "delegated.ts"),
      `
        import { runBudgetedCheck } from ${JSON.stringify(module)};
        const result = await runBudgetedCheck({
          command: [process.execPath, '-e', ${JSON.stringify(descendant)}],
          cwd: ${JSON.stringify(cwd)}, timeoutMs: 5000, graceMs: 200, deadline: "none",
          writeStdout: text => process.stdout.write(text),
          writeStderr: text => process.stderr.write(text), writeSummary: () => {},
        });
        process.exit(result.exitCode);
      `,
    );
    const result = await run([process.execPath, "run", "code-check"], cwd, 1000)
      .result;
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("delegated descendant ready");
    expect(result.output).toContain("class=task-stall");
    const pid = Number(await pidFile.text());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    const state = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], {
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  } finally {
    if (await pidFile.exists()) {
      const pid = Number(await pidFile.text());
      if (Number.isSafeInteger(pid) && pid > 0) {
        const cleanup = Result.try({
          try: () => process.kill(pid, "SIGKILL"),
          catch: (cause) => cause,
        });
        if (cleanup.isErr()) {
          expect(cleanup.error).toMatchObject({ code: "ESRCH" });
        }
      }
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("external SIGTERM reports started tasks and terminates the supervised command", async () => {
  const cwd = await scratch();
  try {
    const module = path.join(
      import.meta.dirname,
      "code-quality-task-budget.ts",
    );
    const childScript =
      "process.stdout.write('@stll/api:typecheck: cache miss, executing abc\\n'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
    const runner = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
      import { runBudgetedCheck } from ${JSON.stringify(module)};
      const result = await runBudgetedCheck({
        command: [process.execPath, '-e', ${JSON.stringify(childScript)}],
        cwd: ${JSON.stringify(cwd)}, timeoutMs: 3000, graceMs: 200, deadline: "none",
        writeStdout: text => process.stdout.write(text),
        writeStderr: text => process.stdout.write(text), writeSummary: () => {},
      });
      process.exit(result.exitCode);
    `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let output = "";
    let interrupted = false;
    for await (const chunk of runner.stdout) {
      output += new TextDecoder().decode(chunk);
      if (
        !interrupted &&
        output
          .split(/\r?\n/u)
          .includes("@stll/api:typecheck: cache miss, executing abc")
      ) {
        interrupted = true;
        runner.kill("SIGTERM");
      }
    }
    expect(interrupted).toBe(true);
    expect(await runner.exited).toBe(124);
    expect(output).toContain("interrupted by SIGTERM");
    expect(output).toContain(
      "@stll/api#typecheck: started without confirmed completion",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("interruption reconciles a fresh summary before reporting unconfirmed task durations", async () => {
  const cwd = await scratch();
  try {
    await mkdir(path.join(cwd, ".turbo/runs"), { recursive: true });
    const file = path.join(cwd, "turbo");
    const completed = summary(
      task("@stll/web#lint", 1000),
      task("@stll/api#typecheck", 1000, "MISS", null),
    );
    await writeFile(
      file,
      `
      const fs=require('fs');
      process.stdout.write('@stll/web:lint: cache miss, executing aaa\\n@stll/api:typecheck: cache miss, executing bbb\\n');
      const started=Date.now();
      process.on('SIGTERM',()=>{ const report=${JSON.stringify(completed)};report.execution={startTime:started,endTime:Date.now(),exitCode:0};fs.writeFileSync('.turbo/runs/interrupted.json',JSON.stringify(report));console.log('Summary: '+require('path').resolve('.turbo/runs/interrupted.json'));process.exit(0)});
      setInterval(()=>{},1000);
    `,
    );
    const check = run([process.execPath, file], cwd, 1000);
    const result = await check.result;
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain(
      "@stll/api#typecheck: started without confirmed completion",
    );
    expect(result.output).not.toContain(
      "@stll/web#lint: started without confirmed completion",
    );
    expect(check.markdown.at(0)).toContain("Code-quality task durations");
    expect(check.markdown.at(1)).toContain("@stll/api#typecheck");
    expect(check.markdown.at(1)).not.toContain("@stll/web#lint");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("only a missing summary directory permits starting the command; other filesystem errors fail", async () => {
  const cwd = await scratch();
  try {
    const started = await run(
      [process.execPath, "-e", "process.stdout.write('started')"],
      cwd,
    ).result;
    expect(started.exitCode).toBe(0);
    expect(started.output).toStartWith("started");
    expect(started.output).toContain("Code-quality timing:");
    expect(started.output).not.toContain("::error");
    await mkdir(path.join(cwd, ".turbo"));
    await writeFile(path.join(cwd, ".turbo/runs"), "not a directory");
    expect(
      await rejectionOf(
        run(
          [process.execPath, "-e", "process.stdout.write('must not start')"],
          cwd,
        ).result,
      ),
    ).toBeInstanceOf(TaskBudgetInputError);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("leader exit lets a short-lived descendant finish without a cleanup diagnostic", async () => {
  const cwd = await scratch();
  try {
    const descendant =
      "process.stdout.write('ready'); setTimeout(()=>process.exit(0),200)";
    const leader = `
      const {spawn}=require('child_process');
      const nested=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});
      nested.stdout.once('data',()=>process.exit(0));
    `;
    const result = await runBudgetedCheck({
      command: [process.execPath, "-e", leader],
      cwd,
      timeoutMs: 5000,
      graceMs: 500,
      deadline: "none",
      writeStdout: () => {},
      writeStderr: () => {},
      writeSummary: () => {},
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.outcome).toBe("completed");
    expect(result.output).toContain("Code-quality timing:");
    expect(result.output).toContain("exit=0");
    expect(result.output).not.toContain("::error");
    expect(result.output).not.toContain(
      "Owned process remained after leader exit",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("successful leader exit cleans its inherited-pipe descendants without waiting for a stall", async () => {
  const cwd = await scratch();
  try {
    const descendant =
      "const fs=require('fs'); fs.writeFileSync('descendant-pid', String(process.pid)); process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)";
    const leader = `
      const {spawn}=require('child_process');
      const nested=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});
      nested.stdout.once('data',()=>{
        process.stdout.write('leader exiting\\n');
        const inherited=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit']});
        require('fs').writeFileSync('inherited-pid',String(inherited.pid));
        process.exit(0);
      });
    `;
    const start = Date.now();
    const result = await run([process.execPath, "-e", leader], cwd, 5000)
      .result;
    expect(result.exitCode).toBe(0);
    expect(Date.now() - start).toBeLessThan(4000);
    const pid = Number(await Bun.file(path.join(cwd, "inherited-pid")).text());
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(result.output).toContain(
      `Notice: Terminating owned process after leader exit: pid=${pid}`,
    );
    expect(result.output).toContain("command=");
    expect(result.output).not.toContain("class=task-stall");
    const state = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="], {
      stdout: "pipe",
      stderr: "pipe",
    })
      .stdout.toString()
      .trim();
    // An adopted zombie is no longer executing and has closed its inherited pipes.
    expect(state === "" || state.startsWith("Z")).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a progress stall interrupts a longer group drain window", async () => {
  const cwd = await scratch();
  try {
    const completion = path.join(cwd, "descendant-completion");
    // Kernel sleep keeps this quiescence fixture independent of JS runtime CPU work.
    const descendant = `trap 'printf interrupted > "$1"; exit 0' TERM; printf ready; sleep 5; printf completed > "$1"`;
    const leader = `
      const {spawn}=require('child_process');
      const nested=spawn('/bin/sh',['-c',${JSON.stringify(descendant)},'descendant',${JSON.stringify(completion)}],{stdio:['ignore','pipe','inherit']});
      nested.stdout.once('data',()=>process.exit(0));
    `;
    const result = await runBudgetedCheck({
      command: [process.execPath, "-e", leader],
      cwd,
      timeoutMs: 1000,
      stallMs: 1000,
      graceMs: 2000,
      deadline: "none",
      writeStdout: () => {},
      writeStderr: () => {},
      writeSummary: () => {},
    });
    expect(result.exitCode).toBe(124);
    expect(result.outcome).toBe("stalled");
    expect(result.output).toContain("class=task-stall");
    expect(await Bun.file(completion).text()).toBe("interrupted");
    expect(result.output).not.toContain(
      "Notice: Terminating owned process after leader exit:",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an empty group skips the drain window", async () => {
  const cwd = await scratch();
  try {
    const started = Date.now();
    const result = await runBudgetedCheck({
      command: [process.execPath, "-e", "process.exit(0)"],
      cwd,
      timeoutMs: 5000,
      graceMs: 3000,
      deadline: "none",
      writeStdout: () => {},
      writeStderr: () => {},
      writeSummary: () => {},
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(result.outcome).toBe("completed");
    expect(result.output).toContain("Code-quality timing:");
    expect(result.output).toContain("exit=0");
    expect(result.output).not.toContain("::error");
    expect(result.output).not.toContain(
      "Owned process remained after leader exit",
    );
    expect(Date.now() - started).toBeLessThan(2000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("owned group inspection errors fail closed", async () => {
  const cwd = await scratch();
  try {
    await writeFile(path.join(cwd, "ps"), "#!/bin/sh\nexit 7\n", {
      mode: 0o755,
    });
    const module = path.join(
      import.meta.dirname,
      "code-quality-task-budget.ts",
    );
    const runner = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { runBudgetedCheck } from ${JSON.stringify(module)};
        const result = await runBudgetedCheck({
          command: [process.execPath, '-e', 'process.exit(0)'],
          cwd: ${JSON.stringify(cwd)}, timeoutMs: 5000, graceMs: 200, deadline: "none",
          writeStdout: () => {}, writeStderr: text => process.stdout.write(text),
          writeSummary: () => {},
        });
        process.exit(result.exitCode);
      `,
      ],
      { env: { ...process.env, PATH: cwd }, stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(runner.stdout).text();
    expect(await runner.exited, output).toBe(1);
    expect(output).toContain("Cannot inspect owned process group");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("termination diagnostics retain tree ancestry, group members and process states without unrelated processes", () => {
  expect(
    ownedProcessTreeRows(
      "100 1 100 S leader\n101 100 100 R turbo\n102 101 102 S worker\n103 1 100 Z exited\n104 999 999 S unrelated\n",
      100,
    ),
  ).toEqual([
    "100 1 100 S leader",
    "101 100 100 R turbo",
    "102 101 102 S worker",
    "103 1 100 Z exited",
  ]);
});

test("a runnable owned process is progress between CPU clock ticks", () => {
  const runnable = "100 1 100 R 00:00:01 compiler\n";
  const waiting = "100 1 100 S 00:00:01 compiler\n";
  expect(processCpuSnapshot(runnable, 100)).toEqual({
    activity: "runnable",
    cpu: "100:00:00:01",
  });
  expect(processCpuSnapshot(waiting, 100)).toEqual({
    activity: "waiting",
    cpu: "100:00:00:01",
  });
});

test("owned process audits retain live descendants and ignore unrelated groups or exited zombies", () => {
  const snapshot =
    "  100 100 S leader\n101 100 S    child --watch \n102 100 Z+ zombie\n103 999 S unrelated\n104 100 S \n";
  expect(ownedProcessGroupMembers(snapshot, 100)).toEqual([
    { pid: "101", command: "child --watch " },
  ]);
  const mutation = snapshot.replace("102 100 Z+", "102 100 S+");
  expect(mutation).not.toBe(snapshot);
  expect(ownedProcessGroupMembers(mutation, 100)).toEqual([
    { pid: "101", command: "child --watch " },
    { pid: "102", command: "zombie" },
  ]);
});

test("unannounced or out-of-interval concurrent summaries cannot validate the supervised command", async () => {
  const cwd = await scratch();
  try {
    await mkdir(path.join(cwd, ".turbo/runs"), { recursive: true });
    const file = path.join(cwd, "turbo");
    for (const [name, announce, currentInterval] of [
      ["unrelated", false, true],
      ["old-interval", true, false],
    ] as const) {
      const report = summary(task("@stll/web#lint", 1));
      await writeFile(
        file,
        `
        const fs=require('fs'); const report=${JSON.stringify(report)};
        if (${String(currentInterval)}) report.execution={startTime:Date.now(),endTime:Date.now(),exitCode:0};
        fs.writeFileSync('.turbo/runs/${name}.json', JSON.stringify(report));
        if (${String(announce)}) console.log('Summary: '+require('path').resolve('.turbo/runs/${name}.json'));
      `,
      );
      const result = await run([process.execPath, file], cwd).result;
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(
        announce
          ? "execution interval does not belong"
          : "announced by this command",
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("summary announcement and filename must occupy the same output line", async () => {
  const cwd = await scratch();
  try {
    await mkdir(path.join(cwd, ".turbo/runs"), { recursive: true });
    const file = path.join(cwd, "turbo");
    await writeFile(
      file,
      `const fs=require('fs'); const report=${JSON.stringify(summary(task("@stll/web#lint", 1)))};
      report.execution={startTime:Date.now(),endTime:Date.now(),exitCode:0};
      fs.writeFileSync('.turbo/runs/separate-line.json',JSON.stringify(report));
      console.log('Summary:'); console.log(require('path').resolve('.turbo/runs/separate-line.json'));`,
    );
    const rejected = await run([process.execPath, file], cwd).result;
    expect(rejected.exitCode, rejected.output).toBe(1);
    expect(rejected.output).toContain("announced by this command, found 0");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("summary binding accepts canonical checkout aliases and rejects symlink escapes", async () => {
  const cwd = await scratch();
  try {
    await mkdir(path.join(cwd, ".turbo/runs"), { recursive: true });
    const alias = path.join(cwd, "checkout-alias");
    await symlink(cwd, alias, "dir");
    const file = path.join(cwd, "turbo");
    const report = summary(task("@stll/web#lint", 1));
    await writeFile(
      file,
      `const fs=require('fs'); const report=${JSON.stringify(report)};
      report.execution={startTime:Date.now(),endTime:Date.now(),exitCode:0};
      fs.writeFileSync('.turbo/runs/alias.json',JSON.stringify(report));
      console.log('Summary: '+require('path').resolve('.turbo/runs/alias.json'));`,
    );
    const accepted = await run([process.execPath, file], alias).result;
    expect(accepted.exitCode, accepted.output).toBe(0);
    await writeFile(
      file,
      `const fs=require('fs'); const path=require('path'); const report=${JSON.stringify(report)};
      report.execution={startTime:Date.now(),endTime:Date.now(),exitCode:0};
      fs.writeFileSync('outside.json',JSON.stringify(report));
      fs.symlinkSync(path.resolve('outside.json'),'.turbo/runs/escape.json');
      console.log('Summary: '+path.resolve('.turbo/runs/escape.json'));`,
    );
    const rejected = await run([process.execPath, file], alias).result;
    expect(rejected.exitCode, rejected.output).toBe(1);
    expect(rejected.output).toContain("announced by this command, found 0");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the repository-pinned Turbo produces compatible MISS and HIT summaries for a real workspace", async () => {
  const cwd = await scratch();
  try {
    // Default task inputs otherwise include Turbo's own newly written task log.
    await writeFile(path.join(cwd, ".gitignore"), ".turbo/\n");
    await mkdir(path.join(cwd, "workspaces/a"), { recursive: true });
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "budget-smoke",
        private: true,
        packageManager: "bun@1.4.3",
        workspaces: ["workspaces/*"],
      }),
    );
    await writeFile(
      path.join(cwd, "workspaces/a/package.json"),
      JSON.stringify({
        name: "@stll/budget-smoke",
        version: "0.0.0",
        scripts: {
          lint: "echo lint-complete",
          typecheck: "echo typecheck-complete",
        },
      }),
    );
    await writeFile(
      path.join(cwd, "bun.lock"),
      JSON.stringify({
        lockfileVersion: 3,
        configVersion: 1,
        workspaces: {
          "": { name: "budget-smoke" },
          "workspaces/a": { name: "@stll/budget-smoke", version: "0.0.0" },
        },
        packages: {},
      }),
    );
    await writeFile(
      path.join(cwd, "turbo.json"),
      JSON.stringify({
        tasks: { lint: { outputs: [] }, typecheck: { outputs: [] } },
      }),
    );
    const turbo = path.resolve(
      import.meta.dirname,
      "../node_modules/.bin/turbo",
    );
    const command = [
      turbo,
      "run",
      "lint",
      "--summarize",
      "--log-order=stream",
      "--log-prefix=task",
      "--cache=local:rw",
      "--cache-dir",
      path.join(cwd, "cache"),
      "--remote-cache-timeout=20",
    ];
    const miss = run(command, cwd);
    const missResult = await miss.result;
    expect(missResult.exitCode, missResult.output).toBe(0);
    expect(missResult.output).toContain("lint-complete");
    expect(miss.markdown.join("\n")).toContain(
      "| @stll/budget-smoke#lint | MISS |",
    );
    const hit = run(command, cwd);
    const hitResult = await hit.result;
    expect(hitResult.exitCode, hitResult.output).toBe(0);
    expect(hit.markdown.join("\n"), hitResult.output).toContain(
      "| @stll/budget-smoke#lint | HIT |",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
