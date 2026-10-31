import { expect, test } from "bun:test";
import path from "node:path";

import { mapWithConcurrency } from "../packages/concurrency/src/index";
import { repoRelativePath } from "../packages/portable-path/src/index";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

// The repository depends on no `typescript` package: what resolves there is
// whichever copy a linter peers on. The classic API is `typescript6`, the
// TypeScript 7 API is `tsrs/unstable/*`. The lint rule covers static imports in linted files;
// this census also covers `require`, dynamic `import()`, and files the linter
// never reads (shell scripts that embed `bun -e` programs, plain .mjs).
const CLASSIC_API_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])typescript\1/mu;

const SCANNED = /\.(?:[cm]?[jt]sx?|sh)$/u;
// This file names the forbidden forms as fixtures.
const SELF = repoRelativePath(REPO_ROOT, import.meta.path);

const trackedFiles = (): readonly string[] => {
  const result = Bun.spawnSync(["git", "ls-files"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\n").filter(Boolean);
};

test("the pattern recognizes every import form", () => {
  for (const source of [
    'import ts from "typescript";',
    "import type { Node } from 'typescript';",
    'import * as ts from "typescript";',
    'export { SyntaxKind } from "typescript";',
    'const ts = await import("typescript");',
    'const ts = require("typescript");',
    'import "typescript";',
  ]) {
    expect(CLASSIC_API_IMPORT.test(source)).toBe(true);
  }
  for (const source of [
    'import ts from "typescript6";',
    'import { API } from "tsrs/unstable/sync";',
    'const language = "typescript";',
  ]) {
    expect(CLASSIC_API_IMPORT.test(source)).toBe(false);
  }
});

const IMPORT_CENSUS_CONCURRENCY = 16;

test("no tracked file reaches the compiler API through the typescript package", async () => {
  const matches = await mapWithConcurrency({
    items: trackedFiles().filter((name) => SCANNED.test(name) && name !== SELF),
    limit: IMPORT_CENSUS_CONCURRENCY,
    operation: async (file) => {
      const source = await Bun.file(path.join(REPO_ROOT, file)).text();
      return CLASSIC_API_IMPORT.test(source) ? [file] : [];
    },
  });
  expect(matches.flat()).toEqual([]);
});
