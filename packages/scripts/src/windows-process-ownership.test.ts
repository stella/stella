import { Result } from "better-result";
import { JSCallback, linkSymbols } from "bun:ffi";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForExternalState } from "@stll/property-testing/external-state";

import {
  TEST_INVOCATION_MEMORY_GIB_ENV,
  testInvocationMemoryLimit,
  watchTestProcessMemory,
} from "./process-memory";
import { spawnTestProcess } from "./process-spawn";
import { quoteWindowsFixtureArgument } from "./test-fixtures/native-fixture-process";
import {
  createWindowsProcessOwnership,
  WINDOWS_JOB_SYMBOLS,
  type WindowsJobApi,
} from "./windows-process-ownership";

const windowsTest = process.platform === "win32" ? test : test.skip;
test.each([0, 1, 2, 128, 2048])(
  "native Windows arguments escape quote-adjacent and trailing runs of %i backslashes",
  (length) => {
    const slashes = "\\".repeat(length);
    expect(quoteWindowsFixtureArgument(`a${slashes}"b${slashes}`)).toBe(
      `"a${"\\".repeat(length * 2 + 1)}"b${slashes.repeat(2)}"`,
    );
    expect(quoteWindowsFixtureArgument(`${slashes}plain`)).toBe(
      `"${slashes}plain"`,
    );
  },
);
test("native Windows arguments preserve empty, spaced and Unicode values", () => {
  for (const arg of ["", "plain", "path with spaces", "非ASCII😀"]) {
    expect(quoteWindowsFixtureArgument(arg)).toBe(`"${arg}"`);
  }
});

windowsTest.each(["measurement", "hard-cap"] as const)(
  "native Windows job %s reports memory and terminates the orphan worker",
  async (mode) => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-job-orphan-"));
    const marker = path.join(directory, "ready");
    const limitBytes = (mode === "hard-cap" ? 512 : 1024) * 1024 ** 2;
    const { child, windowsProcesses } = spawnTestProcess({
      limitBytes,
      command: [
        process.execPath,
        `${import.meta.dir}/test-fixtures/job-launcher-leader.ts`,
        "leader",
        marker,
        ...(mode === "hard-cap" ? ["hard-cap"] : []),
      ],
      options: { stdout: "pipe", stderr: "inherit" },
      onWarning: (message) => {
        throw new TypeError(message);
      },
    });
    let workerPid: number | undefined;
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
      workerPid = worker;
      expect(Result.try(() => process.kill(launcher, 0)).isErr()).toBe(true);
      expect(Result.try(() => process.kill(worker, 0)).isOk()).toBe(true);
      if (mode === "hard-cap") {
        expect(readFileSync(marker, "utf-8")).toBe("rejected");
      }
      const failures: string[] = [];
      const watchdog = watchTestProcessMemory({
        child,
        windowsProcesses,
        limitBytes: mode === "hard-cap" ? limitBytes : 64 * 1024 ** 2,
        intervalMs: 60_000,
        readBytes: () => {
          throw new TypeError("Job must provide memory");
        },
        sampleGroup: () => {
          throw new TypeError("Job must not walk ancestry");
        },
        file: () => "launcher-orphan.test.ts",
        onFailure: (message) => {
          failures.push(message);
        },
        onWarning: (message) => {
          throw new TypeError(message);
        },
      });
      try {
        if (mode === "hard-cap") {
          expect(watchdog.peakBytes()).toBeGreaterThan(0);
          expect(failures.at(0)).toContain(
            "Windows job rejected an allocation",
          );
        } else {
          expect(watchdog.peakBytes()).toBeGreaterThanOrEqual(96 * 1024 ** 2);
        }
        expect(failures).toHaveLength(1);
        await child.exited;
        await waitForExternalState({
          description: `worker ${String(worker)} exits`,
          timeoutMs: 1000,
          read: () => Result.try(() => process.kill(worker, 0)).isErr(),
        });
      } finally {
        await watchdog.stop();
      }
    } finally {
      windowsProcesses?.signal("SIGKILL").unwrap();
      if (workerPid !== undefined) {
        const pid = workerPid;
        Result.try(() => process.kill(pid, "SIGKILL"));
      }
      await child.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

const fakeJobApi = (expectedLimit = 1000) => {
  // Compile the production loader table through Bun itself before faking calls.
  // Type declarations alone cannot establish which ABI types this runtime accepts.
  const callbacks = Object.entries(WINDOWS_JOB_SYMBOLS).map(
    ([name, signature]) => ({
      name,
      signature,
      callback: new JSCallback(() => 0, signature),
    }),
  );
  try {
    const symbols = Object.fromEntries(
      callbacks.map(({ name, signature, callback }) => {
        if (callback.ptr === null) {
          throw new TypeError("Missing ABI callback pointer");
        }
        return [name, { ...signature, ptr: callback.ptr }];
      }),
    );
    const library = linkSymbols(symbols);
    library.close();
  } finally {
    for (const { callback } of callbacks) {
      callback.close();
    }
  }
  let peak = 700;
  let terminated = 0;
  let accounting: "disabled" | "enabled" = "disabled";
  let limit = 0;
  const messages: number[] = [];
  const closed: (number | bigint)[] = [];
  const api = {
    CreateJobObjectW: () => 100n,
    OpenProcess: () => 200n,
    AssignProcessToJobObject: () => 1,
    SetInformationJobObject: (_job, kind, buffer, length) => {
      if (!ArrayBuffer.isView(buffer)) {
        throw new TypeError("Job limit buffer must be a view");
      }
      const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
      if (kind === 7) {
        expect(length).toBe(16);
        return 1;
      }
      expect(kind).toBe(9);
      expect(length).toBe(144);
      const flags = view.getUint32(16, true);
      accounting =
        Math.floor(flags / 0x02_00) % 2 === 1 ? "enabled" : "disabled";
      limit = Number(view.getBigUint64(120, true));
      expect(limit).toBe(expectedLimit);
      expect(Math.floor(flags / 0x20_00) % 2).toBe(1);
      return 1;
    },
    QueryInformationJobObject: (_job, _kind, buffer) => {
      if (!ArrayBuffer.isView(buffer)) {
        throw new TypeError("Job information buffer must be a view");
      }
      new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ).setBigUint64(136, BigInt(accounting === "enabled" ? peak : 0), true);
      return 1;
    },
    TerminateJobObject: () => {
      terminated += 1;
      return 1;
    },
    CloseHandle: (handle) => {
      closed.push(handle);
      return 1;
    },
    CreateIoCompletionPort: () => 300n,
    GetQueuedCompletionStatus: (_port, message) => {
      if (!ArrayBuffer.isView(message)) {
        throw new TypeError("Completion message buffer must be a view");
      }
      const value = messages.shift();
      if (value === undefined) {
        return 0;
      }
      new DataView(
        message.buffer,
        message.byteOffset,
        message.byteLength,
      ).setUint32(0, value, true);
      return 1;
    },
    GetLastError: () => 258,
  } satisfies WindowsJobApi;
  return {
    api,
    closed,
    terminated: () => terminated,
    allocate: () => {
      peak = accounting === "enabled" ? Math.min(900, limit) : 1200;
      if (accounting === "enabled") {
        messages.push(10);
      }
    },
  };
};

test("job peak remains enforceable after the leader and launcher exit, without a PID census", async () => {
  const job = fakeJobApi();
  const owner = createWindowsProcessOwnership(
    { rootPid: 42, limitBytes: 1000 },
    job.api,
  ).unwrap();
  const failures: string[] = [];
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
    windowsProcesses: owner,
    limitBytes: 1000,
    readBytes: () => {
      throw new TypeError("Must measure job");
    },
    sampleGroup: () => {
      throw new TypeError("Must not walk ancestry");
    },
    file: () => "orphan.test.ts",
    onWarning: (message) => {
      throw new TypeError(message);
    },
    onFailure: (message) => {
      failures.push(message);
    },
    intervalMs: 10,
  });
  try {
    expect(watchdog.peakBytes()).toBe(700);
    job.allocate();
    await Bun.sleep(30);
    expect(watchdog.peakBytes()).toBe(900);
    expect(failures).toHaveLength(1);
    expect(job.terminated()).toBe(1);
    expect(job.closed).toEqual([200n, 100n, 300n]);
    expect(owner.signal("SIGKILL").isOk()).toBe(true);
    expect(job.terminated()).toBe(1);
  } finally {
    await watchdog.stop();
    owner.signal("SIGKILL").unwrap();
  }
});

test("job assignment failure stays an error and closes both handles", () => {
  const job = fakeJobApi();
  job.api.AssignProcessToJobObject = () => 0;
  const owner = createWindowsProcessOwnership(
    { rootPid: 42, limitBytes: 1000 },
    job.api,
  );
  expect(owner.isErr()).toBe(true);
  expect(job.closed).toEqual([200n, 100n, 300n]);
});

test("a fractional GiB budget registers as exact integer bytes in Windows job ownership", () => {
  const limitBytes = testInvocationMemoryLimit({
    [TEST_INVOCATION_MEMORY_GIB_ENV]: "0.1",
  });
  expect(limitBytes).toBe(107_374_182);
  const job = fakeJobApi(limitBytes);
  const owner = createWindowsProcessOwnership(
    { rootPid: 42, limitBytes },
    job.api,
  ).unwrap();
  expect(owner.readMemory().unwrap().peakBytes).toBe(700);
  owner.signal("SIGKILL").unwrap();
  expect(job.closed).toEqual([200n, 100n, 300n]);
});
