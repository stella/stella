import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import { BASELINE_PATHS } from "../scripts/baseline-paths.ts";
import { createTestDeterminismRule } from "./test-determinism-rule.ts";
import { createTimeResolver } from "./test-time-resolver.ts";
import {
  isIdentifierReference,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-wallclock-assertions-in-tests";
const EXPECT_MODULES = new Set([
  "bun:test",
  "@playwright/test",
  "@jest/globals",
  "vitest",
]);
const ORDERED_MATCHERS = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
]);

type Timing = "instant" | "elapsed" | "ratio" | null;

const rule = createTestDeterminismRule({
  baselinePath: BASELINE_PATHS.testWallclockAssertion,
  message:
    "Wall-clock assertions depend on machine load. Count the work for performance assertions; use @stll/test-kit createTestClock, settledWithin, or waitFor for deterministic timing.",
  createDetector(context) {
    const { isAmbientRead } = createTimeResolver(context);
    const timing = (input: unknown, seen = new Set<Variable>()): Timing => {
      const node = unwrapExpression(input);
      if (isAmbientRead(node)) {
        return "instant";
      }
      if (isIdentifierReference(node)) {
        const variable = resolveVariable(context, node);
        if (variable === null || seen.has(variable)) {
          return null;
        }
        seen.add(variable);
        const initial = timing(stableInitializer(variable), new Set(seen));
        if (initial !== null) {
          return initial;
        }
        for (const reference of variable.references) {
          if (!reference.isWrite()) {
            continue;
          }
          const assigned = timing(reference.writeExpr, new Set(seen));
          if (assigned !== null) {
            return assigned;
          }
        }
        return null;
      }
      if (node?.type === "CallExpression" && node.arguments.length === 0) {
        const callee = unwrapExpression(node.callee);
        if (
          callee?.type === "MemberExpression" &&
          ["getTime", "valueOf"].includes(memberPropertyName(callee) ?? "") &&
          timing(callee.object, new Set(seen)) === "instant"
        ) {
          return "instant";
        }
      }
      if (node?.type !== "BinaryExpression") {
        return null;
      }
      const left = timing(node.left, new Set(seen));
      const right = timing(node.right, new Set(seen));
      if ([left, right].includes("ratio")) {
        return "ratio";
      }
      if (node.operator === "/" && left !== null && right !== null) {
        return "ratio";
      }
      if (node.operator === "-" && left === "instant" && right === "instant") {
        return "elapsed";
      }
      if (["+", "-", "*", "/"].includes(node.operator)) {
        return left === "elapsed" || right === "elapsed" ? "elapsed" : null;
      }
      return null;
    };
    const isExpect = (input: unknown, seen = new Set<Variable>()): boolean => {
      const node = unwrapExpression(input);
      const binding = resolveImport(context, node);
      if (binding !== null) {
        return (
          EXPECT_MODULES.has(binding.moduleId) && binding.imported === "expect"
        );
      }
      if (!isIdentifierReference(node)) {
        return false;
      }
      const variable = resolveVariable(context, node);
      if (variable === null || variable.defs.length === 0) {
        return node.name === "expect";
      }
      if (seen.has(variable)) {
        return false;
      }
      seen.add(variable);
      return isExpect(stableInitializer(variable), seen);
    };
    return (node) => {
      if (node.type === "BinaryExpression") {
        return (
          node.operator === "/" &&
          timing(node.left) !== null &&
          timing(node.right) !== null
        );
      }
      if (node.type !== "CallExpression") {
        return false;
      }
      const callee = unwrapExpression(node.callee);
      if (
        callee?.type !== "MemberExpression" ||
        !ORDERED_MATCHERS.has(memberPropertyName(callee) ?? "")
      ) {
        return false;
      }
      let subject = unwrapExpression(callee.object);
      while (subject?.type === "MemberExpression") {
        subject = unwrapExpression(subject.object);
      }
      return (
        subject?.type === "CallExpression" &&
        isExpect(subject.callee) &&
        timing(subject.arguments.at(0)) === "elapsed"
      );
    };
  },
});

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: rule.meta,
      createOnce(context) {
        return rule.createOnce(context);
      },
    },
  },
});
