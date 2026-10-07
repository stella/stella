import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects member and destructured condition semantics", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      "const a = node.combinator;\nconst b = node.negated;\nconst { combinator, negated } = node;\nconst read = ({ negated }: Shape) => negated;",
      { sourcePath: "apps/web/src/components/condition.ts" },
    ),
  ).toEqual([1, 2, 3, 3, 4]);
});

test("accepts reads inside aliased executable folds from the condition owner", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      'import { foldCondition as fold, foldConditions as folds } from "@stll/conditions";\nconst a = fold(node, (group) => group.combinator);\nconst b = folds(nodes, ({ negated }) => negated);',
      { sourcePath: "apps/web/src/components/condition.ts" },
    ),
  ).toEqual([]);
});

test("type-only folds cannot exempt condition reads", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      'import type { foldCondition } from "@stll/conditions";\nimport { type foldConditions } from "@stll/conditions";\nconst a = node.combinator;\nconst b = node.negated;',
      { sourcePath: "apps/web/src/components/condition.ts" },
    ),
  ).toEqual([3, 4]);
});

test("accepts node construction and documented computed-access boundary", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      'const built = { combinator: "and", negated: false };\nconst a = node[key];\nconst b = node.label;',
      { sourcePath: "apps/web/src/components/condition.ts" },
    ),
  ).toEqual([]);
});

test("exempts condition owners and test sources", async () => {
  for (const sourcePath of [
    "packages/conditions/src/read.ts",
    "packages/workspace-ui/src/read.ts",
    "apps/web/src/condition.test.ts",
  ]) {
    expect(
      await lintSingleRule(
        "no-condition-combinator-outside-conditions",
        "const a = node.combinator;",
        { sourcePath },
      ),
    ).toEqual([]);
  }
});

test("does not trust same-named folds from another module", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      'import { foldCondition, foldConditions as folds } from "other-conditions";\nconst a = node.combinator;\nconst { negated } = node;',
      { sourcePath: "apps/web/src/components/condition.ts" },
    ),
  ).toEqual([2, 3]);
});
