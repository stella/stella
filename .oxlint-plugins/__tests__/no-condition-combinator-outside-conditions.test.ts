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

test("accepts real handlers passed through named fold aliases", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldCondition as fold,foldConditions as folds} from "@stll/conditions";
const a=fold(node,{leaf: leaf=>leaf.value,group:(group,children)=>group.negated ? negate(children) : combine(group.combinator,children)});
const b=folds(nodes,{leaf: leaf=>leaf.value,group:({combinator,negated},children)=>combine(combinator,children,negated)});`,
      { sourcePath: "apps/api/src/lib/entity-filters.ts" },
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

test("an unused owner fold import does not exempt direct or destructured reads", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldCondition} from "@stll/conditions";
const a=node.combinator;
const {negated}=node;`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2, 3]);
});
test("keeps outside reads confined even when an owner fold is used", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldCondition} from "@stll/conditions";
const a=foldCondition(node,{leaf:leaf=>leaf.value,group:(group,children)=>combine(group.combinator,children)});
const b=node.negated;
function unrelated(group){return group.combinator;}`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([3, 4]);
});
test("accepts stable external handlers and callback aliases from namespace folds", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import * as conditions from "@stll/conditions";
const combineGroup=({combinator,negated},children)=>combine(combinator,children,negated);
const groupAlias=combineGroup;
const handlers={leaf:leaf=>leaf.value,group:groupAlias};
const handlerAlias=handlers;
conditions.foldConditions(nodes,handlerAlias);`,
      { sourcePath: "apps/web/src/lib/view-kind-filters.ts" },
    ),
  ).toEqual([]);
});
test("does not exempt reads evaluating fold arguments or noncallback handler values", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldCondition} from "@stll/conditions";
foldCondition(select(node.combinator),{leaf:leaf=>leaf.value,group:select(node.negated)});`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2, 2]);
});
test("does not treat a shadowed fold parameter as an owner callback", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldCondition} from "@stll/conditions";
function local(foldCondition){return foldCondition(node,{leaf:leaf=>leaf.value,group:(group,children)=>combine(group.combinator,children)});}`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});
test("keeps foreign fold callback reads outside the owner boundary", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldCondition} from "other-conditions";
foldCondition(node,{leaf:leaf=>leaf.value,group:({negated},children)=>combine(children,negated)});`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});
test("allows callback closures but does not exempt unrelated helper definitions", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldCondition} from "@stll/conditions";
function outside(group){return group.negated;}
foldCondition(node,{leaf:leaf=>leaf.value,group:(group,children)=>{const read=()=>group.combinator;return combine(read(),children);}});`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});

test("accepts typed handlers declared after their fold consumer", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import {foldConditions} from "@stll/conditions";
import type {FoldHandlers} from "@stll/conditions";
const compile=(nodes)=>foldConditions(nodes,kindHandlers);
const leaf:FoldHandlers<string>["leaf"]=node=>node.type;
const group:FoldHandlers<string>["group"]=(node,children)=>node.negated ? negate(children) : combine(node.combinator,children);
const kindHandlers:FoldHandlers<string>={leaf,group};`,
      {
        sourcePath:
          "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters.ts",
      },
    ),
  ).toEqual([]);
});

test("accepts named function declarations used as real group callbacks", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import { foldCondition } from "@stll/conditions";
function group(node, children) { return combine(node.combinator, children, node.negated); }
foldCondition(node, { leaf: leaf => leaf.value, group });`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([]);
});

test("accepts callbacks supplied by a known stable handlers spread", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import { foldCondition } from "@stll/conditions";
const base = { leaf: leaf => leaf.value, group: (node, children) => combine(node.combinator, children, node.negated) };
const handlers = { ...base };
foldCondition(node, handlers);`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([]);
});

test("does not exempt an old callback overwritten by a null spread property", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import { foldCondition } from "@stll/conditions";
const oldGroup = (node, children) => combine(node.combinator, children);
const replacement = { group: null };
foldCondition(node, { leaf: leaf => leaf.value, group: oldGroup, ...replacement });`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});

test("unknown computed writes cannot exempt an overwritten callback", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import { foldCondition } from "@stll/conditions";
const oldGroup = (node, children) => combine(node.combinator, children);
foldCondition(node, { leaf: leaf => leaf.value, group: oldGroup, [key]: replacement, group: (node, children) => combine(node.negated, children) });`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});

test("an explicit last callback remains known after an opaque spread", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import { foldCondition } from "@stll/conditions";
const oldGroup = (node, children) => combine(node.combinator, children);
foldCondition(node, { leaf: leaf => leaf.value, group: oldGroup, ...unknownHandlers, group: (node, children) => combine(node.negated, children) });`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});

test("does not exempt a callback replaced through a handlers alias", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import { foldCondition } from "@stll/conditions";
const oldGroup = (node, children) => combine(node.combinator, children);
const handlers = { leaf: leaf => leaf.value, group: oldGroup };
const alias = handlers;
alias.group = (node, children) => children;
foldCondition(node, handlers);`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});

test("destructured handlers do not resolve to their container's callbacks", async () => {
  expect(
    await lintSingleRule(
      "no-condition-combinator-outside-conditions",
      `import { foldCondition } from "@stll/conditions";
const direct = node => node.combinator;
const { ignored: handlers } = { ignored: { leaf: node => node.value, group: (node, children) => children }, group: direct };
foldCondition(node, handlers);`,
      { sourcePath: "apps/api/src/lib/read.ts" },
    ),
  ).toEqual([2]);
});
