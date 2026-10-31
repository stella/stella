import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const RULE = "no-ambient-time-in-tests";

for (const { name, now, changedLines, expected } of [
  {
    name: "unchanged legacy calls",
    now: "2026-10-31",
    changedLines: [],
    expected: [],
  },
  {
    name: "a new call before an unchanged call",
    now: "2026-10-31",
    changedLines: [1],
    expected: [1],
  },
  {
    name: "a changed line inside a multiline call",
    now: "2026-10-31",
    changedLines: [2],
    expected: [1],
  },
  {
    name: "full enforcement at the deadline",
    now: "2026-11-06",
    changedLines: [],
    expected: [3],
  },
]) {
  test(`determinism rollout preserves baseline accounting: ${name}`, async () => {
    const directory = await mkdtemp(path.join(ROOT, ".determinism-rollout-"));
    const wrapper = path.join(directory, "plugin.ts");
    const factory = path.join(ROOT, ".oxlint-plugins/test-determinism-rule.ts");
    const resolver = path.join(ROOT, ".oxlint-plugins/test-time-resolver.ts");
    const policy = path.join(ROOT, "scripts/guard-rollouts.ts");
    const portable = path.join(ROOT, "packages/portable-path/src/index.ts");
    await writeFile(
      wrapper,
      `
import { eslintCompatPlugin } from "@oxlint/plugins";
import { createTestDeterminismRule } from ${JSON.stringify(factory)};
import { createTimeResolver } from ${JSON.stringify(resolver)};
import { guardEnforcesLine } from ${JSON.stringify(policy)};
import { repoRelativePath } from ${JSON.stringify(portable)};
import path from "node:path";
const rule = createTestDeterminismRule({
  guard: ${JSON.stringify(RULE)},
  baselinePath: "scripts/test-ambient-time-baseline.json",
  message: "Ambient clock",
  createDetector: (context) => createTimeResolver(context).isAmbientRead,
}, (options) => guardEnforcesLine({
  ...options,
  now: new Date(${JSON.stringify(now)}),
  changedLines: new Map([[
    path.isAbsolute(options.file) ? repoRelativePath(${JSON.stringify(ROOT)}, options.file) : options.file,
    new Set(${JSON.stringify(changedLines)}),
  ]]),
}));
export default eslintCompatPlugin({meta:{name:${JSON.stringify(RULE)}}, rules:{[${JSON.stringify(RULE)}]:rule}});
`,
    );
    try {
      expect(
        await lintSingleRule(RULE, "Date.now(\n);\nDate.now();", {
          pluginPath: wrapper,
          sourcePath: "x.test.ts",
          settings: { testDeterminismBaseline: { "x.test.ts": 1 } },
        }),
      ).toEqual(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
