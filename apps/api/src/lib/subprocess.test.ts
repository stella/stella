import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";
import { waitFor } from "@stll/test-kit";

import {
  SUBPROCESS_TERMINATION_REASON,
  SubprocessError,
} from "@/api/lib/errors/tagged-errors";
import { ZIP_NAME_CODE_PAGE_ENV } from "@/api/lib/files/zip-name-code-page";
import {
  classifySubprocessTermination,
  readProcessRss,
  spawnBinaryWorker,
  spawnWorker,
} from "@/api/lib/subprocess";

const FIXTURES_DIR = path.resolve(import.meta.dir, "__fixtures__");
const ECHO_WORKER = path.resolve(FIXTURES_DIR, "echo-worker.ts");
const ENVIRONMENT_WORKER = path.resolve(FIXTURES_DIR, "env.ts");
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

  test("starts workers with a minimal environment", async () => {
    const result = await spawnWorker({
      workerPath: ENVIRONMENT_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 5000,
    });

    expect(Result.isError(result)).toBe(false);
    if (!Result.isError(result)) {
      const childEnvironment: unknown = JSON.parse(result.value);
      expect(childEnvironment).toEqual(["PATH"]);
    }
  });

  test("adds only the declared variables it is given to that environment", async () => {
    const result = await spawnBinaryWorker({
      workerPath: ENVIRONMENT_WORKER,
      env: { [ZIP_NAME_CODE_PAGE_ENV]: "ibm852" },
      stdin: new Blob([""]),
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });

    const childEnvironment: unknown = JSON.parse(
      new TextDecoder().decode(result.unwrap()),
    );
    expect(childEnvironment).toEqual(["PATH", ZIP_NAME_CODE_PAGE_ENV]);
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
      timeoutMs: 500, // timeout under test
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
        memoryAbort: false,
        signalCode: "SIGABRT",
        timeoutAbort: false,
      }),
    ).toBe(SUBPROCESS_TERMINATION_REASON.crashed);
  });

  test.each([34, 35, 64])(
    "classifies unnamed signal %i as external",
    (signalCode) => {
      expect(
        classifySubprocessTermination({
          callerAbort: false,
          memoryAbort: false,
          signalCode,
          timeoutAbort: false,
        }),
      ).toBe(SUBPROCESS_TERMINATION_REASON.external);
    },
  );

  // The class this pins: a caller abort must kill the subprocess, not
  // leave it burning CPU until the hard timeout expires. The fixture
  // sleeps for ten minutes; the call must return in bounded time once
  // the signal fires.
  test("classifies caller cancellation and kills the subprocess promptly", async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 250);
    const result = await spawnWorker({
      workerPath: SLEEP_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 600_000,
      signal: abort.signal,
    });
    clearTimeout(timer);

    expect(Result.isError(result)).toBe(true);
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
      await rejectionOf(
        spawnWorker({
          workerPath: SLEEP_WORKER,
          stdin: new Blob([""]),
          timeoutMs: 600_000,
          signal: abort.signal,
        }),
      ),
    ).toHaveProperty(
      "message",
      expect.stringContaining("The operation was aborted."),
    );
  });
});

describe("spawnBinaryWorker", () => {
  test("classifies the timeout kill as a timeout termination", async () => {
    const result = await spawnBinaryWorker({
      workerPath: SLEEP_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 500, // timeout under test
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

const GROW_WORKER = path.resolve(FIXTURES_DIR, "grow-worker.ts");
const MIB = 1024 * 1024;

describe("a worker's memory ceiling", () => {
  // The fixture grows to 1 GiB and then exits 0, so only the ceiling can
  // turn its run into a failure.
  test("kills a worker past it and fails as a memory termination", async () => {
    const result = await spawnBinaryWorker({
      workerPath: GROW_WORKER,
      stdin: new Blob([""]),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      maxRssBytes: 256 * MIB,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.termination).toEqual({
        reason: SUBPROCESS_TERMINATION_REASON.memory,
        signalCode: "SIGKILL",
      });
    }
  });

  test("leaves a worker under it alone", async () => {
    const result = await spawnWorker({
      workerPath: ECHO_WORKER,
      stdin: new Blob(["Rozsudek ze dne 12. 3. 2025"]),
      timeoutMs: 30_000,
      maxRssBytes: 256 * MIB,
    });

    expect(Result.isOk(result) && result.value.trim()).toBe(
      "Rozsudek ze dne 12. 3. 2025",
    );
  });

  test("reads another process's resident memory until it exits", async () => {
    const child = Bun.spawn(["bun", "run", "--no-env-file", SLEEP_WORKER], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // Once Bun has loaded it holds its runtime, megabytes; no host gives a
    // sleeping one a gigabyte.
    const running = await waitFor(
      async () => {
        const rss = await readProcessRss(child.pid);
        return rss.type === "resident" && rss.bytes > MIB
          ? rss.bytes
          : undefined;
      },
      { description: "the child's runtime to load" },
    );
    child.kill();
    await child.exited;

    expect(running).toBeLessThan(1024 * MIB);
    // Gone, which is not the same answer as a read that failed.
    expect(await readProcessRss(child.pid)).toEqual({ type: "exited" });
  });
});
