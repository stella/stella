import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { spawnWorker } from "@/api/lib/subprocess";

const FIXTURES_DIR = path.resolve(import.meta.dir, "__fixtures__");
const ECHO_WORKER = path.resolve(FIXTURES_DIR, "echo-worker.ts");
const FAIL_WORKER = path.resolve(FIXTURES_DIR, "fail-worker.ts");
const SLEEP_WORKER = path.resolve(FIXTURES_DIR, "sleep-worker.ts");

describe("spawnWorker", () => {
  test("returns stdout on success", async () => {
    const result = await spawnWorker({
      workerPath: ECHO_WORKER,
      stdin: new Blob(["hello"]),
      timeoutMs: 5000,
    });

    expect(Result.isError(result)).toBe(false);
    if (!Result.isError(result)) {
      expect(result.value.trim()).toBe("hello");
    }
  });

  test("returns error on non-zero exit", async () => {
    const result = await spawnWorker({
      workerPath: FAIL_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 5000,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.exitCode).toBe(1);
    }
  });

  // The class this pins: a caller abort must kill the subprocess, not
  // leave it burning CPU until the hard timeout expires. The fixture
  // sleeps for ten minutes; the call must return in bounded time once
  // the signal fires.
  test("aborting the signal kills the subprocess promptly", async () => {
    const abort = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => abort.abort(), 250);
    const result = await spawnWorker({
      workerPath: SLEEP_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 600_000,
      signal: abort.signal,
    });
    clearTimeout(timer);

    expect(Result.isError(result)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  test("an already-aborted signal refuses to spawn at all", async () => {
    const abort = new AbortController();
    abort.abort();

    expect(
      spawnWorker({
        workerPath: SLEEP_WORKER,
        stdin: new Blob([""]),
        timeoutMs: 600_000,
        signal: abort.signal,
      }),
    ).rejects.toThrow();
  });
});
