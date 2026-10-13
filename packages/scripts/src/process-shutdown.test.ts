import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { attachTestProcessShutdown } from "./process-shutdown";
import { spawnTestProcess } from "./test-process-spawn";

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const) {
  test(`runner ${signal} reaps its test child and long-lived worker`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "stella-shutdown-test-"));
    const marker = path.join(directory, "signal");
    const parent = Bun.spawn(
      [
        process.execPath,
        `${import.meta.dir}/test-fixtures/signal-cleanup-parent.ts`,
        marker,
        signal,
      ],
      {
        stdout: "pipe",
        stderr: "inherit",
        stdin: "pipe",
      },
    );
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const reader = parent.stdout.getReader();
      const ready = await reader.read();
      [childPid, grandchildPid] = new TextDecoder()
        .decode(ready.value)
        .trim()
        .split(/\s+/u)
        .map(Number);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(childPid).toBeGreaterThan(1);
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      expect(grandchildPid).toBeGreaterThan(1);
      if (signal !== "exit") {
        if (process.platform === "win32") {
          await parent.stdin.write(`${signal}\n`);
          await parent.stdin.end();
        } else {
          parent.kill(signal);
        }
      }
      await parent.exited;
      if (signal === "exit") {
        expect(parent.exitCode).toBe(23);
      } else {
        expect(parent.exitCode).toBe(SIGNAL_EXIT_CODES[signal]);
        if (process.platform !== "win32") {
          expect(readFileSync(marker, "utf-8")).toBe(signal);
          expect(readFileSync(`${marker}.grandchild`, "utf-8")).toBe(signal);
        }
      }
      // The parent's exit and the kernel's child reap notification can differ by a tick.
      await Bun.sleep(50);
      for (const pid of [childPid, grandchildPid]) {
        if (pid === undefined) {
          throw new TypeError("Fixture readiness must contain both PIDs");
        }
        const alive = Result.try(() => process.kill(pid, 0));
        const status =
          process.platform === "linux"
            ? Result.try(() => readFileSync(`/proc/${pid}/status`, "utf-8"))
            : undefined;
        const zombie = status?.isOk() && /^State:\s+Z\b/mu.test(status.value);
        expect(alive.isErr() || zombie).toBe(true);
      }
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill("SIGKILL");
        await parent.exited;
      }
      if (
        childPid !== undefined &&
        Number.isSafeInteger(childPid) &&
        childPid > 1
      ) {
        if (process.platform === "win32") {
          Bun.spawnSync(["taskkill.exe", "/PID", String(childPid), "/T", "/F"]);
          if (grandchildPid !== undefined) {
            Bun.spawnSync([
              "taskkill.exe",
              "/PID",
              String(grandchildPid),
              "/T",
              "/F",
            ]);
          }
        } else {
          const ownedGroupPid = childPid;
          Result.try(() => process.kill(-ownedGroupPid, "SIGKILL"));
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
}

test("disposing shutdown ownership removes its listeners and signals cleanup only once", async () => {
  const events = ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const;
  const previous = events.map((event) => process.listenerCount(event));
  const signals: (number | NodeJS.Signals | undefined)[] = [];
  const { child, windowsProcesses } = spawnTestProcess({
    command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    options: {
      stdout: "ignore",
      stderr: "inherit",
    },
    onWarning: (message) => {
      throw new TypeError(message);
    },
  });
  const shutdown = attachTestProcessShutdown({
    windowsProcesses,
    child: {
      pid: child.pid,
      kill: (signal) => {
        signals.push(signal);
        child.kill(signal);
      },
    },
    termination: "process",
    onWarning: (message) => {
      throw new TypeError(message);
    },
  });
  expect(events.map((event) => process.listenerCount(event))).toEqual(
    previous.map((count) => count + 1),
  );
  shutdown.dispose();
  shutdown.dispose();
  expect(events.map((event) => process.listenerCount(event))).toEqual(previous);
  await child.exited;
  expect(signals).toEqual(process.platform === "win32" ? [] : ["SIGKILL"]);
});

test("cleanup of an already exited test process does not warn", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "inherit",
  });
  await child.exited;
  const warnings: string[] = [];
  const shutdown = attachTestProcessShutdown({
    child,
    termination: "process",
    onWarning: (message) => {
      warnings.push(message);
    },
  });
  shutdown.dispose();
  expect(warnings).toEqual([]);
});

test("disposing after the test leader exits immediately reaps its surviving long-lived worker", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-orphan-test-"));
  const parent = Bun.spawn(
    [
      process.execPath,
      `${import.meta.dir}/test-fixtures/orphan-cleanup-parent.ts`,
      path.join(directory, "signal"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  let workerPid: number | undefined;
  try {
    const ready = await parent.stdout.getReader().read();
    const [leaderPid, worker] = new TextDecoder()
      .decode(ready.value)
      .trim()
      .split(/\s+/u)
      .map(Number);
    if (
      leaderPid === undefined ||
      worker === undefined ||
      !Number.isSafeInteger(leaderPid) ||
      leaderPid <= 1 ||
      !Number.isSafeInteger(worker) ||
      worker <= 1
    ) {
      throw new TypeError("Fixture readiness must contain both PIDs");
    }
    workerPid = worker;
    // The original root is already gone, but the worker still owns a live process.
    expect(Result.try(() => process.kill(leaderPid, 0)).isErr()).toBe(true);
    expect(Result.try(() => process.kill(worker, 0)).isOk()).toBe(true);
    await parent.stdin.end();
    await parent.exited;
    expect(parent.exitCode).toBe(0);
    await Bun.sleep(50);
    const alive = Result.try(() => process.kill(worker, 0));
    const status =
      process.platform === "linux"
        ? Result.try(() => readFileSync(`/proc/${worker}/status`, "utf-8"))
        : undefined;
    const zombie = status?.isOk() && /^State:\s+Z\b/mu.test(status.value);
    expect(alive.isErr() || zombie).toBe(true);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGKILL");
      await parent.exited;
    }
    if (workerPid !== undefined) {
      const ownedPid = workerPid;
      Result.try(() => process.kill(ownedPid, "SIGKILL"));
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
