import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildHeavyTypecheckLockArgv,
  runHeavyTypecheckWithLock,
} from "./heavy-typecheck-lock";

const command = ["bun", "run", "typecheck"];
const lockPath = "/tmp/stella-heavy-typecheck.lock";
const acquiredCommand = [
  "/bin/sh",
  "-c",
  'printf "heavy-typecheck-lock: acquired host lock\\n"; export STELLA_HEAVY_TYPECHECK_LOCK_HELD=1; exec "$@"',
  "heavy-typecheck-lock",
  ...command,
];

test("macOS uses lockf with the bounded host lock", () => {
  expect(
    buildHeavyTypecheckLockArgv({
      command,
      lockPath,
      platform: "darwin",
      toolExists: (filename) => filename === "/usr/bin/lockf",
    }),
  ).toEqual([
    "/usr/bin/lockf",
    "-k",
    "-t",
    "1800",
    lockPath,
    ...acquiredCommand,
  ]);
});

test("Linux uses flock with a distinct timeout status", () => {
  expect(
    buildHeavyTypecheckLockArgv({
      command,
      lockPath,
      platform: "linux",
      toolExists: (filename) => filename === "/usr/bin/flock",
    }),
  ).toEqual([
    "/usr/bin/flock",
    "-E",
    "75",
    "-w",
    "1800",
    lockPath,
    ...acquiredCommand,
  ]);
});

test("a host without a system lock tool runs the command directly", () => {
  expect(
    buildHeavyTypecheckLockArgv({
      command,
      lockPath,
      platform: "other",
      toolExists: () => false,
    }),
  ).toEqual(command);
});

test("a second process starts its command only after the first releases the lock", async () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "heavy-typecheck-lock-"),
  );
  const sharedLock = path.join(directory, "lock");
  const events = path.join(directory, "events");
  try {
    const first = runHeavyTypecheckWithLock({
      command: [
        "/bin/sh",
        "-c",
        `printf 'first-start\\n' >> "$1"; sleep 0.3; printf 'first-end\\n' >> "$1"`,
        "holder",
        events,
      ],
      lockPath: sharedLock,
      waitSeconds: 5,
    });
    // real-time: the assertion exercises contention between OS child processes.
    await Bun.sleep(75);
    const second = runHeavyTypecheckWithLock({
      command: [
        "/bin/sh",
        "-c",
        `printf 'second-start\\n' >> "$1"`,
        "holder",
        events,
      ],
      lockPath: sharedLock,
      waitSeconds: 5,
    });
    expect(await first).toEqual({ type: "completed", exitCode: 0 });
    expect(await second).toEqual({ type: "completed", exitCode: 0 });
    expect(await Bun.file(events).text()).toBe(
      "first-start\nfirst-end\nsecond-start\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lock contention returns the typed wait-timeout result", async () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "heavy-typecheck-lock-"),
  );
  const sharedLock = path.join(directory, "lock");
  try {
    const holder = runHeavyTypecheckWithLock({
      command: ["sleep", "2"],
      lockPath: sharedLock,
      waitSeconds: 5,
    });
    // real-time: the system lock must be acquired before testing its timeout.
    await Bun.sleep(75);
    const waiting = await runHeavyTypecheckWithLock({
      command: ["true"],
      lockPath: sharedLock,
      waitSeconds: 1,
    });
    expect(waiting).toEqual({ type: "wait-timeout", waitSeconds: 1 });
    expect(await holder).toEqual({ type: "completed", exitCode: 0 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
