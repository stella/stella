import { panic } from "better-result";
import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Per-test temporary directories. Every directory is unique to one test,
 * lives under the system temp root, and is removed when the test ends, so no
 * test reads another's files or leaves state for the next run.
 */

export type TestTmpDir = {
  readonly path: string;
  /** A path inside the directory; refuses to escape it. */
  join: (...segments: string[]) => string;
  remove: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

const safePrefix = (prefix: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/u.test(prefix)) {
    panic(`Temp dir prefix must be short kebab-case: ${prefix}`);
  }
  return prefix;
};

/** Creates a fresh directory; `await using` removes it at scope exit. */
export const createTestTmpDir = async (
  prefix = "stll-test",
): Promise<TestTmpDir> => {
  const root = await mkdtemp(
    path.join(tmpdir(), `${safePrefix(prefix)}-${process.pid}-`),
  );
  let removed = false;
  const remove = async () => {
    if (removed) {
      return;
    }
    removed = true;
    await rm(root, { force: true, recursive: true });
  };
  return {
    path: root,
    join: (...segments) => {
      const joined = path.resolve(root, ...segments);
      if (joined !== root && !joined.startsWith(`${root}${path.sep}`)) {
        panic(`Path escapes the test temp dir: ${segments.join("/")}`);
      }
      return joined;
    },
    remove,
    [Symbol.asyncDispose]: remove,
  };
};

/** Runs `body` with a fresh directory and removes it afterwards. */
export const withTestTmpDir = async <T>(
  body: (dir: TestTmpDir) => T | Promise<T>,
  prefix?: string,
): Promise<T> => {
  await using dir = await createTestTmpDir(prefix);
  return await body(dir);
};

export type TestTmpDirSlot = {
  open: () => Promise<void>;
  close: () => Promise<void>;
  current: () => TestTmpDir;
};

/**
 * One directory at a time. Hooks have no per-test identity, so a second
 * `open` before `close` (tests running concurrently) is refused rather than
 * letting two tests share or delete each other's directory.
 */
export const createTestTmpDirSlot = (prefix?: string): TestTmpDirSlot => {
  let state: "closed" | "opening" | { dir: TestTmpDir } = "closed";
  // A refused open is still followed by its test's close; that close must not
  // remove the directory the running test is using.
  let refused = 0;
  return {
    open: async () => {
      if (state !== "closed") {
        refused += 1;
        panic(
          "useTestTmpDir serves one test at a time; concurrent tests use withTestTmpDir",
        );
      }
      state = "opening";
      state = { dir: await createTestTmpDir(prefix) };
    },
    close: async () => {
      if (refused > 0) {
        refused -= 1;
        return;
      }
      const open = state;
      state = "closed";
      if (typeof open === "object") {
        await open.dir.remove();
      }
    },
    current: () =>
      typeof state === "object"
        ? state.dir
        : panic("The test temp dir exists only while a test runs"),
  };
};

/**
 * Registers a fresh directory for every test in the calling file or describe
 * block. Read it inside a test through the returned accessor. Serial tests
 * only; a concurrent test uses `withTestTmpDir`.
 */
export const useTestTmpDir = (prefix?: string): (() => TestTmpDir) => {
  const slot = createTestTmpDirSlot(prefix);
  beforeEach(slot.open);
  afterEach(slot.close);
  return slot.current;
};
