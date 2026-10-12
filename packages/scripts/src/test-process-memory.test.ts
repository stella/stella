import { expect, test } from "bun:test";

import {
  createProcessMemoryReader,
  testInvocationMemoryLimit,
  TEST_INVOCATION_MEMORY_GIB_ENV,
  watchTestProcessMemory,
} from "./test-process-memory";

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
      onFailure: (message) => failures.push(message),
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
      watchdog.stop();
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
          return [];
        }
        if (boundary === "census") {
          failUntilRecovered();
        }
        return [43, 44];
      },
      signalPid: () => {},
      readBytes: () => {
        if (boundary === "reading") {
          failUntilRecovered();
        }
        return 400;
      },
      file: () => "fixture.test.ts",
      onFailure: (message) => failures.push(message),
      onWarning: (message) => warnings.push(message),
      intervalMs: 10,
    });
    expect(signals).toEqual([]);
    expect(failures).toEqual([]);
    await Bun.sleep(75);
    watchdog.stop();
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

test("the cap sums measured workers instead of allowing each worker a full budget", () => {
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
    children: (pid) => (pid === process.pid ? [42, 43] : []),
    signalPid: () => {},
    readBytes: () => 400,
    file: () => "workers.test.ts",
    onFailure: (message) => failures.push(message),
    onWarning: (message) => warnings.push(message),
  });
  watchdog.stop();
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
            return [43, 44];
          }
          if (boundary === "census" && pid === 43) {
            throw new TypeError("fixture descendant census unavailable");
          }
          return [];
        },
        readBytes: (pid) => {
          if (pid === 44) {
            if (boundary === "reading") {
              throw new TypeError("fixture descendant reading unavailable");
            }
            return 0;
          }
          return total === "above" ? 600 : 300;
        },
        signalPid: () => {},
        file: () => "partial-tree.test.ts",
        onFailure: (message) => failures.push(message),
        onWarning: (message) => warnings.push(message),
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
        watchdog.stop();
      }
    });
  }
}

test("an unavailable root census still enforces the measured root memory", () => {
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
    readBytes: () => 1200,
    signalPid: () => {},
    file: () => "root-tree.test.ts",
    onFailure: (message) => failures.push(message),
    onWarning: (message) => warnings.push(message),
  });
  watchdog.stop();
  expect(watchdog.peakBytes()).toBe(1200);
  expect(signals).toEqual(["SIGKILL"]);
  expect(failures.at(0)).toContain(
    "Test invocation memory limit exceeded for root-tree.test.ts",
  );
  expect(warnings).toHaveLength(1);
});
