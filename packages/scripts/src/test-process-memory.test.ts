import { Result } from "better-result";
import { expect, test } from "bun:test";

import {
  createProcessMemoryReader,
  parseWindowsProcessTree,
  testInvocationMemoryLimit,
  TEST_INVOCATION_MEMORY_GIB_ENV,
  watchTestProcessMemory,
} from "./test-process-memory";

test("Windows snapshots retain only owned PID readings and preserve unknown lower bounds", () => {
  const parsed = parseWindowsProcessTree(
    42,
    "unknown\n42 1 700\n43 42 -1\n44 43 500\n99 1 9000",
  );
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new TypeError(parsed.error.message);
  }
  expect([...parsed.value.readings.keys()]).toEqual([42, 43, 44]);
  expect(parsed.value.readings.get(42)?.unwrap()).toBe(700);
  expect(parsed.value.readings.get(43)?.isErr()).toBe(true);
  expect(parsed.value.readings.get(44)?.unwrap()).toBe(500);
  expect(parsed.value.unavailable?.message).toContain("ancestry");
  expect(parseWindowsProcessTree(42, "bad row").isErr()).toBe(true);
});

test("asynchronous tree queries do not overlap, enforce readable sums, and abort on stop", async () => {
  const failures: string[] = [];
  const warnings: string[] = [];
  let queries = 0;
  let finish:
    | ((sample: ReturnType<typeof parseWindowsProcessTree>) => void)
    | undefined;
  let observedSignal: AbortSignal | undefined;
  const readBytes = Object.assign(() => Result.ok(0), {
    sampleTree: (_pid: number, signal: AbortSignal) => {
      queries += 1;
      observedSignal = signal;
      return new Promise<ReturnType<typeof parseWindowsProcessTree>>(
        (resolve) => {
          finish = resolve;
        },
      );
    },
  });
  const watchdog = watchTestProcessMemory({
    child: { pid: 42, exitCode: null, signalCode: null, kill: () => {} },
    readBytes,
    limitBytes: 1000,
    intervalMs: 5,
    file: () => "snapshot.test.ts",
    onFailure: (message) => {
      failures.push(message);
    },
    onWarning: (message) => {
      warnings.push(message);
    },
    signalPid: () => {},
  });
  try {
    await Bun.sleep(20);
    expect(queries).toBe(1);
    finish?.(
      parseWindowsProcessTree(42, "unknown\n42 1 700\n43 42 -1\n44 42 500"),
    );
    await Bun.sleep(20);
    expect(failures).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(watchdog.peakBytes()).toBe(1200);
    expect(queries).toBe(1);
  } finally {
    finish?.(parseWindowsProcessTree(42, "42 1 0"));
    await watchdog.stop();
  }
  expect(observedSignal?.aborted).toBe(true);
});

test("stopping a pending tree query aborts and joins it without measuring unknown bytes", async () => {
  let queries = 0;
  let cancelled = false;
  const failures: string[] = [];
  const readBytes = Object.assign(() => Result.ok(0), {
    sampleTree: (_pid: number, signal: AbortSignal) => {
      queries += 1;
      return new Promise<ReturnType<typeof parseWindowsProcessTree>>(
        (resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve(parseWindowsProcessTree(42, "unknown\n42 1 -1"));
            },
            { once: true },
          );
        },
      );
    },
  });
  const watchdog = watchTestProcessMemory({
    child: { pid: 42, exitCode: null, signalCode: null, kill: () => {} },
    readBytes,
    limitBytes: 1000,
    file: () => "pending.test.ts",
    onFailure: (message) => {
      failures.push(message);
    },
    onWarning: (message) => {
      failures.push(message);
    },
  });
  await watchdog.stop();
  expect(queries).toBe(1);
  expect(cancelled).toBe(true);
  expect(watchdog.peakBytes()).toBe(0);
  expect(failures).toEqual([]);
});

test("memory budgets default to six GiB and reject unbounded overrides", () => {
  expect(testInvocationMemoryLimit({})).toBe(6 * 1024 ** 3);
  expect(
    testInvocationMemoryLimit({ [TEST_INVOCATION_MEMORY_GIB_ENV]: "0.125" }),
  ).toBe(128 * 1024 ** 2);
  for (const value of ["", "0", "-1", "Infinity", "NaN", "garbage"]) {
    expect(() =>
      testInvocationMemoryLimit({ [TEST_INVOCATION_MEMORY_GIB_ENV]: value }),
    ).toThrow(`${TEST_INVOCATION_MEMORY_GIB_ENV} must be a positive number`);
  }
});

for (const fixture of ["memory-allocation.ts", "memory-allocation-parent.ts"]) {
  test(`a resident allocating process in ${fixture} is killed with its file and measured peak`, async () => {
    const readBytes = await createProcessMemoryReader();
    const filename = `test-fixtures/${fixture}`;
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/${filename}`],
      {
        stdout: "ignore",
        stderr: "inherit",
        detached: process.platform !== "win32",
      },
    );
    const failures: string[] = [];
    const limitBytes = 128 * 1024 ** 2;
    const watchdog = watchTestProcessMemory({
      child,
      limitBytes,
      readBytes,
      termination: process.platform === "win32" ? "process" : "group",
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
      expect(child.signalCode).toBe("SIGKILL");
      expect(watchdog.peakBytes()).toBeGreaterThan(limitBytes);
      expect(failures).toHaveLength(1);
      expect(failures.at(0)).toContain(
        `Test invocation memory limit exceeded for ${filename}`,
      );
      expect(failures.at(0)).toContain("peak ");
      expect(failures.at(0)).toContain("cap 0.125 GiB");
    } finally {
      await watchdog.stop();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  });
}

for (const boundary of ["census", "reading"] as const) {
  test(`unknown ${boundary} samples warn once and only kill after a measured cap breach`, async () => {
    const failures: string[] = [];
    const signals: (number | NodeJS.Signals | undefined)[] = [];
    const warnings: string[] = [];
    let attempts = 0;
    const failUntilRecovered = () => {
      attempts += 1;
      if (attempts < 3) {
        throw new TypeError(`fixture ${boundary} timed out`);
      }
    };
    const watchdog = watchTestProcessMemory({
      child: {
        pid: 42,
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
          signals.push(signal);
        },
      },
      limitBytes: 1024,
      children: (pid) => {
        if (pid !== 42) {
          return Result.ok([]);
        }
        if (boundary === "census") {
          failUntilRecovered();
        }
        return Result.ok([43, 44]);
      },
      signalPid: () => {},
      readBytes: () => {
        if (boundary === "reading") {
          failUntilRecovered();
        }
        return Result.ok(400);
      },
      file: () => "fixture.test.ts",
      onFailure: (message) => {
        failures.push(message);
      },
      onWarning: (message) => {
        warnings.push(message);
      },
      intervalMs: 10,
    });
    expect(signals).toEqual([]);
    expect(failures).toEqual([]);
    await Bun.sleep(75);
    await watchdog.stop();
    expect(signals).toEqual(["SIGKILL"]);
    expect(failures).toHaveLength(1);
    expect(failures.at(0)).toContain(
      "Test invocation memory limit exceeded for fixture.test.ts",
    );
    expect(warnings).toHaveLength(1);
    expect(warnings.at(0)).toContain(
      "Test memory sample partially unavailable for fixture.test.ts",
    );
    expect(attempts).toBeGreaterThan(2);
    expect(watchdog.peakBytes()).toBe(1200);
  });
}

test("the cap sums measured workers instead of allowing each worker a full budget", async () => {
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  const watchdog = watchTestProcessMemory({
    child: {
      pid: process.pid,
      exitCode: null,
      signalCode: null,
      kill: (signal) => {
        signals.push(signal);
      },
    },
    limitBytes: 1024,
    children: (pid) => Result.ok(pid === process.pid ? [42, 43] : []),
    signalPid: () => {},
    readBytes: () => Result.ok(400),
    file: () => "workers.test.ts",
    onFailure: (message) => {
      failures.push(message);
    },
    onWarning: (message) => {
      warnings.push(message);
    },
  });
  await watchdog.stop();
  expect(watchdog.peakBytes()).toBe(1200);
  expect(signals).toEqual(["SIGKILL"]);
  expect(failures.at(0)).toContain(
    "Test invocation memory limit exceeded for workers.test.ts",
  );
  expect(warnings).toEqual([]);
});

for (const boundary of ["census", "reading"] as const) {
  for (const total of ["below", "above"] as const) {
    test(`a partial ${boundary} sample ${total} the cap enforces its readable lower bound`, async () => {
      const signals: (number | NodeJS.Signals | undefined)[] = [];
      const failures: string[] = [];
      const warnings: string[] = [];
      let samples = 0;
      const watchdog = watchTestProcessMemory({
        child: {
          pid: 42,
          exitCode: null,
          signalCode: null,
          kill: (signal) => {
            signals.push(signal);
          },
        },
        limitBytes: 1024,
        children: (pid) => {
          if (pid === 42) {
            samples += 1;
            return Result.ok([43, 44]);
          }
          if (boundary === "census" && pid === 43) {
            throw new TypeError("fixture descendant census unavailable");
          }
          return Result.ok([]);
        },
        readBytes: (pid) => {
          if (pid === 44) {
            if (boundary === "reading") {
              throw new TypeError("fixture descendant reading unavailable");
            }
            return Result.ok(0);
          }
          return Result.ok(total === "above" ? 600 : 300);
        },
        signalPid: () => {},
        file: () => "partial-tree.test.ts",
        onFailure: (message) => {
          failures.push(message);
        },
        onWarning: (message) => {
          warnings.push(message);
        },
        intervalMs: 10,
      });
      try {
        if (total === "below") {
          expect(signals).toEqual([]);
          await Bun.sleep(50);
          expect(samples).toBeGreaterThan(1);
          expect(signals).toEqual([]);
          expect(failures).toEqual([]);
          expect(watchdog.peakBytes()).toBe(600);
        } else {
          expect(signals).toEqual(["SIGKILL"]);
          expect(failures).toHaveLength(1);
          expect(failures.at(0)).toContain(
            "Test invocation memory limit exceeded for partial-tree.test.ts",
          );
          expect(watchdog.peakBytes()).toBe(1200);
        }
        expect(warnings).toHaveLength(1);
        expect(warnings.at(0)).toContain(
          "enforcing readable lower bound and retrying",
        );
      } finally {
        await watchdog.stop();
      }
    });
  }
}

test("an unavailable root census still enforces the measured root memory", async () => {
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const watchdog = watchTestProcessMemory({
    child: {
      pid: 42,
      exitCode: null,
      signalCode: null,
      kill: (signal) => {
        signals.push(signal);
      },
    },
    limitBytes: 1024,
    children: () => {
      throw new TypeError("fixture root census timed out");
    },
    readBytes: () => Result.ok(1200),
    signalPid: () => {},
    file: () => "root-tree.test.ts",
    onFailure: (message) => {
      failures.push(message);
    },
    onWarning: (message) => {
      warnings.push(message);
    },
  });
  await watchdog.stop();
  expect(watchdog.peakBytes()).toBe(1200);
  expect(signals).toEqual(["SIGKILL"]);
  expect(failures.at(0)).toContain(
    "Test invocation memory limit exceeded for root-tree.test.ts",
  );
  expect(warnings).toHaveLength(1);
});
