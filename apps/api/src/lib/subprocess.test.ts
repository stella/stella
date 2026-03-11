import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { spawnWorker } from "@/api/lib/subprocess";

const FIXTURES_DIR = resolve(import.meta.dir, "__fixtures__");
const ECHO_WORKER = resolve(FIXTURES_DIR, "echo-worker.ts");
const FAIL_WORKER = resolve(FIXTURES_DIR, "fail-worker.ts");

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
});
