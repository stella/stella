import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  parseCollectedClasses,
  pluginProgressPrefix,
  progressTailLines,
  runLintPass,
  tailwindEntryPoints,
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
    // The message also quotes the command, which here is the script itself,
    // so the progress assertions read only the section between the headings.
    const heading = `Last plugin progress (${progressTailLines} lines):\n`;
    expect(message).toContain(heading);
    const progress = message
      .slice(message.indexOf(heading) + heading.length)
      .split("\nCache directory:\n")[0]
      ?.split("\n");
    expect(progress).toHaveLength(progressTailLines);
    expect(progress?.at(0)).toBe(`${pluginProgressPrefix} file 5`);
    expect(progress?.at(-1)).toBe(
      `${pluginProgressPrefix} file ${progressTailLines + 4}`,
    );
    expect(progress).not.toContain("not plugin progress");
    expect(message).toContain("Cache directory:\nsnapshot.lock 0 bytes");
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
});

const turboTasks = v.object({
  tasks: v.record(
    v.string(),
    v.looseObject({ dependsOn: v.optional(v.array(v.string()), []) }),
  ),
});
const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("only workspaces the Tailwind rules lint wait for the Tailwind cache", async () => {
  const { tasks } = v.parse(
    turboTasks,
    Bun.JSONC.parse(
      await readFile(path.join(repositoryRoot, "turbo.json"), "utf-8"),
    ),
  );
  const tailwindWorkspaces = await Promise.all(
    [...new Set(tailwindEntryPoints.map(({ root }) => root))].map(
      async (root) =>
        v.parse(
          v.object({ name: v.string() }),
          JSON.parse(
            await readFile(
              path.join(repositoryRoot, root, "package.json"),
              "utf-8",
            ),
          ),
        ).name,
    ),
  );
  const generation = "//#generate:tailwind-cache";
  // Waiting on generation directly would put its hash, and so every Tailwind
  // source, into every lint that has no Tailwind rules.
  expect(
    Object.entries(tasks)
      .filter(([, { dependsOn }]) => dependsOn.includes(generation))
      .map(([taskId]) => taskId)
      .toSorted(),
  ).toEqual(
    tailwindWorkspaces.map((name) => `${name}#tailwind-cache`).toSorted(),
  );
  expect(tasks["tailwind-cache"]?.dependsOn).toEqual([]);
  expect(tasks["lint"]?.dependsOn).toContain("tailwind-cache");
  // A workspace lint override replaces the shared lint definition, so it has
  // to name its workspace's cache node itself.
  for (const name of tailwindWorkspaces) {
    const override = tasks[`${name}#lint`];
    if (override !== undefined) {
      expect(override.dependsOn, name).toContain("tailwind-cache");
    }
  }
});
