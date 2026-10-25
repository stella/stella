import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForExternalState } from "@stll/property-testing/external-state";

import { buildApiTestCommand } from "./api-test-command";
import {
  testProcessBudgets,
  TestProcessSupervisor,
} from "./test-process-supervisor";

const createFixture = (
  options: Partial<ConstructorParameters<typeof TestProcessSupervisor>[0]> = {},
) => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-test-supervisor-"));
  const progress: string[] = [];
  const diagnostics: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const started = Promise.withResolvers<undefined>();
  const supervisor = new TestProcessSupervisor({
    directory,
    onProgress: (text) => {
      progress.push(text);
      started.resolve(undefined);
    },
    onDiagnostic: (text) => {
      diagnostics.push(text);
    },
    onStdout: (text) => {
      stdout.push(text);
    },
    onStderr: (text) => {
      stderr.push(text);
    },
    childTimeoutMs: 2000,
    deadlineMs: 10_000,
    stopGraceMs: 150,
    ...options,
  });
  return {
    directory,
    progress,
    diagnostics,
    stdout,
    stderr,
    started: started.promise,
    supervisor,
    cleanup: () => {
      supervisor.kill();
      supervisor.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

const readLogs = (directory: string) =>
  readdirSync(directory)
    .filter((file) => file.endsWith(".log"))
    .map((file) => readFileSync(path.join(directory, file), "utf-8"))
    .join("");

for (const kind of ["batch", "snapshot"] as const) {
  test(`a hung ${kind} preserves progress and identity, fails once, and kills an uncooperative child`, async () => {
    const fixture = createFixture();
    const files =
      kind === "snapshot"
        ? ["scripts/build-pglite-snapshot.ts"]
        : ["src/tests/hung-first.test.ts", "src/tests/hung-second.test.ts"];
    const label = `hung-${kind}`;
    const child = `
        import { writeFileSync } from "node:fs";
        writeFileSync("child.pid", String(process.pid));
        process.on("SIGTERM", () => writeFileSync("term.received", "yes"));
        console.log("progress before hang");
        console.error("stderr before hang");
        setInterval(() => {}, 1000);
      `;
    try {
      const pending = fixture.supervisor.run({
        command: () => [process.execPath, "-e", child],
        cwd: fixture.directory,
        env: process.env,
        identity: { kind, label, files, lane: 3 },
        mode: "buffered",
      });
      // Reader initialization completes before startup, which remains visible before completion.
      await fixture.started;
      expect(fixture.progress.join("")).toContain(label);
      expect(fixture.progress.join("")).toMatch(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u,
      );
      expect(fixture.progress.join("")).toContain("lane 3");
      for (const file of files) {
        expect(fixture.progress.join("")).toContain(file);
      }
      const active = readFileSync(
        path.join(fixture.directory, "active.json"),
        "utf-8",
      );
      expect(active).toContain(label);
      for (const file of files) {
        expect(active).toContain(file);
      }

      const result = await pending;
      const pid = Number(
        readFileSync(path.join(fixture.directory, "child.pid"), "utf-8"),
      );
      expect(fixture.progress.join("")).toContain(`PID ${pid}`);
      expect(active).toContain(String(pid));
      expect(result.exitCode).toBe(124);
      expect(fixture.supervisor.signal.aborted).toBe(true);
      expect(fixture.diagnostics).toHaveLength(1);
      const diagnostic = fixture.diagnostics.join("");
      expect(diagnostic).toContain("exceeded 2000ms wall-clock budget");
      expect(diagnostic).toContain(kind);
      expect(diagnostic).toContain(label);
      expect(diagnostic).toContain(String(pid));
      expect(diagnostic).toContain("3");
      for (const file of files) {
        expect(diagnostic).toContain(file);
      }
      expect(diagnostic).toContain("progress before hang");
      expect(diagnostic).toContain("stderr before hang");
      expect(readLogs(fixture.directory)).toContain("progress before hang");
      expect(readLogs(fixture.directory)).toContain("stderr before hang");
      const readFailure = () =>
        readFileSync(path.join(fixture.directory, "failure.json"), "utf-8");
      const failure = readFailure();
      expect(failure).toContain(label);
      expect(failure).toContain(String(pid));
      for (const file of files) {
        expect(failure).toContain(file);
      }
      expect(existsSync(path.join(fixture.directory, "term.received"))).toBe(
        true,
      );
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
      fixture.supervisor.stop("second stop must not overwrite diagnostics");
      expect(fixture.diagnostics).toHaveLength(1);
      expect(readFailure()).toBe(failure);
    } finally {
      fixture.cleanup();
    }
  }, 10_000);
}

test("normal buffered children keep their output apart from startup progress", async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.supervisor.run({
      command: () => [
        process.execPath,
        "-e",
        'console.log("normal stdout"); console.log("second stdout line");',
      ],
      cwd: fixture.directory,
      env: process.env,
      identity: {
        kind: "batch",
        label: "normal-output",
        files: ["normal.test.ts"],
        lane: 0,
      },
      mode: "buffered",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("normal stdout\nsecond stdout line");
    expect(result.usage).toBeDefined();
    expect(fixture.progress).toHaveLength(1);
    expect(fixture.progress.join("")).toContain("normal-output");
    expect(fixture.stdout).toEqual([]);
    expect(fixture.stderr).toEqual([]);
    expect(fixture.diagnostics).toEqual([]);
    expect(fixture.supervisor.signal.aborted).toBe(false);
    const registry = JSON.parse(
      readFileSync(path.join(fixture.directory, "active.json"), "utf-8"),
    );
    expect(registry.failure).toBeNull();
    expect(registry.processes).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("completed child success survives active registry persistence failure", async () => {
  let temporaryRegistryPath = "";
  const fixture = createFixture({
    onStdout: () => {
      mkdirSync(temporaryRegistryPath, { recursive: true });
    },
  });
  temporaryRegistryPath = path.join(fixture.directory, "active.json.tmp");
  try {
    const result = await fixture.supervisor.run({
      command: () => [process.execPath, "-e", 'console.log("complete")'],
      cwd: fixture.directory,
      env: process.env,
      identity: {
        kind: "batch",
        label: "registry-write-failure",
        files: ["complete.test.ts"],
        lane: 0,
      },
      mode: "stream",
    });

    expect(result.exitCode).toBe(0);
    expect(fixture.supervisor.signal.aborted).toBe(false);
    expect(fixture.diagnostics.join(" ")).toContain(
      "Could not persist active process registry",
    );
  } finally {
    fixture.cleanup();
  }
});

// Bun hides passing test names when it detects an AI agent session, so the
// reporter-output assertion would depend on who runs the suite.
const reporterEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => key !== "CLAUDECODE" && key !== "AGENT",
  ),
);

test("real Bun test batches produce distinct JUnit artifacts and retain reporter output", async () => {
  const fixture = createFixture();
  const junitPaths: string[] = [];
  try {
    for (const label of ["first", "second"]) {
      const testFile = path.join(fixture.directory, `${label}.test.ts`);
      const testName = `${label} supervised assertion`;
      writeFileSync(
        testFile,
        `
        import { Result, panic } from "better-result";
import { expect, test } from "bun:test";
        test(${JSON.stringify(testName)}, () => {
          console.log("normal fixture stdout");
          expect(2 + 2).toBe(4);
        });
      `,
      );
      const result = await fixture.supervisor.run({
        command: (junitPath) => {
          junitPaths.push(junitPath);
          return buildApiTestCommand({
            bunExecutable: process.execPath,
            bunRuntimeArguments: [],
            testArguments: [
              "--reporter=junit",
              `--reporter-outfile=${junitPath}`,
            ],
            testFiles: [testFile],
          });
        },
        cwd: fixture.directory,
        env: reporterEnv,
        identity: { kind: "batch", label, files: [testFile], lane: 0 },
        mode: "buffered",
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("normal fixture stdout");
      expect(result.output).toContain(testName);
      expect(result.output).toContain("(pass)");
      expect(result.usage).toBeDefined();
      const junitPath = junitPaths.at(-1);
      expect(junitPath).toBeDefined();
      if (junitPath === undefined) {
        panic("Supervisor did not supply a JUnit path");
      }
      expect(readFileSync(junitPath, "utf-8")).toContain(`name="${testName}"`);
    }
    expect(new Set(junitPaths).size).toBe(2);
    for (const junitPath of junitPaths) {
      expect(path.dirname(junitPath)).toBe(fixture.directory);
      const xml = readFileSync(junitPath, "utf-8");
      expect(xml).toMatch(/<testsuites\b/u);
      expect(xml).toContain("</testsuites>");
      expect(xml).toMatch(/<testcase\b/u);
      expect(xml).toContain("supervised assertion");
    }
    expect(fixture.stdout).toEqual([]);
    expect(fixture.stderr).toEqual([]);
    expect(fixture.diagnostics).toEqual([]);
    expect(fixture.supervisor.signal.aborted).toBe(false);
    const registry = JSON.parse(
      readFileSync(path.join(fixture.directory, "active.json"), "utf-8"),
    );
    expect(registry.failure).toBeNull();
    expect(registry.processes).toEqual([]);
  } finally {
    fixture.cleanup();
  }
});

test("stream mode forwards both streams and still persists raw output", async () => {
  const fixture = createFixture();
  try {
    const result = await fixture.supervisor.run({
      command: () => [
        process.execPath,
        "-e",
        'console.log("live stdout"); console.error("live stderr");',
      ],
      cwd: fixture.directory,
      env: process.env,
      identity: {
        kind: "baseline",
        label: "live-baseline",
        files: [],
        lane: 0,
      },
      mode: "stream",
    });
    expect(result.exitCode).toBe(0);
    expect(fixture.stdout.join("")).toBe("live stdout\n");
    expect(fixture.stderr.join("")).toBe("live stderr\n");
    expect(readLogs(fixture.directory)).toContain("live stdout\n");
    expect(readLogs(fixture.directory)).toContain("live stderr\n");
  } finally {
    fixture.cleanup();
  }
});

test("one child watchdog aborts every active lane and preserves both identities", async () => {
  const fixture = createFixture();
  try {
    const pending = [4, 7].map(
      async (lane) =>
        await fixture.supervisor.run({
          command: () => [
            process.execPath,
            "-e",
            `
          import { writeFileSync } from "node:fs";
          writeFileSync("lane-${lane}.pid", String(process.pid));
          console.log("lane ${lane} progress");
          setInterval(() => {}, 1000);
        `,
          ],
          cwd: fixture.directory,
          env: process.env,
          identity: {
            kind: "batch",
            label: `hung-lane-${lane}`,
            files: [`lane-${lane}.test.ts`],
            lane,
          },
          mode: "buffered",
        }),
    );
    const results = await Promise.all(pending);
    expect(results.map(({ exitCode }) => exitCode)).toEqual([124, 124]);
    expect(fixture.diagnostics).toHaveLength(1);
    const diagnostic = fixture.diagnostics.join("");
    const failure = readFileSync(
      path.join(fixture.directory, "failure.json"),
      "utf-8",
    );
    for (const lane of [4, 7]) {
      const pid = Number(
        readFileSync(path.join(fixture.directory, `lane-${lane}.pid`), "utf-8"),
      );
      expect(diagnostic).toContain(`hung-lane-${lane}`);
      expect(diagnostic).toContain(`lane ${lane}`);
      expect(diagnostic).toContain(`PID ${pid}`);
      expect(diagnostic).toContain(`lane ${lane} progress`);
      expect(failure).toContain(`lane-${lane}.test.ts`);
      expect(failure).toContain(String(pid));
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
    }
  } finally {
    fixture.cleanup();
  }
}, 10_000);

test("the runner deadline aborts active work and prevents the next child from starting", async () => {
  const fixture = createFixture({ childTimeoutMs: 10_000, deadlineMs: 2000 });
  let launches = 0;
  try {
    const run = async () =>
      await fixture.supervisor.run({
        command: () => {
          launches += 1;
          return [
            process.execPath,
            "-e",
            'console.log("deadline progress"); setInterval(() => {}, 1000);',
          ];
        },
        cwd: fixture.directory,
        env: process.env,
        identity: {
          kind: "batch",
          label: "deadline-child",
          files: ["deadline.test.ts"],
          lane: 1,
        },
        mode: "buffered",
      });
    expect((await run()).exitCode).toBe(124);
    expect(fixture.diagnostics).toHaveLength(1);
    expect(fixture.diagnostics.join("")).toContain("deadline");
    expect(fixture.diagnostics.join("")).toContain("deadline progress");
    expect((await run()).exitCode).toBe(124);
    expect(launches).toBe(1);
    expect(fixture.diagnostics).toHaveLength(1);
  } finally {
    fixture.cleanup();
  }
}, 10_000);

test("raw logs stay bounded while keeping the latest output for timeout diagnostics", async () => {
  const maxLogBytes = 4096;
  const fixture = createFixture({ maxLogBytes, tailBytes: 1024 });
  try {
    const result = await fixture.supervisor.run({
      command: () => [
        process.execPath,
        "-e",
        'for (let i = 0; i < 1024; i++) console.log("old output ".repeat(16)); console.log("latest progress marker"); setInterval(() => {}, 1000);',
      ],
      cwd: fixture.directory,
      env: process.env,
      identity: {
        kind: "batch",
        label: "noisy-hang",
        files: ["noisy.test.ts"],
        lane: 2,
      },
      mode: "buffered",
    });
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("output truncated");
    expect(result.output).toContain("latest progress marker");
    expect(result.output.length).toBeLessThan(maxLogBytes + 100);
    const logs = readdirSync(fixture.directory).filter((file) =>
      file.endsWith(".log"),
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.length).toBeLessThanOrEqual(2);
    const totalBytes = logs.reduce(
      (total, file) =>
        total + statSync(path.join(fixture.directory, file)).size,
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(maxLogBytes);
    expect(readLogs(fixture.directory)).toContain("latest progress marker");
    expect(fixture.diagnostics.join("")).toContain("latest progress marker");
    expect(fixture.diagnostics).toHaveLength(1);
  } finally {
    fixture.cleanup();
  }
}, 10_000);

test("a startup callback failure reaps the child before propagating the original error", async () => {
  let pid = 0;
  const fixture = createFixture({
    onProgress: (text) => {
      pid = Number(/PID (\d+)/u.exec(text)?.at(1));
      throw new TypeError("fixture progress callback failed");
    },
  });
  try {
    const pending = fixture.supervisor.run({
      command: () => [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      cwd: fixture.directory,
      env: process.env,
      identity: {
        kind: "batch",
        label: "startup-failure",
        files: ["startup.test.ts"],
        lane: 0,
      },
      mode: "buffered",
    });
    const result = await Result.tryPromise({
      try: async () => await pending,
      catch: (error) => error,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TypeError);
      if (result.error instanceof TypeError) {
        expect(result.error.message).toBe("fixture progress callback failed");
      }
    }
    expect(pid).toBeGreaterThan(0);
    expect(fixture.supervisor.signal.aborted).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
    expect(fixture.diagnostics.join("")).toContain("startup-failure");
  } finally {
    fixture.cleanup();
  }
}, 10_000);

test("a missing log directory cannot prevent stopping and reaping the child", async () => {
  let pid = 0;
  const fixture = createFixture({
    onProgress: (text) => {
      pid = Number(/PID (\d+)/u.exec(text)?.at(1));
      rmSync(fixture.directory, { recursive: true, force: true });
    },
  });
  try {
    const pending = fixture.supervisor.run({
      command: () => [
        process.execPath,
        "-e",
        'console.log("progress before disk failure"); setInterval(() => {}, 1000);',
      ],
      cwd: fixture.directory,
      env: process.env,
      identity: {
        kind: "batch",
        label: "disk-failure",
        files: ["disk.test.ts"],
        lane: 0,
      },
      mode: "buffered",
    });
    const result = await Result.tryPromise({
      try: async () => await pending,
      catch: (error) => error,
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(Error);
      if (result.error instanceof Error) {
        expect(result.error.message).toMatch(/ENOENT/u);
      }
    }
    expect(pid).toBeGreaterThan(0);
    expect(fixture.supervisor.signal.aborted).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
    const diagnostics = fixture.diagnostics.join("");
    expect(diagnostics).toContain("disk-failure");
    expect(diagnostics).toContain("progress before disk failure");
    expect(diagnostics).toContain("Could not persist stopped process registry");
  } finally {
    fixture.cleanup();
  }
}, 10_000);

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest(
  "the final memory sample fails an exited leader whose surviving worker exceeds the cap",
  async () => {
    const fixture = createFixture({
      memoryLimitBytes: 64 * 1024 ** 2,
      memorySampleIntervalMs: 60_000,
      childTimeoutMs: 8000,
      deadlineMs: 15_000,
      onStdout: () => {
        // Stream callbacks run after the synchronous initial sample. Release the
        // worker only then; no periodic sample can run before the child deadline.
        writeFileSync(path.join(fixture.directory, "spawn-worker"), "ready");
      },
    });
    const workerPidPath = path.join(fixture.directory, "worker.pid");
    const worker = `
    import { writeFileSync } from 'node:fs';
    const allocation = new Uint8Array(96 * 1024 ** 2).fill(1);
    writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));
    setInterval(() => { allocation[0] = allocation[0] === 1 ? 2 : 1; }, 1000);
  `;
    try {
      const result = await fixture.supervisor.run({
        command: () => [
          process.execPath,
          "-e",
          `
        console.log('start worker after initial sample');
        while (!(await Bun.file('spawn-worker').exists())) await Bun.sleep(10);
        Bun.spawn([process.execPath, '-e', ${JSON.stringify(worker)}], { stdout: 'ignore', stderr: 'ignore' });
        while (!(await Bun.file('worker.pid').exists())) await Bun.sleep(10);
        process.exit(0);
      `,
        ],
        cwd: fixture.directory,
        env: process.env,
        identity: {
          kind: "batch",
          label: "final-memory",
          files: ["final-memory.test.ts"],
          lane: 0,
        },
        mode: "stream",
      });
      expect(fixture.diagnostics.join("")).toContain(
        "Test invocation memory limit exceeded for final-memory.test.ts",
      );
      expect(fixture.diagnostics.join("")).not.toContain("wall-clock budget");
      expect(fixture.supervisor.signal.aborted).toBe(true);
      expect(result.exitCode).toBe(124);
      const pid = Number(readFileSync(workerPidPath, "utf-8"));
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      const alive = () => {
        if (process.platform === "linux") {
          const status = Result.try(() =>
            readFileSync(`/proc/${pid}/status`, "utf-8"),
          );
          if (status.isOk() && /^State:\s+Z\b/mu.test(status.value)) {
            return false;
          }
        }
        return Result.try(() => process.kill(pid, 0)).isOk();
      };
      await waitForExternalState({
        description: `worker ${String(pid)} exits`,
        read: () => !alive(),
      });
    } finally {
      fixture.cleanup();
    }
  },
  15_000,
);

posixTest(
  "the supervisor counts an over-budget worker under a low-memory leader and kills their group",
  async () => {
    // The leader is a shell, so only the worker's allocation can cross the
    // cap: a Bun leader's own startup memory can reach 64 MiB on a busy host.
    // The worker records its PID before allocating, so the group is never
    // stopped before the PID exists.
    const fixture = createFixture({
      memoryLimitBytes: 128 * 1024 ** 2,
      childTimeoutMs: 8000,
      deadlineMs: 15_000,
    });
    const workerPidPath = path.join(fixture.directory, "worker.pid");
    const worker = `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));
    const allocation = new Uint8Array(256 * 1024 ** 2).fill(1);
    setInterval(() => { allocation[0] = allocation[0] === 1 ? 2 : 1; }, 1000);
  `;
    try {
      const result = await fixture.supervisor.run({
        command: () => [
          "/bin/sh",
          "-c",
          '"$0" -e "$1" & wait',
          process.execPath,
          worker,
        ],
        cwd: fixture.directory,
        env: process.env,
        identity: {
          kind: "batch",
          label: "worker-memory",
          files: ["worker-memory.test.ts"],
          lane: 0,
        },
        mode: "buffered",
      });
      expect(result.exitCode).toBe(124);
      expect(fixture.diagnostics.join("")).toContain(
        "Test invocation memory limit exceeded for worker-memory.test.ts",
      );
      expect(fixture.diagnostics.join("")).not.toContain("wall-clock budget");
      const pid = Number(readFileSync(workerPidPath, "utf-8"));
      expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
      const alive = () => {
        if (process.platform === "linux") {
          const status = Result.try(() =>
            readFileSync(`/proc/${pid}/status`, "utf-8"),
          );
          if (status.isOk() && /^State:\s+Z\b/mu.test(status.value)) {
            return false;
          }
        }
        return Result.try(() => process.kill(pid, 0)).isOk();
      };
      await waitForExternalState({
        description: `worker ${String(pid)} exits`,
        read: () => !alive(),
      });
    } finally {
      fixture.cleanup();
    }
  },
  15_000,
);

posixTest(
  "a hung child tree keeps output separate, terminates descendants once, and finalizes JUnit",
  async () => {
    const fixture = createFixture();
    const markerPath = path.join(fixture.directory, "descendant-term.received");
    let junitPath = "";
    try {
      const result = await fixture.supervisor.run({
        command: (pathForJUnit) => {
          junitPath = pathForJUnit;
          const descendant = `
            import { appendFileSync, writeFileSync } from "node:fs";
            process.on("SIGTERM", () => {
              appendFileSync(${JSON.stringify(markerPath)}, "SIGTERM\\n");
              writeFileSync(${JSON.stringify(pathForJUnit)}, '<testsuites tests="1" failures="1"><testsuite name="hung tree"><testcase name="descendant"><failure>timed out</failure></testcase></testsuite></testsuites>');
              process.exit(0);
            });
            console.error("descendant stderr before hang");
            setInterval(() => {}, 1000);
          `;
          return [
            process.execPath,
            "-e",
            `
          Bun.spawn({
            cmd: [process.execPath, "-e", ${JSON.stringify(descendant)}],
            stdout: "inherit",
            stderr: "inherit",
          });
          console.log("parent progress before hang");
          setInterval(() => {}, 1000);
        `,
          ];
        },
        cwd: fixture.directory,
        env: process.env,
        identity: {
          kind: "snapshot",
          label: "descendant-hang",
          files: ["scripts/build-pglite-snapshot.ts"],
          lane: 0,
        },
        mode: "buffered",
      });
      expect(result.exitCode).toBe(124);
      expect(result.output).toContain("parent progress before hang");
      expect(result.output).toContain("descendant stderr before hang");
      expect(
        readFileSync(markerPath, "utf-8").split("\n").filter(Boolean),
      ).toEqual(["SIGTERM"]);
      expect(readFileSync(junitPath, "utf-8")).toBe(
        '<testsuites tests="1" failures="1"><testsuite name="hung tree"><testcase name="descendant"><failure>timed out</failure></testcase></testsuite></testsuites>',
      );
      expect(fixture.diagnostics).toHaveLength(1);
      expect(fixture.diagnostics.join("")).toContain(
        "parent progress before hang",
      );
      expect(fixture.diagnostics.join("")).toContain(
        "descendant stderr before hang",
      );
      expect(readLogs(fixture.directory)).toContain(
        "descendant stderr before hang",
      );
    } finally {
      fixture.cleanup();
    }
  },
  10_000,
);

posixTest(
  "a stopped process group stays tracked after its leader exits and pipes close",
  async () => {
    const fixture = createFixture({ stopGraceMs: 8000, deadlineMs: 20_000 });
    const heartbeatPath = path.join(fixture.directory, "descendant.heartbeat");
    try {
      const result = await fixture.supervisor.run({
        command: () => [
          process.execPath,
          "-e",
          `
          const descendant = ${JSON.stringify(`
            import { writeFileSync } from "node:fs";
            process.on("SIGTERM", () => undefined);
            const heartbeat = () => writeFileSync(${JSON.stringify(heartbeatPath)}, String(Date.now()));
            heartbeat();
            setInterval(heartbeat, 20);
          `)};
          Bun.spawn({
            cmd: [process.execPath, "-e", descendant],
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          });
          setInterval(() => {}, 1000);
        `,
        ],
        cwd: fixture.directory,
        env: process.env,
        identity: {
          kind: "snapshot",
          label: "closed-pipe-descendant",
          files: ["scripts/build-pglite-snapshot.ts"],
          lane: 0,
        },
        mode: "buffered",
      });

      expect(result.exitCode).toBe(124);
      expect(existsSync(heartbeatPath)).toBe(true);
      const afterLeaderExit = readFileSync(heartbeatPath, "utf-8");
      await waitForExternalState({
        description: "the descendant writes a heartbeat after the leader exits",
        intervalMs: 20,
        read: () => readFileSync(heartbeatPath, "utf-8") !== afterLeaderExit,
      });
      fixture.supervisor.dispose();
      await Bun.sleep(100);
      const afterDispose = readFileSync(heartbeatPath, "utf-8");
      await Bun.sleep(100);
      expect(readFileSync(heartbeatPath, "utf-8")).toBe(afterDispose);
    } finally {
      fixture.cleanup();
    }
  },
  10_000,
);

test("explicit child budgets retain PR and memory defaults and reject invalid limits", () => {
  expect(testProcessBudgets({})).toEqual({
    childTimeoutMs: 600_000,
    deadlineMs: 1_200_000,
  });
  expect(testProcessBudgets({}, 110 * 60_000)).toEqual({
    childTimeoutMs: 600_000,
    deadlineMs: 6_600_000,
  });
  expect(
    testProcessBudgets({
      API_TEST_CHILD_TIMEOUT_MS: "1200000",
      API_TEST_RUNNER_DEADLINE_MS: "2100000",
    }),
  ).toEqual({ childTimeoutMs: 1_200_000, deadlineMs: 2_100_000 });
  for (const name of [
    "API_TEST_CHILD_TIMEOUT_MS",
    "API_TEST_RUNNER_DEADLINE_MS",
  ]) {
    for (const value of [
      "",
      "1",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "9007199254740992",
    ]) {
      expect(() => testProcessBudgets({ [name]: value })).toThrow(
        `${name} must be an integer of at least two`,
      );
    }
  }
  for (const child of ["1200000", "1200001"]) {
    expect(() =>
      testProcessBudgets({ API_TEST_CHILD_TIMEOUT_MS: child }),
    ).toThrow("API test child budget must be below the runner deadline");
  }
});
