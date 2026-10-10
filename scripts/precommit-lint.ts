/**
 * Pre-commit lint for staged files.
 *
 * Lint autofixes are code changes, and some change behaviour, so they never
 * reach a commit unseen. The hook runs the fix pass, and when it would change
 * a staged file it prints the change, restores the file and fails. Nothing is
 * left modified for another step's `stage_fixed` to sweep into the commit, so
 * a fix pass can neither rewrite code behind a passing hook nor turn a commit
 * empty. Apply the fixes deliberately with `--apply`, review `git diff`, stage
 * and commit again.
 *
 * `RECEIVER_TYPED_AUTOFIX_RULES` are off for the fix pass. Their fixes assume
 * the type of a value the linter cannot see (a string, an array, an element
 * with `innerText`, a declared identifier) and can turn working code into a
 * runtime error. CI's lint still reports them; fix those by hand.
 *
 * Run: `bun scripts/precommit-lint.ts [--apply] <files...>` (lefthook passes
 * the staged files).
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

export const RECEIVER_TYPED_AUTOFIX_RULES = [
  // `x.match(y)` -> `y.test(x)`: assumes `x` is a string (wrong for `Bun.Glob#match`).
  "unicorn/prefer-regexp-test",
  // `/^a/.test(x)` -> `x.startsWith("a")`: assumes `x` is a string.
  "unicorn/prefer-string-starts-ends-with",
  // `x.substr(a)` -> `x.slice(a)`: assumes `x` is a string.
  "unicorn/prefer-string-slice",
  // `x.map(f).flat()` -> `x.flatMap(f)`: assumes `x` is an array.
  "unicorn/prefer-array-flat-map",
  // `x[x.length - 1]` -> `x.at(-1)`: assumes `x` has `at`.
  "unicorn/prefer-at",
  // `x.slice(a, x.length)` -> `x.slice(a)`: assumes a built-in `slice` (two rules fix it).
  "unicorn/no-unnecessary-slice-end",
  "unicorn/no-length-as-slice-end",
  // `innerText` -> `textContent`: different values for rendered text.
  "unicorn/prefer-dom-node-text-content",
  // `typeof x === "undefined"` -> `x === undefined`: throws for an undeclared `x`.
  "unicorn/no-typeof-undefined",
] as const;

export const lintCommand = (files: readonly string[]): string[] => [
  "bun",
  "--bun",
  "oxlint",
  "-c",
  "oxlint.config.ts",
  "--threads=2",
  "--no-error-on-unmatched-pattern",
  "--fix",
  ...RECEIVER_TYPED_AUTOFIX_RULES.flatMap((rule) => ["-A", rule]),
  ...files,
];

// A staged deletion or rename source has no working-tree file to compare.
const readOrNull = (file: string): string | null =>
  existsSync(file) ? readFileSync(file, "utf-8") : null;

const unifiedDiff = (file: string, before: string, after: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "precommit-lint-"));
  writeFileSync(path.join(dir, "before"), before);
  writeFileSync(path.join(dir, "after"), after);
  const diff = Bun.spawnSync(
    ["git", "diff", "--no-index", "--no-color", "--", "before", "after"],
    { cwd: dir },
  );
  rmSync(dir, { recursive: true, force: true });
  return diff.stdout
    .toString()
    .replace(
      "diff --git a/before b/after",
      () => `diff --git a/${file} b/${file}`,
    )
    .replace("--- a/before", () => `--- a/${file}`)
    .replace("+++ b/after", () => `+++ b/${file}`);
};

export type PrecommitLintResult = {
  exitCode: number;
  changed: string[];
  diff: string;
};

export const runPrecommitLint = (
  files: readonly string[],
  {
    cwd = process.cwd(),
    apply = false,
  }: { cwd?: string; apply?: boolean } = {},
): PrecommitLintResult => {
  const absolute = (file: string) => path.resolve(cwd, file);
  const before = new Map(
    files.map((file) => [file, readOrNull(absolute(file))]),
  );
  const lint = Bun.spawnSync(lintCommand(files), {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const changed: string[] = [];
  let diff = "";
  for (const file of files) {
    const original = before.get(file) ?? null;
    const fixed = readOrNull(absolute(file));
    if (original === null || fixed === null || fixed === original) {
      continue;
    }
    changed.push(file);
    diff += unifiedDiff(file, original, fixed);
    if (!apply) {
      writeFileSync(absolute(file), original);
    }
  }
  if (changed.length > 0 && !apply) {
    return { exitCode: 1, changed, diff };
  }
  return { exitCode: childExitStatus(lint), changed, diff };
};

const main = () => {
  const apply = Bun.argv[2] === "--apply";
  const files = Bun.argv.slice(apply ? 3 : 2);
  if (files.length === 0) {
    return;
  }
  const { exitCode, changed, diff } = runPrecommitLint(files, { apply });
  if (changed.length > 0 && apply) {
    console.error(
      `Applied lint autofixes to ${changed.length} file(s); review them with \`git diff\`.`,
    );
  } else if (changed.length > 0) {
    console.error(
      [
        diff,
        `Lint autofixes would change ${changed.length} staged file(s) (shown above); the files are unchanged.`,
        `Review, then apply with: bun scripts/precommit-lint.ts --apply ${changed.join(" ")}`,
        "and stage what is correct.",
      ].join("\n"),
    );
  }
  process.exit(exitCode);
};

if (import.meta.main) {
  main();
}
