import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { importDependents } from "./import-dependents";
import { scanResultConsumption } from "./result-consumption";
import { createProgram } from "./typescript-program";

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

// Inside the package so the fixture resolves better-result like real sources.
const FIXTURE_CACHE = path.join(import.meta.dir, "../.cache");

const fixtureRoot = () => {
  mkdirSync(FIXTURE_CACHE, { recursive: true });
  const root = mkdtempSync(path.join(FIXTURE_CACHE, "import-dependents-"));
  directories.push(root);
  return root;
};

test("importers of a changed module are found transitively, whatever the import form", () => {
  const root = fixtureRoot();
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src/changed.ts"),
    "export const read = () => 1;\n",
  );
  writeFileSync(
    path.join(root, "src/wrapper.ts"),
    'import { read } from "./changed";\nexport const wrap = () => read();\n',
  );
  writeFileSync(
    path.join(root, "src/caller.ts"),
    'import { wrap } from "./wrapper";\nexport const call = () => wrap();\n',
  );
  writeFileSync(
    path.join(root, "src/types.ts"),
    'import type { read } from "./changed";\nexport type R = typeof read;\n',
  );
  writeFileSync(
    path.join(root, "src/reexport.ts"),
    'export { read } from "./changed";\n',
  );
  writeFileSync(
    path.join(root, "src/lazy.ts"),
    'export const load = async () => (await import("./changed")).read();\n',
  );
  writeFileSync(
    path.join(root, "src/required.ts"),
    'import changed = require("./changed");\nexport const r = changed.read();\n',
  );
  writeFileSync(
    path.join(root, "src/reexport-required.ts"),
    'export import changed = require("./changed");\n',
  );
  writeFileSync(
    path.join(root, "src/missing.ts"),
    'import { gone } from "./not-there";\nexport const m = gone;\n',
  );
  writeFileSync(
    path.join(root, "src/uses-missing.ts"),
    'import { m } from "./missing";\nexport const n = m;\n',
  );
  writeFileSync(
    path.join(root, "src/unrelated.ts"),
    "export const other = 2;\n",
  );
  const at = (name: string) => path.join(root, "src", name);
  const dependents = importDependents({
    repositoryRoot: root,
    candidates: [
      "changed.ts",
      "wrapper.ts",
      "caller.ts",
      "types.ts",
      "reexport.ts",
      "lazy.ts",
      "required.ts",
      "reexport-required.ts",
      "missing.ts",
      "uses-missing.ts",
      "unrelated.ts",
    ].map(at),
    changed: [at("changed.ts")],
  });
  expect([...dependents].toSorted()).toEqual(
    [
      "caller.ts",
      "lazy.ts",
      "missing.ts",
      "reexport-required.ts",
      "reexport.ts",
      "required.ts",
      "types.ts",
      "uses-missing.ts",
      "wrapper.ts",
    ].map(at),
  );
});

test("an unchanged caller that discards a changed function's Result is checked", async () => {
  // The changed module starts returning a Result; the caller did not change.
  const root = fixtureRoot();
  mkdirSync(path.join(root, "packages/example/src"), { recursive: true });
  const source = path.join(root, "packages/example/src/source.ts");
  const caller = path.join(root, "packages/example/src/caller.ts");
  writeFileSync(
    path.join(root, "packages/example/src/source.ts"),
    'import { Result } from "better-result";\nexport const enqueue = () => Result.ok(1);\n',
  );
  writeFileSync(
    path.join(root, "packages/example/src/caller.ts"),
    'import { enqueue } from "./source";\nexport const run = () => {\n  enqueue();\n};\n',
  );
  const scan = async (sourceFiles: readonly string[]) => {
    const opened = await createProgram({
      rootNames: [...sourceFiles],
      compilerOptions: {
        module: "preserve",
        moduleResolution: "bundler",
        skipLibCheck: true,
        strict: true,
        target: "esnext",
      },
    });
    try {
      return await scanResultConsumption({
        ...opened,
        repositoryRoot: root,
        sourceFiles: new Set(sourceFiles),
      });
    } finally {
      await opened.close();
    }
  };
  const checked = [
    source,
    ...importDependents({
      repositoryRoot: root,
      candidates: [source, caller],
      changed: [source],
    }),
  ];
  expect((await scan(checked)).map(({ file }) => file)).toEqual([
    "packages/example/src/caller.ts",
  ]);
  // Checking the changed files alone misses the caller.
  expect(await scan([source])).toEqual([]);
});
