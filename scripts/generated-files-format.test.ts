// CI's autofix job runs the formatter over every file a pull request changes,
// generated ones included. A generated file the formatter would rewrite then
// fails its generator's byte-for-byte check right after autofix pushes, and
// the pull request is stuck. So every committed output in the manifest must be
// a formatter fixpoint: its generator formats what it writes (see
// scripts/generated-artifacts.ts), or `.oxfmtrc.json` ignores the path because
// the generator lives outside this repository's formatter reach.

import { describe, expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import path from "node:path";

import { GENERATORS, matchesGeneratedGlob } from "./generated-files";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const trackedFiles = (): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
};

/** Committed generator outputs, filtered as autofix filters changed paths. */
const generatedOutputs = (): string[] =>
  trackedFiles().filter(
    (file) =>
      !file.startsWith(".github/workflows/") &&
      lstatSync(path.join(REPO_ROOT, file)).isFile() &&
      GENERATORS.some((generator) =>
        generator.outputs.some((glob) => matchesGeneratedGlob(glob, file)),
      ),
  );

/** Autofix's formatter command, listing what it would rewrite. */
const filesTheFormatterWouldRewrite = (files: readonly string[]): string[] => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      "oxfmt",
      "-c",
      ".oxfmtrc.json",
      "--no-error-on-unmatched-pattern",
      "--list-different",
      ...files.map((file) => `./${file}`),
    ],
    { cwd: REPO_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  const listed = new TextDecoder()
    .decode(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // --list-different exits 1 exactly when it lists a file; anything else is
  // the formatter failing, not a verdict.
  expect(result.exitCode).toBe(listed.length > 0 ? 1 : 0);
  return listed.toSorted();
};

describe("generated files under the autofix formatter", () => {
  test("every committed generator output is left unchanged", () => {
    const outputs = generatedOutputs();
    // Outputs of both kinds, formatted by their generator and ignored by the
    // formatter, so an empty or narrowed set cannot pass vacuously.
    expect(outputs).toContain("docs/module-ownership.md");
    expect(
      outputs.some((file) => file.startsWith("docs/module-ownership/")),
    ).toBe(true);
    expect(outputs).toContain("docs/self-hosting.md");
    expect(outputs).toContain(".agents/skills/conventions-db/SKILL.md");

    // A file listed here needs its generator to format its output with
    // `formattedLikeRepository` before writing or comparing, or, when the
    // generator is not this repository's, an `.oxfmtrc.json` ignore entry.
    expect(filesTheFormatterWouldRewrite(outputs)).toEqual([]);
  });
});
