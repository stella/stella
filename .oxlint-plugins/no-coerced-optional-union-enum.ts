// Ban `t.Optional(t.UnionEnum([...]))` in Elysia schemas.
//
// Elysia coerces an ABSENT optional UnionEnum field to its FIRST
// member instead of leaving it `undefined` (verified in
// apps/api/src/lib/elysia-optional-union-coercion.test.ts). A handler
// that reads the field as "no value / no filter / use a default" when
// absent therefore silently gets the first member instead — a quiet,
// type-clean bug (e.g. a list filter collapses to one value, or a
// `?? default` becomes dead code).
//
// `t.Optional(t.Union([t.Literal(...)]))` does NOT coerce (absent ->
// `undefined`), so use that and apply any default explicitly in the
// handler.
//
// Flagged:
//   type: t.Optional(t.UnionEnum(["person", "organization"]))
//   region: t.Optional(t.UnionEnum(REGIONS))
// Allowed:
//   type: t.Optional(t.Union([t.Literal("person"), t.Literal("organization")]))
//   fieldMode: t.Optional(t.Union([t.Literal("full"), t.Literal("visible")]))
//
// `--fix` expands a namespaced call whose values are inline string literals.
// Dynamic value arrays and destructured helper calls remain diagnostics because
// the fixer cannot expand the former or prove the latter has `Union` and
// `Literal` bindings in scope.
//
// Both callees are matched by leaf name, so the namespaced
// `t.Optional(t.UnionEnum(...))` and a destructured `Optional(UnionEnum(...))`
// (`const { Optional, UnionEnum } = t`) are caught the same way.

import { eslintCompatPlugin } from "@oxlint/plugins";

// Resolve a callee's leaf name whether it is namespaced (`t.Optional`,
// a MemberExpression) or a bare/destructured `Optional` (an Identifier).
const memberName = (node) => {
  if (!node) {
    return null;
  }
  if (node.type === "Identifier") {
    return node.name;
  }
  if (
    node.type === "MemberExpression" &&
    node.property?.type === "Identifier"
  ) {
    return node.property.name;
  }
  return null;
};

const namespacedCallee = (node, expectedName) => {
  if (
    node?.type !== "MemberExpression" ||
    node.computed ||
    node.object.type !== "Identifier" ||
    node.property.type !== "Identifier" ||
    node.property.name !== expectedName
  ) {
    return null;
  }
  return node;
};

const staticUnionEnumElements = (node) => {
  if (node.arguments.length !== 1) {
    return null;
  }
  const values = node.arguments.at(0);
  if (values?.type !== "ArrayExpression") {
    return null;
  }
  if (
    values.elements.some(
      (element) =>
        element === null ||
        element.type !== "Literal" ||
        typeof element.value !== "string",
    )
  ) {
    return null;
  }
  return values.elements;
};

export default eslintCompatPlugin({
  meta: { name: "no-coerced-optional-union-enum" },
  rules: {
    "no-coerced-optional-union-enum": {
      meta: {
        type: "problem",
        fixable: "code",
        messages: {
          coerced:
            "`t.Optional(t.UnionEnum(...))` coerces an absent field to its " +
            "FIRST member, not `undefined`. Use " +
            "`t.Optional(t.Union([t.Literal(...)]))` and default explicitly " +
            "in the handler.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (memberName(node.callee) !== "Optional") {
              return;
            }
            const arg = node.arguments.at(0);
            if (
              arg?.type !== "CallExpression" ||
              memberName(arg.callee) !== "UnionEnum"
            ) {
              return;
            }
            const optionalCallee = namespacedCallee(node.callee, "Optional");
            const unionEnumCallee = namespacedCallee(arg.callee, "UnionEnum");
            const elements = staticUnionEnumElements(arg);
            if (
              optionalCallee === null ||
              unionEnumCallee === null ||
              optionalCallee.object.name !== unionEnumCallee.object.name ||
              elements === null
            ) {
              context.report({ node, messageId: "coerced" });
              return;
            }
            context.report({
              node,
              messageId: "coerced",
              fix: (fixer) => [
                fixer.replaceText(unionEnumCallee.property, "Union"),
                ...elements.flatMap((element) => [
                  fixer.insertTextBefore(
                    element,
                    `${optionalCallee.object.name}.Literal(`,
                  ),
                  fixer.insertTextAfter(element, ")"),
                ]),
              ],
            });
          },
        };
      },
    },
  },
});
