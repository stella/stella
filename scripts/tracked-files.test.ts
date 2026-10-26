import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { listTrackedFiles } from "../packages/scripts/src/tracked-files";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// `node:child_process` sync calls (`execFileSync("git", …)`, `execSync("git …")`,
// `spawnSync("git", …)`) cap their output at 1 MiB, which the repository's
// listing exceeds; `listTrackedFiles` reads it without that cap.
const BUFFERED_LS_FILES =
  /\b(?:execFileSync|spawnSync)\(\s*["'`]git["'`]\s*,\s*\[\s*["'`]ls-files["'`]|\bexecSync\(\s*["'`]git ls-files\b/u;

test("the tracked listing is read whole", () => {
  const files = listTrackedFiles(REPO_ROOT);
  expect(files).toContain("package.json");
  expect(files).toContain("packages/scripts/src/tracked-files.ts");
  expect(files.every((file) => file.length > 0)).toBe(true);
});

test("no script lists tracked files through a buffered child_process call", () => {
  const offenders = listTrackedFiles(REPO_ROOT)
    .filter(
      (file) =>
        (file.startsWith("scripts/") || file.includes("/scripts/")) &&
        /\.(?:[cm]?[jt]s|tsx)$/u.test(file) &&
        file !== "scripts/tracked-files.test.ts",
    )
    .filter((file) =>
      BUFFERED_LS_FILES.test(readFileSync(path.join(REPO_ROOT, file), "utf-8")),
    );
  expect(offenders).toEqual([]);
});

test("the guard recognises each buffered spelling", () => {
  for (const source of [
    'execFileSync("git", ["ls-files", "-z"], { cwd })',
    "spawnSync('git', ['ls-files'])",
    'execSync("git ls-files -z")',
  ]) {
    expect(BUFFERED_LS_FILES.test(source)).toBe(true);
  }
  expect(
    BUFFERED_LS_FILES.test('Bun.spawnSync(["git", "ls-files", "-z"])'),
  ).toBe(false);
});
