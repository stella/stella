import { expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { API_LINT_SHARDS, apiLintCommands } from "./lint-shards";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const script = path.join(import.meta.dir, "lint-shards.ts");

test("the API lint script lints the API through the shards", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(import.meta.dir, "../package.json"), "utf-8"),
  );
  const lint =
    typeof manifest === "object" &&
    manifest !== null &&
    "scripts" in manifest &&
    typeof manifest.scripts === "object" &&
    manifest.scripts !== null &&
    "lint" in manifest.scripts
      ? String(manifest.scripts.lint)
      : "";
  expect(lint).toContain(
    "bun apps/api/scripts/lint-shards.ts bun --bun oxlint",
  );
  // A whole-tree oxlint pass beside the shards would bring the peak back.
  expect(lint).not.toMatch(/oxlint[^&]*\sapps\/api(?:\s|$)/u);
});

test("the shards are disjoint API directories and the last pass leaves them out", () => {
  for (const shard of API_LINT_SHARDS) {
    expect(statSync(path.join(repositoryRoot, shard)).isDirectory()).toBe(true);
    for (const other of API_LINT_SHARDS) {
      if (other !== shard) {
        expect(
          `${other}/`.startsWith(`${shard}/`),
          `${other} in ${shard}`,
        ).toBe(false);
      }
    }
  }
  const commands = apiLintCommands(["oxlint", "--type-aware"]);
  expect(commands.map((command) => command.at(-1))).toEqual([
    ...API_LINT_SHARDS,
    "apps/api",
  ]);
  const rest = commands.at(-1) ?? [];
  for (const shard of API_LINT_SHARDS) {
    expect(rest.join(" ")).toContain(`--ignore-pattern ${shard}/**`);
  }
  for (const command of commands) {
    expect(command.slice(0, 2)).toEqual(["oxlint", "--type-aware"]);
  }
});

test("every shard runs after one fails, and the run then fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "api-lint-shards-"));
  try {
    const log = path.join(directory, "log");
    const fake = path.join(directory, "fake-oxlint.ts");
    await writeFile(
      fake,
      [
        'import { appendFileSync } from "node:fs";',
        "const target = process.argv.at(-1) ?? '';",
        `appendFileSync(${JSON.stringify(log)}, target + "\\n");`,
        `process.exit(target === ${JSON.stringify(API_LINT_SHARDS[0])} ? 1 : 0);`,
      ].join("\n"),
    );
    const result = Bun.spawnSync(
      [process.execPath, script, process.execPath, fake],
      { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(1);
    expect((await readFile(log, "utf-8")).trim().split("\n")).toEqual([
      ...API_LINT_SHARDS,
      "apps/api",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a run whose shards all pass succeeds", () => {
  const result = Bun.spawnSync(
    [process.execPath, script, process.execPath, "-e", "process.exit(0)"],
    { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(0);
});
