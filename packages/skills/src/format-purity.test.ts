import { expect, test } from "bun:test";
import { realpathSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const sourceRoot = realpathSync(import.meta.dir);
const repositoryRoot = realpathSync(path.join(sourceRoot, "../../.."));
const transpiler = new Bun.Transpiler({ loader: "ts" });

test("the format import graph excludes generated skill content", () => {
  const pending = [realpathSync(path.join(sourceRoot, "format.ts"))];
  const visited = new Set<string>();
  const violations: string[] = [];

  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);

    for (const dependency of transpiler.scanImports(
      readFileSync(file, "utf-8"),
    )) {
      if (dependency.path.endsWith(".md")) {
        violations.push(
          `${repoRelativePath(repositoryRoot, file)} imports ${dependency.path}`,
        );
        continue;
      }

      const resolved = realpathSync(
        Bun.resolveSync(dependency.path, path.dirname(file)),
      );
      if (!resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
        continue;
      }
      if (/\.gen\.[cm]?[jt]sx?$/u.test(resolved)) {
        violations.push(repoRelativePath(repositoryRoot, resolved));
        continue;
      }
      pending.push(resolved);
    }
  }

  expect(violations).toEqual([]);
});
