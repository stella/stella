// Tests leave a fake clock through `restoreRealTimers`
// (`@stll/property-testing/fake-timers`), never by discarding what it holds.
//
// Bun drops every pending fake timeout when real timers return, and
// `clearAllTimers` drops them on the spot. A library that keeps module state
// until its timeout fires (a component library's focus and dismiss timers)
// then never clears it, and the tests that run after it in the same file time
// out, in whichever order a shuffled run puts them. `restoreRealTimers` fires
// the pending timeouts first.
//
//   Flagged: `jest.useRealTimers()` and `jest.clearAllTimers()` on the
//     `bun:test` `jest` (named, aliased or a namespace member), and the same
//     calls on the `vitest` `vi`.
//   Allowed: `restoreRealTimers()`, `jest.runOnlyPendingTimers()`, and the
//     same method names on any other object.
//   Out of scope: a method read off `jest` into a local
//     (`const { useRealTimers } = jest`).

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  unwrapExpression,
} from "./utils.ts";

const DROPPING_METHODS: ReadonlySet<string> = new Set([
  "useRealTimers",
  "clearAllTimers",
]);

const TIMER_OWNERS = [
  { source: "bun:test", imported: "jest" },
  { source: "vitest", imported: "vi" },
  { source: "vitest", imported: "vitest" },
] as const;

export default eslintCompatPlugin({
  meta: { name: "no-dropped-fake-timers" },
  rules: {
    "no-dropped-fake-timers": {
      meta: {
        type: "problem",
        messages: {
          droppedTimers:
            "Leave fake timers with restoreRealTimers from @stll/property-testing/fake-timers: `{{method}}` discards the pending timeouts, so library state waiting on one never clears and later tests in the file time out.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (!isAstNode(callee) || callee.type !== "MemberExpression") {
              return;
            }
            const method = memberPropertyName(callee);
            if (method === null || !DROPPING_METHODS.has(method)) {
              return;
            }
            const owner = resolveImportedExpressionForEnforcement(
              context,
              callee.object,
            );
            if (
              owner === null ||
              !TIMER_OWNERS.some(
                ({ source, imported }) =>
                  owner.source === source && owner.imported === imported,
              )
            ) {
              return;
            }
            context.report({
              node,
              messageId: "droppedTimers",
              data: { method },
            });
          },
        };
      },
    },
  },
});
