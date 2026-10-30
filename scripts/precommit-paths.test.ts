import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { authorWrittenPaths, mergeParents } from "./precommit-paths";

const ROOT = path.resolve(import.meta.dir, "..");
const SCRIPT = path.join(import.meta.dir, "precommit-paths.ts");
const OWNER = "bun scripts/precommit-paths.ts";

// Every git call names its own identity and reads no global or system
// config, so a developer machine behaves like a CI runner that has none.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const spawnGit = (cwd: string, args: readonly string[]) =>
  Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
    { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" },
  );
const git = (cwd: string, ...args: string[]): string => {
  const result = spawnGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};
const write = (repo: string, file: string, text: string) =>
  writeFileSync(path.join(repo, file), text);
const runScript = (repo: string, ...args: string[]) =>
  Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: repo,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });

const withRepo = (check: (repo: string) => void) => {
  const repo = mkdtempSync(path.join(tmpdir(), "precommit-paths-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    check(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

describe("staged paths of an ordinary commit", () => {
  test("every added, modified and renamed path, never a deleted one", () => {
    withRepo((repo) => {
      write(repo, "kept.ts", "export const kept = 1;\n");
      write(repo, "edited.ts", "export const edited = 1;\n");
      write(repo, "gone.ts", "export const gone = 1;\n");
      write(repo, "moved.ts", "export const moved = 1;\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");

      write(repo, "edited.ts", "export const edited = 2;\n");
      write(repo, "new file é.ts", "export const added = 1;\n");
      git(repo, "rm", "-q", "gone.ts");
      git(repo, "mv", "moved.ts", "renamed.ts");
      git(repo, "add", ".");

      expect(mergeParents(repo)).toEqual([]);
      const expected = ["edited.ts", "new file é.ts", "renamed.ts"];
      expect(authorWrittenPaths(repo).toSorted()).toEqual(expected);
      const printed = runScript(repo, "-z");
      expect(printed.exitCode).toBe(0);
      expect(
        printed.stdout.toString().split("\0").filter(Boolean).toSorted(),
      ).toEqual(expected);
    });
  });

  test("a first commit lists every staged path", () => {
    withRepo((repo) => {
      write(repo, "a.ts", "export const a = 1;\n");
      git(repo, "add", ".");
      expect(authorWrittenPaths(repo)).toEqual(["a.ts"]);
    });
  });

  test("a path holding a newline is refused, not split into two", () => {
    withRepo((repo) => {
      write(repo, "two\nlines.ts", "export const a = 1;\n");
      git(repo, "add", ".");
      const lines = runScript(repo);
      expect(lines.exitCode).toBe(1);
      expect(lines.stdout.toString()).toBe("");
      expect(lines.stderr.toString()).toContain("contain a newline");
      expect(runScript(repo, "-z").stdout.toString()).toBe("two\nlines.ts\0");
    });
  });
});

describe("staged paths of a merge commit", () => {
  test("only resolutions and merge-time edits, never either side's own files", () => {
    withRepo((repo) => {
      write(repo, "shared.ts", "export const a = 1;\n");
      write(repo, "untouched.ts", "export const u = 1;\n");
      write(repo, "feature-only.ts", "export const f = 1;\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      git(repo, "switch", "-q", "-c", "feature");
      write(repo, "shared.ts", "export const a = 2;\n");
      write(repo, "feature-only.ts", "export const f = 2;\n");
      git(repo, "commit", "-q", "-am", "feature");
      git(repo, "switch", "-q", "main");
      write(repo, "shared.ts", "export const a = 3;\n");
      write(repo, "main only é.ts", "export const m = 1;\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "main");
      git(repo, "switch", "-q", "feature");

      // shared.ts conflicts, so the merge stops (exit 1) with MERGE_HEAD set.
      expect(spawnGit(repo, ["merge", "--no-commit", "main"]).exitCode).toBe(1);
      expect(mergeParents(repo)).toEqual([
        git(repo, "rev-parse", "main").trim(),
      ]);
      write(repo, "shared.ts", "export const a = 23;\n");
      // An edit made during the merge to a file neither side changed.
      write(repo, "untouched.ts", "export const u = 2;\n");
      git(repo, "add", ".");

      // main's new file and the feature's own file are taken unchanged from
      // one parent; the resolution and the merge-time edit are new to both.
      expect(authorWrittenPaths(repo).toSorted()).toEqual([
        "shared.ts",
        "untouched.ts",
      ]);
      expect(runScript(repo).stdout.toString().split("\n").toSorted()).toEqual([
        "",
        "shared.ts",
        "untouched.ts",
      ]);

      git(repo, "merge", "--abort");
      expect(mergeParents(repo)).toEqual([]);
    });
  });

  test("a merge that takes every path from a parent lists nothing", () => {
    withRepo((repo) => {
      write(repo, "a.ts", "export const a = 1;\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      git(repo, "switch", "-q", "-c", "feature");
      write(repo, "b.ts", "export const b = 1;\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "feature");
      git(repo, "switch", "-q", "main");
      write(repo, "a.ts", "export const a = 2;\n");
      git(repo, "commit", "-q", "-am", "main");
      git(repo, "switch", "-q", "feature");
      git(repo, "merge", "--no-commit", "--no-ff", "main");

      expect(authorWrittenPaths(repo)).toEqual([]);
      expect(runScript(repo).stdout.toString()).toBe("");
    });
  });

  test("an octopus merge compares against every merged parent", () => {
    withRepo((repo) => {
      for (const file of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
        write(repo, file, `export const v = "${file}";\n`);
      }
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      for (const [branch, file] of [
        ["one", "b.ts"],
        ["two", "c.ts"],
      ] as const) {
        git(repo, "switch", "-q", "-c", branch, "main");
        write(repo, file, `export const v = "${branch}";\n`);
        git(repo, "commit", "-q", "-am", branch);
      }
      git(repo, "switch", "-q", "main");
      git(repo, "merge", "--no-commit", "--no-ff", "one", "two");
      expect(mergeParents(repo)).toHaveLength(2);
      write(repo, "d.ts", 'export const v = "edited during the merge";\n');
      git(repo, "add", ".");

      expect(authorWrittenPaths(repo)).toEqual(["d.ts"]);
    });
  });
});

describe("lefthook.yml", () => {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const config: unknown = Bun.YAML.parse(
    readFileSync(path.join(ROOT, "lefthook.yml"), "utf-8"),
  );
  const preCommit = isRecord(config) ? config["pre-commit"] : undefined;
  const commands = isRecord(preCommit) ? preCommit["commands"] : undefined;
  const entries = Object.entries(isRecord(commands) ? commands : {}).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  );

  test("every hook acting on staged paths takes them from the owner", () => {
    const staged = entries.filter(([, command]) => {
      const run = String(command["run"]);
      return (
        command["glob"] !== undefined ||
        run.includes("{staged_files}") ||
        run.includes("{files}") ||
        /\s--staged\b/u.test(run)
      );
    });
    expect(staged.map(([name]) => name).toSorted()).toEqual([
      "ai-skills",
      "format",
      "i18n",
      "lint",
    ]);
    for (const [name, command] of staged) {
      // {staged_files} and a bare --staged would bypass the owner and hand a
      // merge commit every path the other branch brought in.
      expect({ name, files: command["files"] }).toEqual({ name, files: OWNER });
      expect(String(command["run"])).not.toContain("{staged_files}");
    }
    expect(isRecord(preCommit) ? preCommit["files"] : undefined).toBe(
      undefined,
    );
  });

  test("the fail-closed whole-index checks never narrow", () => {
    for (const name of ["secrets", "tracked-symlinks", "lockfiles", "deps"]) {
      const command = entries.find(([entry]) => entry === name)?.[1];
      expect(command).toBeDefined();
      expect({
        name,
        files: command?.["files"],
        glob: command?.["glob"],
      }).toEqual({ name, files: undefined, glob: undefined });
    }
  });
});
