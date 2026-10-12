import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  createTaskExecutionTracker,
  DEFAULT_TASK_BUDGETS,
  evaluateTaskBudgets,
  ownedProcessGroupMembers,
  ownedProcessTreeRows,
  parseTaskBudgets,
  parseTurboRunSummary,
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
  expect(DEFAULT_TASK_BUDGETS).toEqual({
    defaultSeconds: 90,
    overrides: {
      "@stll/api#lint": 390,
      "@stll/api#typecheck": 330,
      "@stll/web#lint": 240,
    },
  });
  for (const [taskId, budget] of [
    ["@stll/web#lint", 240],
    ["@stll/api#lint", 390],
    ["@stll/api#typecheck", 330],
    ["//#typecheck:repo", 90],
  ] as const) {
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
    Object.keys(DEFAULT_TASK_BUDGETS.overrides).toSorted(),
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
      task("@stll/api#lint", 178_600),
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
const run = (command: string[], cwd: string, timeoutMs = 5000) => {
  const markdown: string[] = [];
  const stderr: string[] = [];
  return {
    markdown,
    stderr,
    result: runBudgetedCheck({
      command,
      cwd,
      timeoutMs,
      graceMs: 200,
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
    expect(mutation.exitCode).toBe(1);
    expect(mutation.output).toContain("241.000s exceeds 240s");
    await writeFile(file, "process.exit(0)");
    const missing = await run([process.execPath, file], cwd).result;
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain("Expected one fresh Turbo summary");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("execution deadline kills a real command group and reports unconfirmed streamed starts", async () => {
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
    expect(result.output).toContain("execution deadline exceeded");
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

test("a delegated fallback cannot orphan a TERM-resistant descendant after the outer deadline", async () => {
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
          cwd: ${JSON.stringify(cwd)}, timeoutMs: 5000, graceMs: 200,
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
    expect(result.output).toContain("execution deadline exceeded");
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
        cwd: ${JSON.stringify(cwd)}, timeoutMs: 3000, graceMs: 200,
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
    expect(started.output).toBe("started");
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

test("leader exit audits and terminates an inherited-pipe descendant without waiting for the deadline", async () => {
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
    expect(result.exitCode).toBe(1);
    expect(Date.now() - start).toBeLessThan(4000);
    const pid = Number(await Bun.file(path.join(cwd, "inherited-pid")).text());
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(result.output).toContain(
      `Owned process remained after leader exit: pid=${pid}`,
    );
    expect(result.output).toContain("command=");
    expect(result.output).not.toContain("execution deadline exceeded");
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
