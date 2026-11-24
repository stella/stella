import { panic } from "better-result";
import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

// Bun's per-test timeout is a timer on the test's own event loop, so a test
// that never yields (an endless synchronous loop, a microtask chain that never
// lets a task run, a blocking native call) is never interrupted: the process
// spins until the job is cancelled and starves every task running beside it.
// The watchdog thread pings the event loop and kills the process once no ping
// has been answered for this long.
//
// Measured on 20 green merge-group `ci-tests (rest-web)` runs: the longest
// silent stretch of any package's test output was 25.4 s outside one async
// wait (150 s, its event loop still turning). A blocked event loop is always
// silent, so no correct test blocked it longer than 25.4 s.
export const TEST_EVENT_LOOP_BLOCK_LIMIT_MS = 60_000;
export const TEST_EVENT_LOOP_PING_MS = 1000;

// Tests of the watchdog lower the limit so a spinning child is caught fast.
// It can only tighten the bound, never widen it.
export const TEST_EVENT_LOOP_BLOCK_LIMIT_ENV =
  "STELLA_TEST_EVENT_LOOP_BLOCK_LIMIT_MS";

// scripts/ci-failure-digest.ts matches this prefix; its test binds the two.
export const EVENT_LOOP_BLOCKED_MARKER = "Test event loop blocked:";

export const testEventLoopBlockLimitMs = (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const value = environment[TEST_EVENT_LOOP_BLOCK_LIMIT_ENV];
  if (value === undefined) {
    return TEST_EVENT_LOOP_BLOCK_LIMIT_MS;
  }
  const limit = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (
    !Number.isSafeInteger(limit) ||
    limit < TEST_EVENT_LOOP_PING_MS ||
    limit > TEST_EVENT_LOOP_BLOCK_LIMIT_MS
  ) {
    return panic(
      `${TEST_EVENT_LOOP_BLOCK_LIMIT_ENV} must be an integer from ${TEST_EVENT_LOOP_PING_MS} to ${TEST_EVENT_LOOP_BLOCK_LIMIT_MS}`,
    );
  }
  return limit;
};

type EventLoopState =
  | { readonly type: "turning" }
  | { readonly type: "blocked"; readonly blockedMs: number };

/** Tracks the last answered ping; time is passed in, never read. */
export const createEventLoopBlockDetector = ({
  limitMs,
  startedAt,
}: {
  readonly limitMs: number;
  readonly startedAt: number;
}) => {
  let answeredAt = startedAt;
  return {
    answered: (now: number) => {
      answeredAt = Math.max(answeredAt, now);
    },
    state: (now: number): EventLoopState => {
      const blockedMs = now - answeredAt;
      return blockedMs >= limitMs
        ? { type: "blocked", blockedMs }
        : { type: "turning" };
    },
  };
};

/** `ps -A -o pid=,ppid=` rows as child lists per parent. */
export const parseProcessParents = (output: string) => {
  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length !== 2) {
      continue;
    }
    const [pid, parent] = columns.map(Number);
    if (
      pid === undefined ||
      parent === undefined ||
      !Number.isSafeInteger(pid) ||
      !Number.isSafeInteger(parent)
    ) {
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  return children;
};

/** Every descendant of `root`, children before their own children. */
export const descendantPids = (
  root: number,
  children: ReadonlyMap<number, readonly number[]>,
): readonly number[] => {
  const found: number[] = [];
  const seen = new Set([root]);
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of children.get(pid) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
};

/**
 * The file of the last test that started, from Bun.main; undefined before the
 * first test. A block while the next file loads still names the previous
 * file, so the message says "last test started in".
 */
export const lastTestFile = (main: string, cwd: string) => {
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(main)) {
    return undefined;
  }
  return isPathInside(cwd, main)
    ? repoRelativePath(cwd, main)
    : main.replaceAll(path.sep, "/");
};

export const eventLoopBlockedMessage = ({
  file,
  blockedMs,
  pid,
  descendants,
}: {
  readonly file: string | undefined;
  readonly blockedMs: number;
  readonly pid: number;
  readonly descendants: number;
}) =>
  `${EVENT_LOOP_BLOCKED_MARKER} no event-loop task ran for ${Math.round(blockedMs / 1000)} s, so Bun's per-test timeout could not fire; ${file === undefined ? "no test had started" : `last test started in ${file}`}; killed bun test PID ${pid} and ${descendants} child ${descendants === 1 ? "process" : "processes"}`;
