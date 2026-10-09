import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports independent verdict discrimination",
    source: 'const matches = prop.tool.type === "playbook-verdict";',
    lines: [1],
    sourcePath: "apps/web/src/components/properties.ts",
  },
  {
    title: "allows the pairing owner",
    source: 'const matches = prop.tool.type === "playbook-verdict";',
    lines: [],
    sourcePath: "apps/web/src/lib/workspaces/playbook-verdicts.ts",
  },
  {
    title: "allows unrelated kinds and shared predicates",
    source:
      'const matches = block.type === "playbook-verdict";\nconst paired = pairPlaybookVerdicts(properties);',
    lines: [],
    sourcePath: "apps/web/src/components/properties.ts",
  },
];

test.each(cases)(
  "no-unpaired-playbook-verdict: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (
        await runSingleRule("no-unpaired-playbook-verdict", source, {
          sourcePath,
        })
      ).lines,
    ).toEqual(lines);
  },
);
