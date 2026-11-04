import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  pluginProgressPrefix,
  progressTailLines,
  runLintPass,
} from "./generate-tailwind-classes";

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

test("a stalled lint pass reports its last plugin progress and the cache directory", async () => {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), "tailwind-stall-"));
  try {
    await writeFile(path.join(cacheDirectory, "snapshot.lock"), "");
    // A pass that logs more progress than the tail keeps, then hangs.
    const script = [
      `for (let i = 0; i < ${progressTailLines + 5}; i++) console.error("${pluginProgressPrefix} file " + i);`,
      `console.error("not plugin progress");`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const rejection = await rejectionOf(
      runLintPass([process.execPath, "-e", script], {
        env: { ...process.env, OXLINT_TAILWINDCSS_CACHE_DIR: cacheDirectory },
        pass: "stalled test",
        timeoutMs: 1000,
      }),
    );
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).toContain(
      `Last plugin progress (${progressTailLines} lines):`,
    );
    expect(message).toContain(
      `${pluginProgressPrefix} file ${progressTailLines + 4}`,
    );
    expect(message).not.toContain(`${pluginProgressPrefix} file 4\n`);
    expect(message).not.toContain("not plugin progress");
    expect(message).toContain("Cache directory:\nsnapshot.lock 0 bytes");
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});
