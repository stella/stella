import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import path from "node:path";

import { walkStaticImportGraph } from "./static-import-graph";

const sourceRoot = realpathSync(import.meta.dir);
const repositoryRoot = realpathSync(path.join(sourceRoot, "../../.."));

test("the format import graph excludes generated skill content", () => {
  const violations: string[] = [];
  walkStaticImportGraph({
    entries: [path.join(sourceRoot, "format.ts")],
    shouldTraverse: (file) => file.startsWith(`${repositoryRoot}${path.sep}`),
    onImport: ({ importer, specifier, resolved }) => {
      if (specifier.endsWith(".md")) {
        violations.push(
          `${path.relative(repositoryRoot, importer)} imports ${specifier}`,
        );
        return;
      }
      if (resolved !== null && /\.gen\.[cm]?[jt]sx?$/u.test(resolved)) {
        violations.push(path.relative(repositoryRoot, resolved));
      }
    },
  });

  expect(violations).toEqual([]);
});
