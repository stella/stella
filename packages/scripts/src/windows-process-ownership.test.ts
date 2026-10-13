import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { watchTestProcessMemory } from "./process-memory";
import { spawnTestProcess } from "./test-process-spawn";
import {
  createWindowsProcessOwnership,
  type WindowsJobApi,
} from "./windows-process-ownership";

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest(
  "job measures and terminates the worker after its intermediate launcher exits before any sample",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-job-orphan-"));
    const { child, windowsProcesses } = spawnTestProcess({
      command: [
        process.execPath,
        `${import.meta.dir}/test-fixtures/job-launcher-leader.ts`,
        "leader",
        path.join(directory, "ready"),
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
      const failures: string[] = [];
      const watchdog = watchTestProcessMemory({
        child,
        windowsProcesses,
        limitBytes: 64 * 1024 ** 2,
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
        expect(watchdog.peakBytes()).toBeGreaterThanOrEqual(96 * 1024 ** 2);
        expect(failures).toHaveLength(1);
        await child.exited;
        for (
          let attempt = 0;
          attempt < 100 && Result.try(() => process.kill(worker, 0)).isOk();
          attempt += 1
        ) {
          await Bun.sleep(10);
        }
        expect(Result.try(() => process.kill(worker, 0)).isErr()).toBe(true);
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

const fakeJobApi = () => {
  let peak = 700;
  let terminated = 0;
  const closed: (number | bigint)[] = [];
  const api = {
    CreateJobObjectW: () => 100n,
    OpenProcess: () => 200n,
    AssignProcessToJobObject: () => 1,
    SetInformationJobObject: (_job, kind, buffer, length) => {
      const view = new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      );
      expect(kind).toBe(9);
      expect(length).toBe(144);
      expect(view.getUint32(16, true)).toBe(0x20_00);
      return 1;
    },
    QueryInformationJobObject: (_job, _kind, buffer) => {
      new DataView(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ).setBigUint64(136, BigInt(peak), true);
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
    GetLastError: () => 5,
  } satisfies WindowsJobApi;
  return {
    api,
    closed,
    terminated: () => terminated,
    allocate: () => {
      peak = 1200;
    },
  };
};

test("job peak remains enforceable after the leader and launcher exit, without a PID census", async () => {
  const job = fakeJobApi();
  const owner = createWindowsProcessOwnership(42, job.api).unwrap();
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
    expect(watchdog.peakBytes()).toBe(1200);
    expect(failures).toHaveLength(1);
    expect(job.terminated()).toBe(1);
    expect(job.closed).toEqual([200n, 100n]);
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
  const owner = createWindowsProcessOwnership(42, job.api);
  expect(owner.isErr()).toBe(true);
  expect(job.closed).toEqual([200n, 100n]);
});
