import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const RULE = "no-ambient-time-in-tests";

for (const { name, rolloutType, changedLines, expected } of [
  {
    name: "unchanged legacy calls",
    rolloutType: "changed-lines",
    changedLines: [],
    expected: [],
  },
  {
    name: "a new call before an unchanged call",
    rolloutType: "changed-lines",
    changedLines: [1],
    expected: [1],
  },
  {
    name: "a changed line inside a multiline call",
    rolloutType: "changed-lines",
    changedLines: [2],
    expected: [1],
  },
  {
    name: "full enforcement once healing restores the full rollout",
    rolloutType: "full",
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
  rollouts: [{ id: ${JSON.stringify(RULE)}, type: ${JSON.stringify(rolloutType)} }],
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
