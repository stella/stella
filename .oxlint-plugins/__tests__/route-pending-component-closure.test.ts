import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import policy from "../route-pending-component-policy.json" with { type: "json" };
import unmarkedList from "../route-pending-component-unmarked.json" with { type: "json" };

// The pending-module rule checks each `*.pending.tsx` file's own imports; it
// trusts the pending-safe modules to stay light. This walks every such
// module's runtime import closure, through workspace sources, and fails when
// it reaches something a pending half must never ship in the entry chunk.

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../..");
// Imports resolve as an `apps/web` source file would resolve them.
const RESOLVE_FROM = path.join(REPOSITORY_ROOT, "apps/web/src/routes");
const ts = new Bun.Transpiler({ loader: "ts" });
const tsx = new Bun.Transpiler({ loader: "tsx" });

const isWorkspaceSource = (file: string) =>
  file.startsWith(REPOSITORY_ROOT) &&
  !file.includes(`${path.sep}node_modules${path.sep}`) &&
  /\.tsx?$/u.test(file);

const resolve = (specifier: string, fromDirectory: string): string | null => {
  try {
    return Bun.resolveSync(specifier, fromDirectory);
  } catch {
    return null;
  }
};

/** Every module specifier the closure of `entry` imports at runtime, with
 *  the workspace file that imports it. */
const importClosure = (entry: string) => {
  const reached: { from: string; specifier: string }[] = [];
  const start = resolve(entry, RESOLVE_FROM);
  if (start === null) {
    return { reached, files: new Set<string>(), unresolved: true };
  }
  const pending = [start];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file) || !isWorkspaceSource(file)) {
      continue;
    }
    seen.add(file);
    const source = readFileSync(file, "utf-8");
    const transpiler = file.endsWith(".tsx") ? tsx : ts;
    for (const { path: specifier } of transpiler.scanImports(source)) {
      reached.push({
        from: repoRelativePath(REPOSITORY_ROOT, file),
        specifier,
      });
      const target = resolve(specifier, path.dirname(file));
      if (target !== null) {
        pending.push(target);
      }
    }
  }
  return { reached, files: seen, unresolved: false };
};

const banned = (specifier: string) =>
  policy.closureBanned.find((fragment) => specifier.includes(fragment));

for (const entry of policy.pendingSafeModules) {
  test(`pending-safe module ${entry} reaches nothing heavy`, () => {
    const { reached, unresolved } = importClosure(entry);
    expect(unresolved).toBe(false);
    const offenders = reached.flatMap(({ from, specifier }) => {
      const fragment = banned(specifier);
      return fragment === undefined ? [] : [`${from} -> ${specifier}`];
    });
    expect(offenders).toEqual([]);
  });
}

// The pending modules the cold-load frame may draw (every one but those on
// the unmarked list, and any that marks a view with `framePendingView`), so
// a `.logic` module or a re-export they pull in is walked too, not only the
// allowlisted modules. Listed modules render inside the providers and are
// not walked.
const UNMARKED: ReadonlySet<string> = new Set(unmarkedList);
const isFrameModule = (file: string) =>
  !UNMARKED.has(repoRelativePath(REPOSITORY_ROOT, file)) ||
  readFileSync(file, "utf-8").includes("framePendingView(");
const FRAME_MODULES = [
  ...new Bun.Glob("**/*.pending.tsx").scanSync({
    cwd: path.join(REPOSITORY_ROOT, "apps/web/src"),
  }),
]
  .map((file) => path.join(REPOSITORY_ROOT, "apps/web/src", file))
  .filter(isFrameModule);

test("the walk finds the frame pending halves", () => {
  expect(FRAME_MODULES.length).toBeGreaterThan(0);
});

for (const module of FRAME_MODULES) {
  test(`frame pending half ${repoRelativePath(REPOSITORY_ROOT, module)} reaches nothing heavy`, () => {
    const { files, reached, unresolved } = importClosure(module);
    expect(unresolved).toBe(false);
    const offenders = reached.flatMap(({ from, specifier }) =>
      banned(specifier) === undefined ? [] : [`${from} -> ${specifier}`],
    );
    expect(offenders).toEqual([]);
    // The per-file rule checks frame modules only, so a pending module one
    // imports is a frame module as well.
    expect(
      [...files]
        .filter((file) => file.endsWith(".pending.tsx") && !isFrameModule(file))
        .map((file) => repoRelativePath(REPOSITORY_ROOT, file)),
    ).toEqual([]);
  });
}

test("the closure walk reaches a banned module when one is imported", () => {
  // A known-heavy module, so a walk that silently stops early fails here.
  const { reached } = importClosure("@stll/ui/menu");
  expect(reached.some(({ specifier }) => banned(specifier) !== undefined)).toBe(
    true,
  );
});
