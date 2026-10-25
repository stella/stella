/**
 * Pre-commit i18n sync for the web app's message catalogs.
 *
 * `apps/web`'s `i18n:sync` sorts en.json, fills the other locale catalogs and
 * regenerates messages.gen.ts, TERMINOLOGY.md and the prepaint locale list.
 * This hook stages exactly the files the sync changed, so the commit carries
 * the derived files of the catalogs it edits and nothing else.
 *
 * Staging a file stages all of its working-tree content. So before the sync
 * writes anything, the hook refuses when a file the sync may rewrite holds
 * unstaged or untracked content, which would otherwise ride into the commit.
 * (lefthook hides the unstaged part of a partially staged file while the hook
 * runs and restores it afterwards, so such a file reaches this check matching
 * the index.) A sync that changes a file outside `SYNC_TARGETS` fails the hook
 * and stages nothing, so the list cannot fall behind the scripts it runs.
 *
 * Run: `bun scripts/precommit-i18n.ts` (lefthook runs it on pre-commit).
 */

import { panic } from "better-result";
import { statSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

/** Every file `apps/web`'s `i18n:sync` can write, as git pathspecs. */
export const SYNC_TARGETS = [
  ":(glob)apps/web/src/i18n/langs/*.json",
  ":(literal)apps/web/src/i18n/langs/messages.gen.ts",
  ":(literal)apps/web/src/i18n/TERMINOLOGY.md",
  ":(literal)apps/web/public/prepaint-init.js",
] as const;

const SYNC_WORKSPACE = "apps/web";

export type PrecommitI18nResult =
  | { kind: "staged"; staged: string[] }
  | { kind: "refused"; dirty: string[] }
  | { kind: "sync-failed"; exitCode: number }
  | { kind: "undeclared-writes"; outside: string[] };

const git = (root: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) {
    return panic(
      `git ${args.join(" ")} failed in ${root}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
};

const nulSeparated = (output: string): string[] =>
  output.split("\0").filter((entry) => entry !== "");

/** Paths whose working-tree content differs from the index, or untracked. */
const unstagedPaths = (root: string, pathspecs: readonly string[]): string[] =>
  [
    ...new Set([
      ...nulSeparated(
        git(root, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          "--",
          ...pathspecs,
        ]),
      ),
      ...nulSeparated(
        git(root, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ...pathspecs,
        ]),
      ),
    ]),
  ].toSorted();

// Size and modification time are enough to notice a write between two
// snapshots of the same file; null records a deleted file.
const fileStamp = (file: string): string | null => {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
};

const stamps = (root: string, files: readonly string[]) =>
  new Map(files.map((file) => [file, fileStamp(path.join(root, file))]));

/**
 * Run `sync` and stage the targets it changed. `root` is the repository's
 * top level; `sync` writes the files and returns its exit code.
 */
export const runPrecommitI18n = (
  root: string,
  sync: () => number,
): PrecommitI18nResult => {
  const dirty = unstagedPaths(root, SYNC_TARGETS);
  if (dirty.length > 0) {
    return { kind: "refused", dirty };
  }
  const before = stamps(root, unstagedPaths(root, []));

  const exitCode = sync();
  if (exitCode !== 0) {
    return { kind: "sync-failed", exitCode };
  }

  const written = unstagedPaths(root, SYNC_TARGETS);
  const targets = new Set(written);
  const outside = unstagedPaths(root, []).filter(
    (file) =>
      !targets.has(file) &&
      (!before.has(file) ||
        before.get(file) !== fileStamp(path.join(root, file))),
  );
  if (outside.length > 0) {
    return { kind: "undeclared-writes", outside };
  }
  if (written.length > 0) {
    git(root, ["add", "--", ...written.map((file) => `:(literal)${file}`)]);
  }
  return { kind: "staged", staged: written };
};

const report = (result: PrecommitI18nResult): number => {
  const list = (files: readonly string[]) =>
    files.map((file) => `  ${file}`).join("\n");
  switch (result.kind) {
    case "staged":
      if (result.staged.length > 0) {
        console.log(
          `i18n sync staged ${result.staged.length} file(s):\n${list(result.staged)}`,
        );
      }
      return 0;
    case "refused":
      console.error(
        [
          "i18n sync refused: it rewrites and stages these files, which have unstaged or untracked changes:",
          list(result.dirty),
          "Staging them would commit those changes too. Stage them if they belong in this commit",
          `(git add -- ${result.dirty.join(" ")}), or move them out of the working tree, then commit again.`,
        ].join("\n"),
      );
      return 1;
    case "sync-failed":
      console.error(
        `i18n sync failed (exit ${result.exitCode}); nothing was staged. Fix the error above, run \`bun run --cwd ${SYNC_WORKSPACE} i18n:sync\`, review \`git diff\` and stage the result.`,
      );
      return result.exitCode;
    case "undeclared-writes":
      console.error(
        [
          "i18n sync changed files outside SYNC_TARGETS in scripts/precommit-i18n.ts; nothing was staged:",
          list(result.outside),
          "Add each file the sync writes to SYNC_TARGETS, or stop the sync from writing it.",
        ].join("\n"),
      );
      return 1;
    default:
      result satisfies never;
      return panic("Unhandled pre-commit i18n result");
  }
};

const main = () => {
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const result = runPrecommitI18n(root, () =>
    childExitStatus(
      Bun.spawnSync(["bun", "run", "i18n:sync"], {
        cwd: path.join(root, SYNC_WORKSPACE),
        stdout: "inherit",
        stderr: "inherit",
      }),
    ),
  );
  process.exit(report(result));
};

if (import.meta.main) {
  main();
}
