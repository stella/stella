import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createProcessMemoryReader,
  parseLinuxProcessMemoryStatus,
  parseProcessGroupMemory,
  TEST_INVOCATION_MEMORY_GIB_ENV,
  testInvocationMemoryLimit,
  watchTestProcessMemory,
} from "./process-memory";
import { attachTestProcessShutdown } from "./process-shutdown";
import { spawnTestProcess } from "./process-spawn";

const posixTest = process.platform === "win32" ? test.skip : test;
test.each(["R", "S", "X", "Z"])(
  "Linux status without an address space reports zero even in state %s",
  (state) => {
    expect(
      parseLinuxProcessMemoryStatus(
        42,
        `Name:\tfinishing\nState:\t${state}\nPid:\t42\nThreads:\t1\n`,
      ).unwrap(),
    ).toBe(0);
  },
);
test("Linux memory status sums resident and swapped pages and rejects partial counters", () => {
  expect(
    parseLinuxProcessMemoryStatus(
      42,
      "State:\tR\nVmRSS:\t4 kB\nVmSwap:\t2 kB\n",
    ).unwrap(),
  ).toBe(6144);
  for (const status of [
    "",
    "Name:\tfinishing\n",
    "State:\tR\nVmRSS:\t4 kB\n",
    "State:\tR\nVmSwap:\t2 kB\n",
    "State:\tR\nVmSize:\t8 kB\n",
    "State:\tR\nVmRSS:\tbad kB\nVmSwap:\t2 kB\n",
  ]) {
    expect(parseLinuxProcessMemoryStatus(42, status).isErr()).toBe(true);
  }
});

posixTest.each(["leader", "leader-exit"] as const)(
  "%s process group counts and kills the orphan after its launcher exits before the first sample",
  async (mode) => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-group-orphan-"));
    const { child } = spawnTestProcess({
      limitBytes: 1024 ** 3,
      command: [
        process.execPath,
        `${import.meta.dir}/test-fixtures/job-launcher-leader.ts`,
        mode,
        path.join(directory, "ready"),
      ],
      options: { detached: true, stdout: "pipe", stderr: "inherit" },
      onWarning: (message) => {
        throw new TypeError(message);
      },
    });
    try {
      const ready = await child.stdout.getReader().read();
      const [launcher, worker] = new TextDecoder()
        .decode(ready.value)
        .trim()
        .split(/\s+/u)
        .map(Number);
      if (
        launcher === undefined ||
        worker === undefined ||
        !Number.isSafeInteger(launcher) ||
        !Number.isSafeInteger(worker) ||
        worker <= 1
      ) {
        throw new TypeError("Fixture must report launcher and worker PIDs");
      }
      if (mode === "leader-exit") {
        await child.exited;
      }
      expect(Result.try(() => process.kill(launcher, 0)).isErr()).toBe(true);
      expect(Result.try(() => process.kill(worker, 0)).isOk()).toBe(true);
      const membership = Bun.spawnSync([
        "ps",
        "-o",
        "pgid=",
        "-p",
        String(worker),
      ]);
      expect(membership.success).toBe(true);
      expect(Number(membership.stdout.toString().trim())).toBe(child.pid);
      const failures: string[] = [];
      const watchdog = watchTestProcessMemory({
        child,
        readBytes: await createProcessMemoryReader(),
        limitBytes: 64 * 1024 ** 2,
        intervalMs: 60_000,
        file: () => "group-orphan.test.ts",
        onFailure: (message) => {
          failures.push(message);
        },
        onWarning: (message) => {
          throw new TypeError(message);
        },
      });
      try {
        expect(watchdog.peakBytes()).toBeGreaterThanOrEqual(96 * 1024 ** 2);
        expect(failures).toHaveLength(1);
        await child.exited;
        const alive = () => {
          if (process.platform === "linux") {
            const status = Result.try(() =>
              readFileSync(`/proc/${worker}/status`, "utf-8"),
            );
            if (status.isOk() && /^State:\s+Z\b/mu.test(status.value)) {
              return false;
            }
          }
          return Result.try(() => process.kill(worker, 0)).isOk();
        };
        for (let attempt = 0; attempt < 100 && alive(); attempt += 1) {
          await Bun.sleep(10);
        }
        expect(alive()).toBe(false);
      } finally {
        await watchdog.stop();
      }
    } finally {
      Result.try(() => process.kill(-child.pid, "SIGKILL"));
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

test("memory budgets default to six GiB and reject unbounded overrides", () => {
  expect(testInvocationMemoryLimit({})).toBe(6 * 1024 ** 3);
  expect(
    testInvocationMemoryLimit({ [TEST_INVOCATION_MEMORY_GIB_ENV]: "0.125" }),
  ).toBe(128 * 1024 ** 2);
  for (const value of [
    "",
    "0",
    "-1",
    "Infinity",
    "NaN",
    "garbage",
    "0.0000000001",
    "9007199254740992",
  ]) {
    expect(() =>
      testInvocationMemoryLimit({ [TEST_INVOCATION_MEMORY_GIB_ENV]: value }),
    ).toThrow(`${TEST_INVOCATION_MEMORY_GIB_ENV} must be a positive number`);
  }
});

test("the POSIX group watchdog consumes the same integer bytes for a fractional GiB budget", async () => {
  const limitBytes = testInvocationMemoryLimit({
    [TEST_INVOCATION_MEMORY_GIB_ENV]: "0.1",
  });
  const signals: number[] = [];
  const failures: string[] = [];
  const watchdog = watchTestProcessMemory({
    child: {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      exited: Promise.resolve(0),
      kill: () => {
        throw new TypeError("Must kill group");
      },
    },
    limitBytes,
    sampleGroup: () => Result.ok(new Map([[43, 107_374_183]])),
    readBytes: () => Result.ok(0),
    signalPid: (pid) => {
      signals.push(pid);
    },
    file: () => "fractional-budget.test.ts",
    onFailure: (message) => {
      failures.push(message);
    },
    onWarning: (message) => {
      throw new TypeError(message);
    },
  });
  await watchdog.stop();
  expect(limitBytes).toBe(107_374_182);
  expect(watchdog.peakBytes()).toBe(limitBytes + 1);
  expect(failures).toHaveLength(1);
  expect(signals).toEqual([-42]);
});

for (const fixture of ["memory-allocation.ts", "memory-allocation-parent.ts"]) {
  test(`a resident allocating process in ${fixture} is killed with its file and measured peak`, async () => {
    const readBytes = await createProcessMemoryReader();
    const filename = `test-fixtures/${fixture}`;
    const limitBytes = 128 * 1024 ** 2;
    const { child, windowsProcesses } = spawnTestProcess({
      // Leave startup headroom for every Bun runtime; the watchdog's lower
      // reporting threshold still proves measurement and whole-job termination.
      limitBytes: process.platform === "win32" ? 512 * 1024 ** 2 : limitBytes,
      command: [process.execPath, `${import.meta.dir}/${filename}`],
      options: {
        stdout: "ignore",
        stderr: "inherit",
        detached: process.platform !== "win32",
      },
      onWarning: (message) => {
        throw new TypeError(message);
      },
    });
    const failures: string[] = [];
    const shutdown =
      process.platform === "win32"
        ? attachTestProcessShutdown({
            child,
            windowsProcesses,
            termination: "process",
            onWarning: (message) => {
              throw new TypeError(message);
            },
          })
        : undefined;
    const watchdog = watchTestProcessMemory({
      windowsProcesses: shutdown?.windowsProcesses,
      child,
      limitBytes,
      readBytes,
      file: () => filename,
      onFailure: (message) => {
        failures.push(message);
      },
      onWarning: (message) => {
        throw new TypeError(message);
      },
      intervalMs: 100,
    });
    try {
      await child.exited;
      await watchdog.stop();
      if (process.platform === "win32") {
        expect(child.exitCode).not.toBe(0);
      } else {
        expect(child.signalCode).toBe("SIGKILL");
      }
      if (process.platform === "win32") {
        expect(watchdog.peakBytes()).toBeGreaterThan(0);
        expect(failures.at(0)).toContain("job committed-memory peak");
        expect(
          watchdog.peakBytes() > limitBytes ||
            failures.at(0)?.includes("Windows job rejected an allocation"),
        ).toBe(true);
      } else {
        expect(watchdog.peakBytes()).toBeGreaterThan(limitBytes);
      }
      expect(failures).toHaveLength(1);
      expect(failures.at(0)).toContain(
        `Test invocation memory limit exceeded for ${filename}`,
      );
      expect(failures.at(0)).toContain("peak ");
      expect(failures.at(0)).toContain("cap 0.125 GiB");
    } finally {
      await watchdog.stop();
      shutdown?.dispose();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }, 15_000);
}

test.each([900, 1200])(
  "Windows job limit notification enforces the cap with a reported committed peak of %i bytes",
  async (peakBytes) => {
    const failures: string[] = [];
    let terminations = 0;
    const watchdog = watchTestProcessMemory({
      child: {
        pid: 42,
        exitCode: null,
        signalCode: null,
        exited: Promise.resolve(1),
        kill: () => {
          throw new TypeError("Must terminate job");
        },
      },
      windowsProcesses: {
        readMemory: () => Result.ok({ peakBytes, status: "limit-exceeded" }),
        signal: () => {
          terminations += 1;
          return Result.ok(undefined);
        },
      },
      limitBytes: 1000,
      readBytes: () => {
        throw new TypeError("Must not mix process memory into job accounting");
      },
      sampleGroup: () => {
        throw new TypeError("Must not sample a Windows process group");
      },
      file: () => "job-counter.test.ts",
      onFailure: (message) => {
        failures.push(message);
      },
      onWarning: (message) => {
        throw new TypeError(message);
      },
    });
    await watchdog.stop();
    expect(watchdog.peakBytes()).toBe(peakBytes);
    expect(terminations).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures.at(0)).toContain("job committed-memory peak");
    expect(failures.at(0)).toContain("Windows job rejected an allocation");
  },
);

test("group samples retain reparented members, reject malformed rows, and exclude other groups", () => {
  expect([
    ...parseProcessGroupMemory(42, "43 42 2\n99 99 9000\n44 42 3").unwrap(),
  ]).toEqual([
    [43, 2048],
    [44, 3072],
  ]);
  expect(parseProcessGroupMemory(42, "").unwrap().size).toBe(0);
  for (const row of [
    "bad row",
    "0 42 1",
    "43 -1 1",
    "43 42 -1",
    "43 42 NaN",
    "43 42 1 extra",
  ]) {
    expect(parseProcessGroupMemory(42, row).isErr()).toBe(true);
  }
});

for (const disappearance of [
  "exited-leader",
  "gone-leader",
  "gone-worker",
] as const) {
  test.each([300, 1200])(
    `${disappearance} between group census and memory read retains a %i-byte lower bound without warning`,
    async (rssBytes) => {
      const warnings: string[] = [];
      const failures: string[] = [];
      const killed: number[] = [];
      const pid = disappearance === "gone-worker" ? 43 : 42;
      const watchdog = watchTestProcessMemory({
        child: {
          pid: 42,
          exitCode: disappearance === "gone-leader" ? null : 0,
          signalCode: null,
          exited: Promise.resolve(0),
          kill: () => {
            throw new TypeError("Must terminate group");
          },
        },
        limitBytes: 1024,
        sampleGroup: () => Result.ok(new Map([[pid, rssBytes]])),
        readBytes: () => {
          throw new TypeError("Process memory disappeared after census");
        },
        signalPid: (target, signal) => {
          if (signal === 0 && disappearance !== "exited-leader") {
            throw Object.assign(new TypeError("Process is gone"), {
              code: "ESRCH",
            });
          }
          if (signal === "SIGKILL") {
            killed.push(target);
          }
        },
        file: () => "exited-process.test.ts",
        onWarning: (message) => {
          warnings.push(message);
        },
        onFailure: (message) => {
          failures.push(message);
        },
      });
      await watchdog.stop();
      expect(watchdog.peakBytes()).toBe(rssBytes);
      expect(warnings).toEqual([]);
      expect(failures).toHaveLength(rssBytes > 1024 ? 1 : 0);
      expect(killed).toEqual(rssBytes > 1024 ? [-42] : []);
    },
  );
}

test("Windows job read failures remain visible after its leader exits", async () => {
  const warnings: string[] = [];
  const watchdog = watchTestProcessMemory({
    child: {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      exited: Promise.resolve(0),
      kill: () => {
        throw new TypeError("Must terminate job");
      },
    },
    windowsProcesses: {
      readMemory: () => {
        throw new TypeError("Job accounting unavailable");
      },
      signal: () => Result.ok(undefined),
    },
    limitBytes: 1024,
    readBytes: () => {
      throw new TypeError("Must measure job");
    },
    signalPid: () => {
      throw Object.assign(new TypeError("Leader is gone"), { code: "ESRCH" });
    },
    file: () => "job-reading.test.ts",
    onFailure: (message) => {
      throw new TypeError(message);
    },
    onWarning: (message) => {
      warnings.push(message);
    },
  });
  await watchdog.stop();
  expect(warnings).toHaveLength(1);
  expect(warnings.at(0)).toContain("Job accounting unavailable");
  expect(watchdog.peakBytes()).toBe(0);
});

for (const boundary of ["census", "reading"] as const) {
  for (const budget of ["below", "above"] as const) {
    test(`unavailable group ${boundary} ${budget} the cap preserves readable lower bounds and retries`, async () => {
      const failures: string[] = [];
      const warnings: string[] = [];
      const signals: { pid: number; signal: NodeJS.Signals | 0 }[] = [];
      let samples = 0;
      const bytes = budget === "above" ? 1200 : 300;
      const watchdog = watchTestProcessMemory({
        child: {
          pid: 42,
          exitCode: 0,
          signalCode: null,
          exited: Promise.resolve(0),
          kill: () => {
            throw new TypeError("Must kill group");
          },
        },
        limitBytes: 1024,
        sampleGroup: () => {
          samples += 1;
          if (boundary === "census") {
            throw new TypeError("Group sample unavailable");
          }
          return Result.ok(new Map([[43, bytes]]));
        },
        readBytes: () => {
          if (boundary === "reading") {
            throw new TypeError("Footprint unavailable");
          }
          return Result.ok(bytes);
        },
        signalPid: (pid, signal) => {
          signals.push({ pid, signal });
        },
        file: () => "group.test.ts",
        onFailure: (message) => {
          failures.push(message);
        },
        onWarning: (message) => {
          warnings.push(message);
        },
        intervalMs: 10,
      });
      try {
        if (budget === "below") {
          await Bun.sleep(40);
          expect(samples).toBeGreaterThan(1);
          expect(failures).toEqual([]);
        } else {
          expect(failures).toHaveLength(1);
          expect(signals).toContainEqual({ pid: -42, signal: "SIGKILL" });
          expect(
            signals.filter(({ signal }) => signal === "SIGKILL"),
          ).toHaveLength(1);
        }
        expect(watchdog.peakBytes()).toBe(bytes);
        expect(warnings).toHaveLength(1);
      } finally {
        await watchdog.stop();
      }
    });
  }
}

test("a process-group budget sums surviving workers and signals only the group", async () => {
  const killed: number[] = [];
  const watchdog = watchTestProcessMemory({
    child: {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      exited: Promise.resolve(0),
      kill: () => {
        throw new TypeError("Must kill group");
      },
    },
    limitBytes: 1000,
    sampleGroup: () =>
      Result.ok(
        new Map([
          [43, 600],
          [44, 600],
        ]),
      ),
    readBytes: () => Result.ok(0),
    signalPid: (pid) => {
      killed.push(pid);
    },
    file: () => "workers.test.ts",
    onFailure: () => {},
    onWarning: (message) => {
      throw new TypeError(message);
    },
  });
  await watchdog.stop();
  expect(watchdog.peakBytes()).toBe(1200);
  expect(killed).toEqual([-42]);
});

test("an empty process group ends ownership before its PGID can be reused", async () => {
  let samples = 0;
  const watchdog = watchTestProcessMemory({
    child: {
      pid: 42,
      exitCode: 0,
      signalCode: null,
      exited: Promise.resolve(0),
      kill: () => {
        throw new TypeError("No owned processes");
      },
    },
    limitBytes: 1000,
    sampleGroup: () => {
      samples += 1;
      return Result.ok(samples === 1 ? new Map() : new Map([[99, 9000]]));
    },
    readBytes: () => {
      throw new TypeError("Empty group must not read another process");
    },
    file: () => "empty-group.test.ts",
    onFailure: (message) => {
      throw new TypeError(message);
    },
    onWarning: (message) => {
      throw new TypeError(message);
    },
    intervalMs: 10,
  });
  try {
    await Bun.sleep(40);
    expect(samples).toBe(1);
    expect(watchdog.peakBytes()).toBe(0);
  } finally {
    await watchdog.stop();
  }
});
