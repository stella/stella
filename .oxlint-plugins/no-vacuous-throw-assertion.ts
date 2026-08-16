import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isAstNode, isCallTo } from "./utils.ts";

// Require throw assertions to name the error they expect.
//
// `expect(() => parse(bad)).toThrow()` passes for ANY thrown value. A test
// written to pin "rejects an identifier containing a quote" keeps passing once
// the function starts throwing a NOT NULL violation, a TypeError from a renamed
// field, or an import-time failure: the assertion cannot tell those apart from
// the error it was written for. The test then reports on the presence of a
// throw rather than on the contract, and silently stops guarding the behavior
// it was added for.
//
// Flagged: `.toThrow()` and `.toThrowError()` with no argument, on a chain
// rooted at `expect(...)`, including the `.rejects` and `.resolves` forms.
//
// Accepted: any argument at all (message substring, regex, error class, error
// instance, object carrying `message`), because each of them discriminates
// between errors. `.not.toThrow()` is accepted and takes no argument by design:
// it asserts the absence of every error, so there is nothing to name.
//
// Boundary: this is a syntax check on the assertion shape. It cannot prove the
// supplied matcher is specific enough (`.toThrow("")` still matches
// everything), only that the call site made a choice.

const THROW_MATCHERS = new Set(["toThrow", "toThrowError"]);
const NEGATION_PROPERTY = "not";
const EXPECT_CALLEE = "expect";

const staticPropertyName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "MemberExpression") {
    return null;
  }
  if (node.computed !== false) {
    return null;
  }
  return getPropertyName(node.property);
};

type ChainShape = { negated: boolean; rootedAtExpect: boolean };

// Walk the member chain beneath the matcher. `expect(x).rejects.toThrow` has
// `.rejects` under the matcher and the `expect(x)` call at the root.
const describeChain = (start: unknown): ChainShape => {
  let current = start;
  let negated = false;

  while (isAstNode(current) && current.type === "MemberExpression") {
    if (staticPropertyName(current) === NEGATION_PROPERTY) {
      negated = true;
    }
    current = current.object;
  }

  return { negated, rootedAtExpect: isCallTo(current, EXPECT_CALLEE) };
};

export default eslintCompatPlugin({
  meta: { name: "no-vacuous-throw-assertion" },
  rules: {
    "no-vacuous-throw-assertion": {
      meta: {
        type: "problem",
        messages: {
          vacuousThrow:
            "`{{matcher}}()` with no argument passes for any thrown value, " +
            "so it stops guarding the failure it was written for. Name the " +
            "expected error: a message substring, a regex, an error class, " +
            "or an object with `message`.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (node.arguments.length > 0) {
              return;
            }
            const matcher = staticPropertyName(node.callee);
            if (matcher === null || !THROW_MATCHERS.has(matcher)) {
              return;
            }
            if (!isAstNode(node.callee)) {
              return;
            }
            const { negated, rootedAtExpect } = describeChain(
              node.callee.object,
            );
            if (negated || !rootedAtExpect) {
              return;
            }
            context.report({
              node,
              messageId: "vacuousThrow",
              data: { matcher },
            });
          },
        };
      },
    },
  },
});
