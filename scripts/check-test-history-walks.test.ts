import { expect, test } from "bun:test";

import {
  checkTestHistoryWalks,
  findHistoryWalks,
} from "./check-test-history-walks.ts";

const FILE = "scripts/example.test.ts";

const scan = (source: string, allowed: Record<string, string> = {}) =>
  findHistoryWalks(new Map([[FILE, source]]), allowed);

test("flags every spawn shape that walks history", () => {
  for (const source of [
    'Bun.spawnSync(["git", "log", "-n", "30", "--", "a.yml"]);',
    'spawnSync("git", ["-C", root, "rev-list", "HEAD"]);',
    'execFileSync("git", ["blame", "a.ts"]);',
    'git(checkout, "log", "-G", "needle");',
    'runGit(["shortlog", "-s"]);',
    `const out = $\`git log -p -- \${file}\`;`,
    'execSync("git -C repo whatchanged");',
    'const hook = `#!/bin/sh\ngit log -p -U0 "$@"\n`;',
  ]) {
    expect(scan(source), source).toHaveLength(1);
  }
});

test("allows pinned reads and commands that do not walk history", () => {
  for (const source of [
    `Bun.spawnSync(["git", "show", \`\${sha}:a.yml\`]);`,
    'git(["merge-base", "origin/main", "HEAD"]);',
    'spawnSync("git", ["-c", "core.quotepath=off", "diff", "--name-only"]);',
    'spyOn(console, "log");',
    'logger("log", "rev-list");',
    "// git log -p would fetch every blob",
  ]) {
    expect(scan(source), source).toEqual([]);
  }
});

test("reports each walk with its line", () => {
  expect(
    scan('const a = 1;\nBun.spawnSync(["git", "rev-list", "HEAD"]);'),
  ).toEqual([expect.objectContaining({ file: FILE, line: 2 })]);
});

test("the allowlist shrinks: stale and unknown entries fail", () => {
  const walk = 'Bun.spawnSync(["git", "log"]);';
  expect(scan(walk, { [FILE]: "fixture repository" })).toEqual([]);
  expect(scan("const a = 1;", { [FILE]: "fixture repository" })).toEqual([
    expect.objectContaining({ file: FILE }),
  ]);
  expect(
    scan(walk, { [FILE]: "fixture", "scripts/gone.test.ts": "fixture" }),
  ).toEqual([expect.objectContaining({ file: "scripts/gone.test.ts" })]);
});

test("no tracked test walks history outside the allowlist", () => {
  expect(checkTestHistoryWalks()).toEqual([]);
});
