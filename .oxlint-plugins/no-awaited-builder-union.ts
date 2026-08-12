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
// Detection: flatten nested ternaries to their leaf branches, resolve each
// leaf to a root identifier plus the sequence of member/call steps applied to
// it, then flag when every leaf shares one root and at least two leaves have
// different step sequences. Differing step sequences are what produces the
// union of builder types; identical sequences with different arguments
// (`q.where(a)` vs `q.where(b)`) resolve to one type and are left alone, which
// is also what keeps a plain `loadRows(1)` / `loadRows(2)` call out of scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName } from "./utils.ts";

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

// Resolve an expression to its root identifier plus a signature of the
// member/call steps applied to it, outermost step last:
//   query                      -> root "query",      steps ""
//   query.for("update")        -> root "query",      steps ".for()"
//   query.limit(1).offset(2)   -> root "query",      steps ".limit().offset()"
//   buildQuery().for("update") -> root "buildQuery", steps "().for()"
// Returns null when the chain is not rooted at an identifier (a literal, a
// `new` expression, an await, …), which is not this bug class.
const describeChain = (node) => {
  const steps = [];
  let current = unwrapWrappers(node);
  for (;;) {
    if (current === null) {
      return null;
    }
    if (current.type === "Identifier") {
      steps.reverse();
      return { root: current.name, steps: steps.join("") };
    }
    if (current.type === "MemberExpression") {
      const property = current.computed
        ? null
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

export default eslintCompatPlugin({
  meta: { name: "no-awaited-builder-union" },
  rules: {
    "no-awaited-builder-union": {
      meta: {
        type: "problem",
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
            if (chains.every((chain) => chain.steps === first.steps)) {
              return;
            }
            context.report({
              node,
              messageId: "awaitedBuilderUnion",
              data: { root: first.root },
            });
          },
        };
      },
    },
  },
});
