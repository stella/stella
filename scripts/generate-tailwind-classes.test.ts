import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { runLintPass } from "./generate-tailwind-classes";

test("a lint pass's large report is read while the pass runs", async () => {
  const size = 16 * 1024 * 1024;
  const { exitCode, stdout } = await runLintPass(
    [
      process.execPath,
      "-e",
      `process.stdout.write("x".repeat(${size})); process.exitCode = 1;`,
    ],
    { env: process.env, pass: "test" },
  );
  expect(exitCode).toBe(1);
  expect(stdout.length).toBe(size);
});

test("a stalled lint pass is stopped and fails generation, naming the pass", async () => {
  const started = performance.now();
  // real-time: the pass must be stopped by its own timeout.
  const rejection = await rejectionOf(
    runLintPass([process.execPath, "-e", "setInterval(() => {}, 1000);"], {
      env: process.env,
      pass: "stalled test",
      timeoutMs: 200,
    }),
  );
  expect(rejection instanceof Error ? rejection.message : "").toContain(
    "Tailwind cache generation (scripts/generate-tailwind-classes.ts --write): the stalled test oxlint pass was still running after 0.2 s and was stopped.",
  );
  expect(performance.now() - started).toBeLessThan(4000);
});
