import { expect, test } from "bun:test";

import {
  createProcessMemoryReader,
  testProcessMemoryLimit,
  TEST_PROCESS_MEMORY_GIB_ENV,
  watchTestProcessMemory,
} from "./test-process-memory";

test("memory budgets default to six GiB and reject unbounded overrides", () => {
  expect(testProcessMemoryLimit({})).toBe(6 * 1024 ** 3);
  expect(
    testProcessMemoryLimit({ [TEST_PROCESS_MEMORY_GIB_ENV]: "0.125" }),
  ).toBe(128 * 1024 ** 2);
  for (const value of ["", "0", "-1", "Infinity", "NaN", "garbage"]) {
    expect(() =>
      testProcessMemoryLimit({ [TEST_PROCESS_MEMORY_GIB_ENV]: value }),
    ).toThrow(`${TEST_PROCESS_MEMORY_GIB_ENV} must be a positive number`);
  }
});

for (const fixture of ["memory-allocation.ts", "memory-allocation-parent.ts"]) {
  test(`a resident allocating process in ${fixture} is killed with its file and measured peak`, async () => {
    const readBytes = await createProcessMemoryReader();
    const filename = `test-fixtures/${fixture}`;
    const child = Bun.spawn(
      [process.execPath, `${import.meta.dir}/${filename}`],
      { stdout: "ignore", stderr: "inherit" },
    );
    const failures: string[] = [];
    const limitBytes = 128 * 1024 ** 2;
    const watchdog = watchTestProcessMemory({
      child,
      limitBytes,
      readBytes,
      file: () => filename,
      onFailure: (message) => failures.push(message),
      intervalMs: 100,
    });
    try {
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      expect(watchdog.peakBytes()).toBeGreaterThan(limitBytes);
      expect(failures).toHaveLength(1);
      expect(failures.at(0)).toContain(
        `Test memory limit exceeded for ${filename}`,
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

test("a failed memory reader stops the process rather than disabling the cap", async () => {
  const failures: string[] = [];
  const signals: (number | NodeJS.Signals | undefined)[] = [];
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
    children: () => [],
    readBytes: () => {
      throw new TypeError("fixture reader unavailable");
    },
    file: () => "fixture.test.ts",
    onFailure: (message) => failures.push(message),
  });
  await Bun.sleep(75);
  watchdog.stop();
  expect(signals).toEqual(["SIGKILL"]);
  expect(failures.at(0)).toContain(
    "Test memory monitoring failed for fixture.test.ts",
  );
});
