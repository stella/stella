import { expect, test } from "bun:test";

import {
  observePostgresTestProcess,
  POSTGRES_LOCK_SNAPSHOT_SQL,
  startLockMonitor,
} from "./postgres-lock-diagnostics";

test("retains the blocked waiter and autovacuum owner after the timeout clears the wait", async () => {
  const blocked = JSON.stringify({
    waiters: [{ pid: 101, blockers: [202] }],
    activity: [{ pid: 202, backend_type: "autovacuum worker" }],
    locks: [{ pid: 202, mode: "ShareUpdateExclusiveLock", granted: true }],
  });
  let unblock = () => {};
  const sampled = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let captures = 0;
  const monitor = startLockMonitor({
    intervalMs: 1,
    capture: async () => {
      captures += 1;
      if (captures === 1) {
        return [{ snapshot: blocked }];
      }
      unblock();
      return [];
    },
  });
  await sampled;
  const report = await monitor.stop();
  expect(report).toContain("autovacuum worker");
  expect(report).toContain("ShareUpdateExclusiveLock");
  expect(report).toContain("101");
  expect(report).toContain("202");
  expect(JSON.parse(report).samples).toEqual([blocked]);
});

test("bounds retained samples and reports catalog failures without rejecting the test outcome", async () => {
  let done = () => {};
  const sampled = new Promise<void>((resolve) => {
    done = resolve;
  });
  let captures = 0;
  const monitor = startLockMonitor({
    intervalMs: 1,
    capture: async () => {
      captures += 1;
      if (captures > 6) {
        done();
        throw new TypeError("catalog unavailable");
      }
      return [{ snapshot: String(captures) }];
    },
  });
  await sampled;
  const report = JSON.parse(await monitor.stop());
  expect(report.samples).toEqual(["3", "4", "5", "6"]);
  expect(report.captureFailure).toContain("catalog unavailable");
});

test("bounds diagnostic output even when a snapshot is oversized", async () => {
  let done = () => {};
  const sampled = new Promise<void>((resolve) => {
    done = resolve;
  });
  const monitor = startLockMonitor({
    intervalMs: 1,
    capture: async () => {
      done();
      return [{ snapshot: "x".repeat(100_000) }];
    },
  });
  await sampled;
  const report = await monitor.stop();
  expect(report.length).toBeLessThanOrEqual(16_384);
  expect(JSON.parse(JSON.parse(report).samples.at(-1)).truncated).toBe(true);
});

test("oversized diagnostics remain readable and keep the newest blocker and capture failure", async () => {
  let done = () => {};
  const sampled = new Promise<void>((resolve) => {
    done = resolve;
  });
  let captures = 0;
  const monitor = startLockMonitor({
    intervalMs: 1,
    capture: async () => {
      captures += 1;
      if (captures === 7) {
        done();
        throw new TypeError("last capture failed");
      }
      return [
        {
          snapshot: JSON.stringify({
            padding: (captures === 6 ? "x" : '"').repeat(
              captures === 6 ? 100_000 : 1900,
            ),
            waiters: [{ pid: captures, blockers: [202] }],
            activity: [{ pid: 202, backend_type: "autovacuum worker" }],
          }),
        },
      ];
    },
  });
  await sampled;
  const report = await monitor.stop();
  expect(report.length).toBeLessThanOrEqual(16_384);
  const parsed = JSON.parse(report);
  expect(parsed.captureFailure).toContain("last capture failed");
  const newest = JSON.parse(parsed.samples.at(-1));
  expect(newest.waiters).toEqual([{ pid: 6, blockers: [202] }]);
  expect(newest.activity).toContainEqual({
    pid: 202,
    backend_type: "autovacuum worker",
  });
  expect(newest.truncated).toBe(true);
});

test("the bounded live snapshot selects actual waiters, blocking pids, activity and locks", () => {
  expect(POSTGRES_LOCK_SNAPSHOT_SQL).toContain("pg_blocking_pids(pid)");
  expect(POSTGRES_LOCK_SNAPSHOT_SQL).toContain("wait_event_type = 'Lock'");
  expect(POSTGRES_LOCK_SNAPSHOT_SQL).toContain("backend_type");
  expect(POSTGRES_LOCK_SNAPSHOT_SQL).toContain("FROM pg_locks");
  expect(POSTGRES_LOCK_SNAPSHOT_SQL).toContain("LIMIT 8");
  expect(POSTGRES_LOCK_SNAPSHOT_SQL).toContain("LIMIT 24");
  expect(POSTGRES_LOCK_SNAPSHOT_SQL).toContain("LIMIT 64");
});

test("streaming preserves output and status and prints diagnostics only for failed lock timeouts", async () => {
  for (const { status, code } of [
    { status: 7, code: "55P03" },
    { status: 0, code: "55P03" },
    { status: 7, code: "40P01" },
  ]) {
    let finish = (_status: number) => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const encoder = new TextEncoder();
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode("test output\n"));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode(code.slice(0, 3)));
        controller.enqueue(encoder.encode(code.slice(3)));
        controller.close();
      },
    });
    let out = "";
    let err = "";
    const reports: string[] = [];
    const observed = await observePostgresTestProcess({
      child: { exited, stdout, stderr },
      intervalMs: 1,
      capture: async () => {
        finish(status);
        return [{ snapshot: '{"waiters":[{"pid":101,"blockers":[202]}]}' }];
      },
      writeStdout: (chunk) => {
        out += new TextDecoder().decode(chunk);
      },
      writeStderr: (chunk) => {
        err += new TextDecoder().decode(chunk);
      },
      reportFailure: (report) => {
        reports.push(report);
      },
    });
    expect(observed).toBe(status);
    expect(out).toBe("test output\n");
    expect(err).toBe(code);
    expect(reports).toHaveLength(status !== 0 && code === "55P03" ? 1 : 0);
    if (reports.length > 0) {
      expect(reports.at(0)).toContain("101");
      expect(reports.at(0)).toContain("202");
    }
  }
});
