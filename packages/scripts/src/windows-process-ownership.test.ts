import { Result } from "better-result";
import { expect, test } from "bun:test";

import { attachTestProcessShutdown } from "./process-shutdown";
import {
  createWindowsProcessOwnership,
  parseWindowsCreationTime,
  readWindowsProcessIdentity,
  signalWindowsProcesses,
} from "./windows-process-ownership";

test("Windows creation times preserve all FILETIME digits and reject non-identities", () => {
  const parsed = parseWindowsCreationTime("133700000000000001");
  expect(parsed.isOk()).toBe(true);
  if (parsed.isOk()) {
    expect(parsed.value).toBe(133_700_000_000_000_001n);
  }
  for (const value of ["unknown", "0", "-1", "1.5", "1;exit", ""]) {
    expect(parseWindowsCreationTime(value).isErr()).toBe(true);
  }
});

for (const workerState of ["original", "reused"] as const) {
  test(`disposing after the leader exits retains the ${workerState} worker's original identity`, () => {
    const running = new Map([
      [42, 1n],
      [43, 2n],
    ]);
    const signalled: { pid: number; creationTime: bigint }[] = [];
    const owner = createWindowsProcessOwnership({
      rootPid: 42,
      onWarning: (message) => {
        throw new TypeError(message);
      },
      readIdentity: (pid) => {
        const creationTime = running.get(pid);
        return Result.ok(
          creationTime === undefined ? undefined : { pid, creationTime },
        );
      },
      readTree: () => Result.ok({ identities: [], unavailable: undefined }),
      signalProcesses: ({ identities }) => {
        signalled.push(...identities);
        for (const { pid, creationTime } of identities) {
          if (running.get(pid) === creationTime) {
            running.delete(pid);
          }
        }
        return Result.ok(undefined);
      },
    });
    owner.recordTree([
      { pid: 42, creationTime: 1n },
      { pid: 43, creationTime: 2n },
    ]);
    // Later snapshots cannot forget an orphan or claim a reused root's tree.
    owner.recordTree([{ pid: 42, creationTime: 1n }]);
    owner.recordTree([
      { pid: 42, creationTime: 9n },
      { pid: 44, creationTime: 10n },
    ]);
    running.delete(42);
    if (workerState === "reused") {
      running.set(43, 3n);
    }
    const shutdown = attachTestProcessShutdown({
      child: {
        pid: 42,
        kill: () => {
          throw new TypeError("Must use retained identities");
        },
      },
      termination: "process",
      windowsProcesses: owner,
      onWarning: (message) => {
        throw new TypeError(message);
      },
    });
    shutdown.dispose();
    expect(running.get(43)).toBe(workerState === "reused" ? 3n : undefined);
    expect(signalled).toEqual([
      { pid: 42, creationTime: 1n },
      { pid: 43, creationTime: 2n },
    ]);
  });
}

test("a known spawned worker retains ownership without waiting for a memory sample", () => {
  const signalled: number[] = [];
  const owner = createWindowsProcessOwnership({
    rootPid: 42,
    onWarning: (message) => {
      throw new TypeError(message);
    },
    readIdentity: (pid) => Result.ok({ pid, creationTime: BigInt(pid) }),
    readTree: () => Result.ok({ identities: [], unavailable: undefined }),
    signalProcesses: ({ identities }) => {
      signalled.push(...identities.map(({ pid }) => pid));
      return Result.ok(undefined);
    },
  });
  owner.capturePid(43);
  expect(owner.signal("SIGKILL").isOk()).toBe(true);
  expect(signalled).toEqual([42, 43]);
});

const windowsTest = process.platform === "win32" ? test : test.skip;
windowsTest(
  "a process whose creation time differs survives Windows cleanup",
  async () => {
    const child = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      {
        stdout: "ignore",
        stderr: "inherit",
      },
    );
    try {
      const identity = readWindowsProcessIdentity(child.pid);
      expect(identity.isOk()).toBe(true);
      if (identity.isErr() || identity.value === undefined) {
        throw new TypeError("Fixture process must have an identity");
      }
      const signalled = signalWindowsProcesses({
        rootPid: child.pid,
        identities: [
          { pid: child.pid, creationTime: identity.value.creationTime + 1n },
        ],
        signal: "SIGKILL",
      });
      expect(signalled.isOk()).toBe(true);
      expect(Result.try(() => process.kill(child.pid, 0)).isOk()).toBe(true);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  },
  15_000,
);
