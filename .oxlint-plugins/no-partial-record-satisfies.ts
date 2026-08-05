// Ban `<object literal> satisfies Partial<Record<Union, T>>` (with or
// without a leading `as const`).
//
// A const object literal pinned with `satisfies` against a `Record` keyed by
// a union declares itself the classification of every union member —
// `satisfies` fails typecheck the moment a new member is added and left
// unhandled. Wrapping that `Record` in `Partial` cancels the guarantee: a
// missing member typechecks silently, so the literal can drift out of sync
// with the union with no compiler signal. That silent-drift surface caused a
// consent-classification bug in chat (a newly added tool fell through a
// `Partial<Record<...>>` lookup instead of failing typecheck).
//
// `Readonly<...>` wrapping either side (`Readonly<Partial<Record<...>>>` or
// `Partial<Readonly<Record<...>>>`) is unwrapped before the check, since it
// changes mutability, not totality.
//
// Only the `satisfies` expression on an object literal is flagged. Plain
// type-annotation positions (`const x: Partial<Record<...>> = {...}`),
// function parameters, and variable/return type annotations are exempt:
// those are legitimate uses (override inputs, accumulators, genuinely sparse
// data) and carry no compiler guarantee of totality to lose.
//
// Flagged:
//   const x = {
//     a: 1,
//   } as const satisfies Partial<Record<Union, number>>;
//   const y = { a: 1 } satisfies Partial<Record<Union, number>>;
//   const z = {
//     a: 1,
//   } as const satisfies Readonly<Partial<Record<Union, number>>>;
//
// Allowed:
//   const x = {
//     a: 1,
//   } as const satisfies Record<Union, number>;
//   const fn = (overrides: Partial<Record<Union, number>>) => overrides;
//   let acc: Partial<Record<Union, number>> = {};
//   type Sparse = Partial<Record<Union, number>>;
//
// Fix by making the record total over the union — an explicit "none" /
// `false` / `null` value for members where nothing applies forces a new
// union member to be classified before it typechecks. If only a subset of
// the union is ever relevant, derive a narrower union for the keys instead
// of falling back to `Partial`. For genuinely sparse data where absence has
// documented meaning (e.g. an unbounded key space), add an eslint-disable
// with a comment naming what absence means.

import { isIdentifier } from "./utils.ts";

const unwrapReadonlyType = (typeNode) => {
  if (
    typeNode?.type === "TSTypeReference" &&
    isIdentifier(typeNode.typeName, "Readonly")
  ) {
    return typeNode.typeArguments?.params?.at(0) ?? null;
  }
  return typeNode;
};

// Matches `Partial<Record<...>>`, unwrapping a `Readonly<...>` wrapper on
// either the outer (`Readonly<Partial<Record<...>>>`) or inner
// (`Partial<Readonly<Record<...>>>`) type.
const isPartialRecordType = (typeNode) => {
  const outer = unwrapReadonlyType(typeNode);
  if (
    outer?.type !== "TSTypeReference" ||
    !isIdentifier(outer.typeName, "Partial")
  ) {
    return false;
  }
  const inner = unwrapReadonlyType(outer.typeArguments?.params?.at(0) ?? null);
  return (
    inner?.type === "TSTypeReference" && isIdentifier(inner.typeName, "Record")
  );
};

// Matches an object literal, or an object literal wrapped in `as const`.
const isObjectLiteralExpression = (node) => {
  if (node?.type === "ObjectExpression") {
    return true;
  }
  if (
    node?.type === "TSAsExpression" &&
    node.typeAnnotation?.type === "TSTypeReference" &&
    isIdentifier(node.typeAnnotation.typeName, "const")
  ) {
    return isObjectLiteralExpression(node.expression);
  }
  return false;
};

export default {
  meta: { name: "no-partial-record-satisfies" },
  rules: {
    "no-partial-record-satisfies": {
      meta: {
        type: "problem",
        messages: {
          noPartialRecordSatisfies:
            "Don't pin an object literal with `satisfies Partial<Record<...>>` " +
            "— Partial cancels the totality check satisfies would otherwise " +
            "give you, so a union member can silently fall through. Make the " +
            "record total (explicit 'none'/false/null per member), narrow the " +
            "key union, or add an eslint-disable naming what absence means " +
            "for genuinely sparse data.",
        },
      },
      create(context) {
        return {
          TSSatisfiesExpression(node) {
            if (!isPartialRecordType(node.typeAnnotation)) {
              return;
            }
            if (!isObjectLiteralExpression(node.expression)) {
              return;
            }
            context.report({ node, messageId: "noPartialRecordSatisfies" });
          },
        };
      },
    },
  },
};
