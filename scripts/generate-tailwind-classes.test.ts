import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  parseCollectedClasses,
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
  const message = rejection instanceof Error ? rejection.message : "";
  expect(message).toContain(
    "Tailwind cache generation (scripts/generate-tailwind-classes.ts --write): the stalled test oxlint pass was still running after 0.2 s and was stopped. It had written 0 bytes of its report, and its ",
  );
  expect(performance.now() - started).toBeLessThan(4000);
});

test.skipIf(process.platform !== "linux")(
  "a stall message names what the stopped pass's threads were waiting in",
  async () => {
    // real-time: the pass must be stopped by its own timeout.
    const rejection = await rejectionOf(
      runLintPass(
        [
          process.execPath,
          "-e",
          "process.stdout.write('{'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
        ],
        { env: process.env, pass: "blocked test", timeoutMs: 1000 },
      ),
    );
    const message = rejection instanceof Error ? rejection.message : "";
    expect(message).toContain("It had written 1 bytes of its report");
    // The main thread sleeps in Atomics.wait; the kernel shows it as S.
    expect(message).toMatch(/its \d+ threads were \d+x .* S/u);
  },
);

test("collected classes are deduplicated and sorted by stylesheet", () => {
  expect([
    ...parseCollectedClasses(
      [
        JSON.stringify({ cssPath: "/b.css", classes: ["w-[2px]", "p-4"] }),
        JSON.stringify({ cssPath: "/a.css", classes: ["flex"] }),
        "",
        JSON.stringify({ cssPath: "/b.css", classes: ["p-4", "m-[3px]"] }),
      ].join("\n"),
    ),
  ]).toEqual([
    ["/a.css", ["flex"]],
    ["/b.css", ["m-[3px]", "p-4", "w-[2px]"]],
  ]);
  expect(parseCollectedClasses("").size).toBe(0);
});
