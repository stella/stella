import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the derivative entrypoint owns the derivative worker host and shutdown", () => {
  const source = readFileSync(
    new URL("file-derivative-worker.ts", import.meta.url),
    "utf-8",
  );
  expect(source).toContain(
    'createBullMqWorkerHost(\n  "file-derivative-worker"',
  );
  expect(source).toContain('process.once("SIGTERM"');
  expect(source).toContain("await workers.close()");
  expect(source).toContain("envFileDerivativeWorker.SCHEDULED_JOBS_MODE");
});
