import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  cleanupCapability,
  cleanupFlakeTrial,
  FLAKE_GATE_TRIAL_ENV,
  runFlakeProcess,
} from "./flake-gate-process";
import { createRustTestListing } from "./flake-gate-rust";

test("streamed Cargo discovery retains names older than the diagnostic output tail", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flake-listing-stream-"));
  try {
    const listing = createRustTestListing("feature");
    const outcome = await runFlakeProcess({
      command: [
        process.execPath,
        "-e",
        String.raw`process.stdout.write("feature::first: test\n"); for (let i=0;i<10000;i++) process.stdout.write("other_feature::name_" + i + ": test\n");`,
      ],
      cwd: directory,
      env: {},
      deadline: performance.now() + 5000,
      onStdoutLine: listing.acceptLine,
    });
    expect(outcome.type).toBe("completed");
    if (outcome.type !== "completed") {
      throw new TypeError("Expected completed listing");
    }
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).not.toContain("feature::first");
    expect(listing.batches()).toEqual([["feature::first"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a listing parser failure drains its process before reporting the explicit error", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flake-listing-error-"));
  try {
    const failure = await rejectionOf(
      runFlakeProcess({
        command: [
          process.execPath,
          "-e",
          'console.log("x".repeat(70000)); await Bun.sleep(20); await Bun.write("finished", "yes");',
        ],
        cwd: directory,
        env: {},
        deadline: performance.now() + 5000,
        onStdoutLine: () => {},
      }),
    );
    expect(failure).toMatchObject({
      message: "Flake listing contains an oversized line",
    });
    expect(await Bun.file(path.join(directory, "finished")).text()).toBe("yes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

type ChildRecord = { pid: number; port: number };

const readRecord = async (file: string): Promise<ChildRecord> => {
  const value: unknown = JSON.parse(await readFile(file, "utf-8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !("port" in value) ||
    typeof value.port !== "number"
  ) {
    throw new TypeError("Detached fixture did not record its process and port");
  }
  return { pid: value.pid, port: value.port };
};

const processGoneOrZombie = async (pid: number) => {
  const status = await Result.tryPromise({
    try: async () => await readFile(`/proc/${pid}/status`, "utf-8"),
    catch: (error) => error,
  });
  if (status.isErr()) {
    const error = status.error;
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
  return /^State:\s+Z\b/mu.test(status.value);
};

const portCanBind = async (port: number) => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
};

const addProcEnvironment = (
  procRoot: string,
  pid: number,
  entries: string[],
) => {
  const directory = path.join(procRoot, String(pid));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "environ"), `${entries.join("\0")}\0`);
};

const compareSignal = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
const expectedSignals = ["SIGSTOP", "SIGKILL"] as const;

test("Linux cleanup finds reparented exact-token owners and ignores near matches", async () => {
  const procRoot = await mkdtemp(path.join(tmpdir(), "flake-gate-proc-"));
  const token = "trial-token";
  const rootPid = process.pid + 100;
  const owned = [rootPid + 1, rootPid + 2];
  const signalled: { pid: number; signal: NodeJS.Signals }[] = [];
  for (const pid of owned) {
    addProcEnvironment(procRoot, pid, [
      `PATH=/bin`,
      `${FLAKE_GATE_TRIAL_ENV}=${token}`,
    ]);
  }
  addProcEnvironment(procRoot, rootPid + 3, [
    `OTHER=${FLAKE_GATE_TRIAL_ENV}=${token}`,
  ]);
  addProcEnvironment(procRoot, rootPid + 4, [
    `${FLAKE_GATE_TRIAL_ENV}=${token}-other`,
  ]);
  try {
    const result = await cleanupFlakeTrial({
      rootPid,
      token,
      platform: "linux",
      procRoot,
      signal: (pid, signal) => {
        signalled.push({ pid, signal });
        if (signal === "SIGKILL") {
          rmSync(path.join(procRoot, String(pid)), { recursive: true });
        }
      },
    });
    expect(result).toEqual({
      type: "linux-proc-token",
      note: "cleanup: Linux /proc trial ownership",
    });
    expect(
      signalled.toSorted(
        (left, right) =>
          left.pid - right.pid || compareSignal(left.signal, right.signal),
      ),
    ).toEqual(
      owned
        .flatMap((pid) => expectedSignals.map((signal) => ({ pid, signal })))
        .toSorted(
          (left, right) =>
            left.pid - right.pid || compareSignal(left.signal, right.signal),
        ),
    );
  } finally {
    await rm(procRoot, { recursive: true, force: true });
  }
});

test("Linux cleanup errors when token-owned PIDs persist through its bounded passes", async () => {
  const procRoot = await mkdtemp(path.join(tmpdir(), "flake-gate-proc-"));
  const token = "stuck-trial";
  const rootPid = process.pid + 200;
  addProcEnvironment(procRoot, rootPid + 1, [
    `${FLAKE_GATE_TRIAL_ENV}=${token}`,
  ]);
  try {
    const error = await rejectionOf(
      cleanupFlakeTrial({
        rootPid,
        token,
        platform: "linux",
        procRoot,
        signal: () => {},
      }),
    );
    expect(error).toMatchObject({
      message: "Trial-owned processes remain after bounded Linux cleanup",
    });
  } finally {
    await rm(procRoot, { recursive: true, force: true });
  }
});

test("cleanup metadata names Linux ownership and the best-effort fallback", () => {
  expect(cleanupCapability("linux")).toEqual({
    type: "linux-proc-token",
    note: "cleanup: Linux /proc trial ownership",
  });
  expect(cleanupCapability("darwin")).toEqual({
    type: "best-effort",
    platform: "darwin",
    note: "cleanup: best-effort",
  });
});

test.skipIf(process.platform !== "linux")(
  process.platform === "linux"
    ? "Linux token cleanup kills a detached pipe and socket owner after the runner exits"
    : "Linux detached-owner cleanup (skipped: requires Linux /proc)",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "flake-gate-process-"));
    const recordFile = path.join(directory, "child.json");
    const childSource = `
      const { createServer } = require('node:net');
      const { writeFileSync } = require('node:fs');
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        writeFileSync(process.env.FLAKE_CHILD_RECORD, JSON.stringify({ pid: process.pid, port: server.address().port }));
      });
      setTimeout(() => process.exit(0), 5000);
    `;
    const runnerSource = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
      });
      child.unref();
    `;
    let record: ChildRecord | undefined;
    let cleanupFailure: unknown;
    try {
      const outcome = await runFlakeProcess({
        cwd: directory,
        command: [process.execPath, "-e", runnerSource],
        env: { FLAKE_CHILD_RECORD: recordFile },
        deadline: performance.now() + 700,
      });
      expect(outcome).toEqual({ type: "timeout" });
      record = await readRecord(recordFile);
      expect(await processGoneOrZombie(record.pid)).toBe(true);
      await portCanBind(record.port);
    } finally {
      if (!record && (await Bun.file(recordFile).exists())) {
        record = await readRecord(recordFile);
      }
      if (record) {
        const { pid } = record;
        const killed = Result.try({
          try: () => process.kill(pid, "SIGKILL"),
          catch: (error) => error,
        });
        if (killed.isErr()) {
          const error = killed.error;
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          )) {
            cleanupFailure = error;
          }
        }
      }
      const removed = await Result.tryPromise({
        try: async () => await rm(directory, { recursive: true, force: true }),
        catch: (error) => error,
      });
      if (removed.isErr()) {
        cleanupFailure ??= removed.error;
      }
    }
    expect(cleanupFailure).toBeUndefined();
  },
);
