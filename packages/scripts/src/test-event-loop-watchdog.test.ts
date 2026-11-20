import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createEventLoopBlockDetector,
  descendantPids,
  EVENT_LOOP_BLOCKED_MARKER,
  eventLoopBlockedMessage,
  lastTestFile,
  parseProcessParents,
  TEST_EVENT_LOOP_BLOCK_LIMIT_ENV,
  TEST_EVENT_LOOP_BLOCK_LIMIT_MS,
  TEST_EVENT_LOOP_PING_MS,
  testEventLoopBlockLimitMs,
} from "./test-event-loop-watchdog-policy";

const PRELOAD = path.join(import.meta.dir, "test-event-loop-watchdog.ts");

test("the loop counts as blocked from the limit on, measured from the last answer", () => {
  const detector = createEventLoopBlockDetector({
    limitMs: 60_000,
    startedAt: 1000,
  });
  expect(detector.state(60_999)).toEqual({ type: "turning" });
  expect(detector.state(61_000)).toEqual({
    type: "blocked",
    blockedMs: 60_000,
  });
  detector.answered(61_000);
  expect(detector.state(120_999)).toEqual({ type: "turning" });
  // An answer stamped out of order never moves the last answer back.
  detector.answered(5000);
  expect(detector.state(121_000)).toEqual({
    type: "blocked",
    blockedMs: 60_000,
  });
});

test("the limit can be lowered for a watchdog test but never raised", () => {
  expect(testEventLoopBlockLimitMs({})).toBe(TEST_EVENT_LOOP_BLOCK_LIMIT_MS);
  expect(
    testEventLoopBlockLimitMs({ [TEST_EVENT_LOOP_BLOCK_LIMIT_ENV]: "2000" }),
  ).toBe(2000);
  for (const value of [
    String(TEST_EVENT_LOOP_BLOCK_LIMIT_MS + 1),
    String(TEST_EVENT_LOOP_PING_MS - 1),
    "1e4",
    "-5",
    "",
  ]) {
    expect(() =>
      testEventLoopBlockLimitMs({ [TEST_EVENT_LOOP_BLOCK_LIMIT_ENV]: value }),
    ).toThrow(TEST_EVENT_LOOP_BLOCK_LIMIT_ENV);
  }
});

test("descendants cover the whole tree under the test process and nothing else", () => {
  // The last row closes a cycle through PID reuse; the walk still ends.
  const children = parseProcessParents(
    [
      " 10     1",
      " 11    10",
      " 12    11",
      " 13    10",
      " 14     1",
      "garbage",
      "",
      " 10    12",
    ].join("\n"),
  );
  expect(descendantPids(10, children).toSorted()).toEqual([11, 12, 13]);
  expect(descendantPids(14, children)).toEqual([]);
});

test("the last test file is named relative to the package, and setup code is no file", () => {
  const cwd = path.join(path.sep, "repo", "packages", "ui");
  expect(
    lastTestFile(path.join(cwd, "src", "settings.dom.test.tsx"), cwd),
  ).toBe("src/settings.dom.test.tsx");
  expect(lastTestFile(path.join(cwd, "src", "setup.ts"), cwd)).toBeUndefined();
  const outside = path.join(path.sep, "elsewhere", "a.test.ts");
  expect(lastTestFile(outside, cwd)).toBe(outside.replaceAll(path.sep, "/"));
});

test("the kill message starts with the marker the CI failure digest reads", () => {
  const message = eventLoopBlockedMessage({
    file: "src/a.test.ts",
    blockedMs: 60_400,
    pid: 42,
    descendants: 1,
  });
  expect(message.startsWith(`${EVENT_LOOP_BLOCKED_MARKER} `)).toBe(true);
  expect(message).toContain("for 60 s");
  expect(message).toContain("last test started in src/a.test.ts");
  expect(message).toContain("PID 42 and 1 child process");
  expect(
    eventLoopBlockedMessage({
      file: undefined,
      blockedMs: 60_000,
      pid: 42,
      descendants: 0,
    }),
  ).toContain("no test had started");
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type FixtureRun = {
  readonly signalCode: NodeJS.Signals | null;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

const runFixture = async (source: string): Promise<FixtureRun> => {
  const directory = mkdtempSync(path.join(tmpdir(), "event-loop-watchdog-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "fixture.test.ts"), source);
  // CI preloads the flaky-test quarantine through BUN_OPTIONS; the fixture
  // run loads only the watchdog.
  const { BUN_OPTIONS: _options, ...environment } = process.env;
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--preload",
      PRELOAD,
      "--timeout",
      "30000",
      "./fixture.test.ts",
    ],
    {
      cwd: directory,
      env: { ...environment, [TEST_EVENT_LOOP_BLOCK_LIMIT_ENV]: "2000" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    signalCode: child.signalCode,
    exitCode: child.exitCode,
    stderr,
    stdout,
  };
};

// timeout: spawns a bun test run that the watchdog stops after its 2 s limit.
test("a test that never yields is killed and named, with the processes it spawned", async () => {
  const run = await runFixture(`
      import { test } from "bun:test";
      test("spins", () => {
        const child = Bun.spawn(["sleep", "600"]);
        console.log("child " + child.pid);
        for (;;) {}
      });
    `);
  expect(run.signalCode).toBe("SIGKILL");
  expect(run.stderr).toContain(EVENT_LOOP_BLOCKED_MARKER);
  expect(run.stderr).toContain("last test started in fixture.test.ts");
  expect(run.stderr).toContain("and 1 child process");
  const childPid = Number(/child (\d+)/u.exec(run.stdout)?.at(1));
  expect(Number.isSafeInteger(childPid)).toBe(true);
  // The spawned sleep is gone, or dead and not yet reaped by its new parent.
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(childPid)])
    .stdout.toString()
    .trim();
  expect(state === "" || state.startsWith("Z")).toBe(true);
}, 30_000);

// timeout: spawns a bun test run that waits past the watchdog's 2 s limit.
test("a test waiting longer than the limit under fake timers keeps its loop turning", async () => {
  const run = await runFixture(`
      import { expect, jest, test } from "bun:test";
      test("waits", async () => {
        jest.useFakeTimers();
        try {
          // A process exit is not a timer, so fake timers cannot hold it.
          expect(await Bun.spawn(["sleep", "4"]).exited).toBe(0);
        } finally {
          jest.useRealTimers();
        }
      });
    `);
  expect(run.stderr).not.toContain(EVENT_LOOP_BLOCKED_MARKER);
  expect(run.exitCode).toBe(0);
}, 30_000);
