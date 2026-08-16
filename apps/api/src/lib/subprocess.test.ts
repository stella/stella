import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  SubprocessError,
  SUBPROCESS_TERMINATION_REASON,
} from "@/api/lib/errors/tagged-errors";
import {
  classifySubprocessTermination,
  spawnBinaryWorker,
  spawnWorker,
} from "@/api/lib/subprocess";

const FIXTURES_DIR = path.resolve(import.meta.dir, "__fixtures__");
const ECHO_WORKER = path.resolve(FIXTURES_DIR, "echo-worker.ts");
const FAIL_WORKER = path.resolve(FIXTURES_DIR, "fail-worker.ts");
const SIGTERM_WORKER = path.resolve(FIXTURES_DIR, "sigterm-worker.ts");
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

  test("returns SubprocessError on non-zero exit", async () => {
    const result = await spawnWorker({
      workerPath: FAIL_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 5000,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(SubprocessError);
      if (result.error instanceof SubprocessError) {
        expect(result.error.exitCode).toBe(1);
      }
    }
  });

  test("classifies the timeout kill as a timeout termination", async () => {
    const result = await spawnWorker({
      workerPath: SLEEP_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 500,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(SubprocessError);
      expect(result.error.termination).toEqual({
        reason: SUBPROCESS_TERMINATION_REASON.timeout,
        signalCode: "SIGTERM",
      });
    }
  });

  test("classifies a self-termination as an external termination", async () => {
    const result = await spawnWorker({
      workerPath: SIGTERM_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 30_000,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(SubprocessError);
      expect(result.error.termination).toEqual({
        reason: SUBPROCESS_TERMINATION_REASON.external,
        signalCode: "SIGTERM",
      });
    }
  });

  test("classifies a fatal signal as a crash", () => {
    expect(
      classifySubprocessTermination({
        callerAbort: false,
        signalCode: "SIGABRT",
        timeoutAbort: false,
      }),
    ).toBe(SUBPROCESS_TERMINATION_REASON.crashed);
  });

  // The class this pins: a caller abort must kill the subprocess, not
  // leave it burning CPU until the hard timeout expires. The fixture
  // sleeps for ten minutes; the call must return in bounded time once
  // the signal fires.
  test("classifies caller cancellation and kills the subprocess promptly", async () => {
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
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(SubprocessError);
      expect(result.error.termination?.reason).toBe(
        SUBPROCESS_TERMINATION_REASON.cancelled,
      );
    }
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
    ).rejects.toThrow("The operation was aborted.");
  });
});

describe("spawnBinaryWorker", () => {
  test("classifies the timeout kill as a timeout termination", async () => {
    const result = await spawnBinaryWorker({
      workerPath: SLEEP_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 500,
      maxOutputBytes: 1024,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(SubprocessError);
      expect(result.error.termination).toEqual({
        reason: SUBPROCESS_TERMINATION_REASON.timeout,
        signalCode: "SIGTERM",
      });
    }
  });

  test("classifies a self-termination as an external termination", async () => {
    const result = await spawnBinaryWorker({
      workerPath: SIGTERM_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(SubprocessError);
      expect(result.error.termination).toEqual({
        reason: SUBPROCESS_TERMINATION_REASON.external,
        signalCode: "SIGTERM",
      });
    }
  });
});
