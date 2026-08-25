// Ban `await (cond ? builder.chain() : builder)` — awaiting a ternary whose
// branches are different chain states of the SAME builder.
//
// A query builder's type carries its accumulated state in generics, so two
// chain states of one builder are two large, structurally different types.
// Awaiting the ternary forces TypeScript to instantiate BOTH of them and
// their union before it can resolve `Awaited<>` over that union. One such
// line (`await (lock ? query.for("update") : query)` over a Drizzle builder)
// cost +5.2% instantiations against the repo's typecheck baseline, found by
// bisecting a baseline failure.
//
// The rewrite is mechanical and semantics-preserving: the condition is
// evaluated before either branch either way, so awaiting inside each branch
// resolves `Awaited<>` against one concrete builder type at a time and never
// instantiates the union.
//
// Flagged (same root, chain shapes differ):
//   await (lock ? query.for("update") : query)
//   await (paged ? query.limit(10) : query.limit(10).offset(20))
//   await (lock ? (paged ? query.limit(10) : query) : query)
//   await (lock ? buildQuery().for("update") : buildQuery())
//
// Allowed:
//   lock ? await query.for("update") : await query   // the rewrite
//   await (lock ? queryA.limit(10) : queryB.limit(10))  // different roots
//   await (lock ? rowsA : rowsB)                     // no chains at all
//   await (paged ? loadRows(1) : loadRows(2))        // same call, one type
//   const q = lock ? query.for("update") : query     // not awaited
//
// `--fix` performs the branchwise-await rewrite when the await directly wraps
// the conditional. TypeScript wrappers around the whole conditional remain a
// diagnostic because moving the wrapper into each branch requires a semantic
// choice about which expression the assertion should constrain.
//
// Also allowed, and the reason detection is not merely "steps differ":
//   await (json ? response.json() : response.text())  // siblings, no builder
//   await (primary ? jobs.primary : jobs.secondary)   // siblings, no builder
//
// Detection: flatten nested ternaries to their leaf branches, resolve each
// leaf to a root (an identifier or `this`) plus the sequence of member/call
// steps applied to it, then flag when every leaf shares one root AND some
// leaf's steps are a strict prefix of another's.
//
// The prefix relation is the shape that produces the union: a builder union
// comes from chaining more onto the same builder, so one branch's steps always
// extend the other's. Two sibling paths off one object are ordinary code with
// different types and no builder, and flagging them would block correct
// awaited ternaries that have no cheap rewrite. Identical sequences with
// different arguments (`q.where(a)` vs `q.where(b)`) resolve to one type and
// are left alone, which is also what keeps `loadRows(1)` / `loadRows(2)` out
// of scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName } from "./utils.ts";

const AWAIT_KEYWORD_LENGTH = "await".length;

// Peel TS-only and optional-chain wrappers so a shape check sees the
// underlying expression.
const unwrapWrappers = (node) => {
  if (
    node?.type === "TSAsExpression" ||
    node?.type === "TSSatisfiesExpression" ||
    node?.type === "TSNonNullExpression" ||
    node?.type === "TSInstantiationExpression" ||
    node?.type === "ChainExpression"
  ) {
    return unwrapWrappers(node.expression);
  }
  return node ?? null;
};

// Flatten a ternary into its leaf branches, so a nested ternary is compared
// leaf-to-leaf rather than treated as one opaque branch.
const collectBranches = (node, branches) => {
  const expression = unwrapWrappers(node);
  if (expression?.type === "ConditionalExpression") {
    collectBranches(expression.consequent, branches);
    collectBranches(expression.alternate, branches);
    return branches;
  }
  branches.push(expression);
  return branches;
};

// Resolve an expression to its root plus the member/call steps applied to it,
// outermost step last:
//   query                      -> root "query",      steps [".for()"]…
//   query.for("update")        -> root "query",      steps [".for", "()"]
//   query.limit(1).offset(2)   -> root "query",      steps [".limit","()",".offset","()"]
//   buildQuery().for("update") -> root "buildQuery", steps ["()",".for","()"]
//   this.query.for("update")   -> root "this",       steps [".query",".for","()"]
// Returns null when the chain is not rooted at an identifier or `this` (a
// literal, a `new` expression, an await, …), which is not this bug class.
//
// `this` is a root like any other: a builder held on an instance
// (`this.query.for("update")`) is the same union, and bailing on it would let
// every class-based query wrapper through a guard that claims to be systemic.
const describeChain = (node) => {
  const steps: string[] = [];
  let current = unwrapWrappers(node);
  for (;;) {
    if (current === null) {
      return null;
    }
    if (current.type === "Identifier") {
      steps.reverse();
      return { root: current.name, steps };
    }
    if (current.type === "ThisExpression") {
      steps.reverse();
      return { root: "this", steps };
    }
    if (current.type === "MemberExpression") {
      // A statically known computed key is the same step as its dotted form:
      // `query["for"]()` chains exactly like `query.for()`, and collapsing
      // both to a single `[]` step would make two different chain states
      // compare equal. Only a genuinely dynamic key stays opaque.
      const property = current.computed
        ? staticComputedKey(current.property)
        : getPropertyName(current.property);
      steps.push(property === null ? "[]" : `.${property}`);
      current = unwrapWrappers(current.object);
      continue;
    }
    if (current.type === "CallExpression") {
      steps.push("()");
      current = unwrapWrappers(current.callee);
      continue;
    }
    return null;
  }
};

// The literal key of a computed member access, or null when it is dynamic.
const staticComputedKey = (property) => {
  const node = unwrapWrappers(property);
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0]?.value?.cooked ?? null;
  }
  return null;
};

// Whether `shorter` is a strict prefix of `longer`.
//
// This is the shape that produces the union, and the reason the rule is not
// simply "two different step sequences". A builder union comes from chaining
// MORE onto the same builder — `query` against `query.for("update")` — so one
// branch's steps are always a prefix of the other's. Two sibling paths off one
// object (`response.json()` against `response.text()`, `jobs.primary` against
// `jobs.secondary`) are ordinary code with no builder in sight, and flagging
// them would block correct awaited ternaries with no cheap rewrite.
const isStrictPrefix = (shorter, longer) =>
  shorter.length < longer.length &&
  shorter.every((step, index) => step === longer[index]);

// Whether these leaves are two chain states of one builder: same root, and at
// least one pair where one leaf's steps strictly extend another's.
const isBuilderChainUnion = (chains) =>
  chains.some((chain) =>
    chains.some(
      (other) =>
        isStrictPrefix(chain.steps, other.steps) ||
        isStrictPrefix(other.steps, chain.steps),
    ),
  );

export default eslintCompatPlugin({
  meta: { name: "no-awaited-builder-union" },
  rules: {
    "no-awaited-builder-union": {
      meta: {
        type: "problem",
        fixable: "code",
        messages: {
          awaitedBuilderUnion:
            "Awaiting a ternary over two chain states of `{{root}}` makes " +
            "TypeScript instantiate both builder types and their union " +
            "before it can resolve `Awaited<>` over it, which is charged " +
            "against the typecheck-cost baseline. Await inside each branch " +
            "instead (`cond ? await {{root}}.chain() : await {{root}}`): the " +
            "condition is evaluated first either way, so the rewrite " +
            "preserves semantics and resolves one concrete type at a time.",
        },
      },
      createOnce(context) {
        return {
          AwaitExpression(node) {
            const argument = unwrapWrappers(node.argument);
            if (argument?.type !== "ConditionalExpression") {
              return;
            }
            const chains = collectBranches(argument, []).map(describeChain);
            const first = chains.at(0);
            if (first === undefined || first === null) {
              return;
            }
            if (chains.some((chain) => chain === null)) {
              return;
            }
            if (chains.some((chain) => chain.root !== first.root)) {
              return;
            }
            if (!isBuilderChainUnion(chains)) {
              return;
            }
            if (node.argument.type !== "ConditionalExpression") {
              context.report({
                node,
                messageId: "awaitedBuilderUnion",
                data: { root: first.root },
              });
              return;
            }
            context.report({
              node,
              messageId: "awaitedBuilderUnion",
              data: { root: first.root },
              fix: (fixer) => {
                const awaitEnd = node.range[0] + AWAIT_KEYWORD_LENGTH;
                let removalEnd = awaitEnd;
                while (
                  /\s/u.test(context.sourceCode.text.at(removalEnd) ?? "")
                ) {
                  removalEnd += 1;
                }
                const branches = collectBranches(node.argument, []);
                return [
                  fixer.removeRange([node.range[0], removalEnd]),
                  ...branches.map((branch) =>
                    fixer.insertTextBefore(branch, "await "),
                  ),
                ];
              },
            });
          },
        };
      },
    },
  },
});
