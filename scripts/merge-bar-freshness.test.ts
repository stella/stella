import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type BarFreshnessInput,
  decideBarFreshness,
  readBarFreshness,
} from "./merge-bar-freshness";

const ROOT = "/repo";
const MAIN = "a".repeat(40);
const OLD = "b".repeat(40);
const EDIT = "c".repeat(40);

const input = (overrides: Partial<BarFreshnessInput>): BarFreshnessInput => ({
  repositoryRoot: ROOT,
  fetch: { type: "fetched" },
  files: [
    { path: "scripts/merge-bar.ts", local: MAIN, head: MAIN, main: MAIN },
  ],
  head: { type: "detached" },
  headContainsMain: true,
  ...overrides,
});

describe("decideBarFreshness", () => {
  test("a bar identical to origin/main runs", () => {
    expect(decideBarFreshness(input({}))).toEqual({ type: "current" });
  });

  test("a failed fetch refuses, even when the files match", () => {
    const verdict = decideBarFreshness(
      input({ fetch: { type: "failed", detail: "could not resolve host" } }),
    );
    expect(verdict.type).toBe("refuse");
    expect(verdict).toMatchObject({
      message: expect.stringContaining("could not resolve host"),
    });
  });

  test.each([
    [
      { type: "detached" } as const,
      `git -C ${ROOT} fetch origin main && git -C ${ROOT} switch --detach origin/main`,
    ],
    [
      { type: "branch", name: "main" } as const,
      `git -C ${ROOT} pull --ff-only origin main`,
    ],
    [
      { type: "branch", name: "feature" } as const,
      `git -C ${ROOT} fetch origin main && git -C ${ROOT} rebase origin/main`,
    ],
  ])(
    "a stale committed bar refuses with the update for %o",
    (head, command) => {
      const verdict = decideBarFreshness(
        input({
          head,
          headContainsMain: false,
          files: [
            { path: "scripts/merge-bar.ts", local: OLD, head: OLD, main: MAIN },
          ],
        }),
      );
      expect(verdict.type).toBe("refuse");
      expect(verdict).toMatchObject({
        message: expect.stringContaining(
          `(scripts/merge-bar.ts; stale checkout); update first: ${command}`,
        ),
      });
    },
  );

  test("a file main added but the checkout lacks reads as stale", () => {
    // Only the local closure is enumerated; a new import shows up as a
    // change to the importing file, which differs from main.
    const verdict = decideBarFreshness(
      input({
        headContainsMain: false,
        files: [
          { path: "scripts/merge-bar.ts", local: OLD, head: OLD, main: MAIN },
          { path: "scripts/gone.ts", local: OLD, head: OLD, main: null },
        ],
      }),
    );
    expect(verdict.type).toBe("refuse");
  });

  test("uncommitted edits refuse even on a branch that contains main", () => {
    const verdict = decideBarFreshness(
      input({
        head: { type: "branch", name: "feature" },
        files: [
          { path: "scripts/merge-bar.ts", local: EDIT, head: MAIN, main: MAIN },
        ],
      }),
    );
    expect(verdict).toEqual({
      type: "refuse",
      message: expect.stringMatching(
        /uncommitted edits\); update first: git -C \/repo stash push --include-untracked -m merge-bar-local -- scripts\/merge-bar\.ts$/u,
      ),
    });
  });

  test("uncommitted edits on a stale checkout chain the stash and the update", () => {
    const verdict = decideBarFreshness(
      input({
        headContainsMain: false,
        files: [
          { path: "scripts/merge-bar.ts", local: EDIT, head: OLD, main: MAIN },
        ],
      }),
    );
    expect(verdict).toMatchObject({
      type: "refuse",
      message: expect.stringContaining(
        "-- scripts/merge-bar.ts && git -C /repo fetch origin main && git -C /repo switch --detach origin/main",
      ),
    });
  });

  test("a branch containing main runs its own committed bar", () => {
    const verdict = decideBarFreshness(
      input({
        head: { type: "branch", name: "fix/bar" },
        files: [
          { path: "scripts/merge-bar.ts", local: EDIT, head: EDIT, main: MAIN },
          {
            path: "scripts/new-helper.ts",
            local: EDIT,
            head: EDIT,
            main: null,
          },
        ],
      }),
    );
    expect(verdict).toEqual({
      type: "branch-bar",
      message: expect.stringContaining(
        "scripts/merge-bar.ts, scripts/new-helper.ts",
      ),
    });
  });

  test("a branch behind main with its own bar change refuses", () => {
    const verdict = decideBarFreshness(
      input({
        head: { type: "branch", name: "fix/bar" },
        headContainsMain: false,
        files: [
          { path: "scripts/merge-bar.ts", local: EDIT, head: EDIT, main: MAIN },
        ],
      }),
    );
    expect(verdict.type).toBe("refuse");
  });

  test("a root with spaces is quoted in the command", () => {
    const verdict = decideBarFreshness(
      input({
        repositoryRoot: "/my repo",
        headContainsMain: false,
        files: [
          { path: "scripts/merge-bar.ts", local: OLD, head: OLD, main: MAIN },
        ],
      }),
    );
    expect(verdict).toMatchObject({
      message: expect.stringContaining("git -C '/my repo' switch"),
    });
  });
});

describe("readBarFreshness in a git repository", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };

  const write = (root: string, file: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  };

  const commitAll = (root: string, message: string) => {
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", message);
  };

  // An origin with main, and a detached clone of it.
  const setUp = () => {
    const base = mkdtempSync(path.join(tmpdir(), "merge-bar-freshness-"));
    directories.push(base);
    const origin = path.join(base, "origin.git");
    const author = path.join(base, "author");
    const clone = path.join(base, "clone");
    git(base, "init", "--quiet", "--bare", "-b", "main", origin);
    git(base, "clone", "--quiet", origin, author);
    write(
      author,
      "scripts/merge-bar.ts",
      'import { helper } from "./helper";\nhelper("release-pull-requests.sh");\n',
    );
    write(
      author,
      "scripts/helper.ts",
      "export const helper = (_: string) => 1;\n",
    );
    write(author, "scripts/release-pull-requests.sh", "echo v1\n");
    write(author, "scripts/unrelated.ts", "export const x = 1;\n");
    commitAll(author, "v1");
    git(author, "push", "--quiet", "origin", "main");
    git(base, "clone", "--quiet", origin, clone);
    git(clone, "switch", "--quiet", "--detach", "origin/main");
    return { author, clone };
  };

  const verdictFor = (clone: string) =>
    decideBarFreshness(
      readBarFreshness({
        repositoryRoot: clone,
        entry: "scripts/merge-bar.ts",
      }),
    );

  test("a current clone proceeds and an unrelated change on main does not matter", () => {
    const { author, clone } = setUp();
    write(author, "scripts/unrelated.ts", "export const x = 2;\n");
    commitAll(author, "unrelated");
    git(author, "push", "--quiet", "origin", "main");

    expect(verdictFor(clone)).toEqual({ type: "current" });
  });

  test.each([
    [
      "the bar itself",
      "scripts/merge-bar.ts",
      'import { helper } from "./helper";\nhelper("release-pull-requests.sh");\nhelper("fixed");\n',
    ],
    [
      "an imported module",
      "scripts/helper.ts",
      "export const helper = (_: string) => 2;\n",
    ],
    [
      "a shell script the bar runs",
      "scripts/release-pull-requests.sh",
      "echo v2\n",
    ],
  ])(
    "a clone behind a fix to %s refuses with the update command",
    (_, file, content) => {
      const { author, clone } = setUp();
      write(author, file, content);
      commitAll(author, "fix");
      git(author, "push", "--quiet", "origin", "main");

      const verdict = verdictFor(clone);
      expect(verdict).toEqual({
        type: "refuse",
        message: expect.stringContaining(
          `${file}; stale checkout); update first: git -C ${clone} fetch origin main && git -C ${clone} switch --detach origin/main`,
        ),
      });

      git(clone, "switch", "--quiet", "--detach", "origin/main");
      expect(verdictFor(clone)).toEqual({ type: "current" });
    },
  );

  test("an unreachable origin refuses", () => {
    const { clone } = setUp();
    git(clone, "remote", "set-url", "origin", path.join(clone, "missing.git"));

    expect(verdictFor(clone)).toMatchObject({
      type: "refuse",
      message: expect.stringContaining("cannot fetch origin main"),
    });
  });
});
