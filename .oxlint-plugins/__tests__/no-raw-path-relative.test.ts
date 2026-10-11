import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string, sourcePath = "scripts/path-consumer.ts") =>
  await lintSingleRule("no-raw-path-relative", source, { sourcePath });

test("reports raw relative calls through identifiers", async () => {
  expect(
    await lint(
      'import path from "node:path";\nconst relative = path.relative;\nrelative(root, file);',
    ),
  ).toEqual([3]);
});

test("reports injected path relative calls", async () => {
  expect(
    await lint(
      'import path from "node:path";\nconst locate = (root, file, pathApi = path) => pathApi.relative(root, file);',
    ),
  ).toEqual([2]);
});

test("reports native separators combined with portable identifiers", async () => {
  expect(
    await lint(
      'import path from "node:path";\nimport { repoRelativePath } from "@stll/portable-path";\nconst relative = repoRelativePath(root, file);\nrelative + path.sep;',
    ),
  ).toEqual([4]);
});

test("accepts portable helpers and the owner module", async () => {
  expect(
    await lint(
      'import { repoRelativePath } from "@stll/portable-path";\nrepoRelativePath(root, file);',
    ),
  ).toEqual([]);
  expect(
    await lint(
      'import path from "node:path";\npath.relative(root, file);',
      "packages/portable-path/src/index.ts",
    ),
  ).toEqual([]);
});
