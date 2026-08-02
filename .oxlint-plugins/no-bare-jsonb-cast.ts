// Require `::text::jsonb` when binding a serialized value in a SQL template.
//
// An explicit `::jsonb` cast resolves the bind parameter's type to jsonb, so
// the bun-sql driver JSON-encodes the string it is handed and Postgres stores
// (or compares against) a jsonb *string* rather than the parsed object. The
// failure is silent: `IS NOT DISTINCT FROM` never matches, `@>` misses, and
// `->>'key'` reads NULL. Casting through text keeps the parameter a text value
// that Postgres parses.
//
// This is the hand-written-SQL counterpart to require-custom-jsonb-column,
// which covers the same hazard for Drizzle schema columns.
//
// Flagged:
//   sql`... ${JSON.stringify(value)}::jsonb ...`
//   const json = JSON.stringify(value); sql`... ${json}::jsonb ...`
//
// Allowed:
//   sql`... ${JSON.stringify(value)}::text::jsonb ...`
//   sql`... ${table.column}::jsonb ...`   // casting a column, not a bind
//   sql`... '[]'::jsonb ...`              // SQL literal, not a bind

import { isIdentifier } from "./utils.ts";

type AstNode = { type: string } & Record<string, unknown>;

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  typeof (node as { type?: unknown }).type === "string";

// `JSON.stringify(...)` — the only producer that yields an already-serialized
// string, which is exactly what the bare cast double-encodes.
const isJsonStringifyCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "JSON") &&
    isIdentifier(callee.property, "stringify")
  );
};

export default {
  meta: { name: "no-bare-jsonb-cast" },
  rules: {
    "no-bare-jsonb-cast": {
      meta: {
        type: "problem",
        messages: {
          bareJsonbCast:
            "Cast a serialized bind parameter with `::text::jsonb`, not a bare " +
            "`::jsonb`. The bare cast types the parameter as jsonb, so the driver " +
            "JSON-encodes the string again and Postgres sees a jsonb string " +
            "instead of the object.",
        },
      },
      create(context) {
        // Identifiers in this file bound to a JSON.stringify(...) result.
        const serializedNames = new Set<string>();

        return {
          VariableDeclarator(node: AstNode) {
            if (isIdentifier(node.id) && isJsonStringifyCall(node.init)) {
              const { name } = node.id as { name: string };
              serializedNames.add(name);
            }
          },

          TemplateLiteral(node: AstNode) {
            const expressions = Array.isArray(node.expressions)
              ? node.expressions
              : [];
            const quasis = Array.isArray(node.quasis) ? node.quasis : [];

            for (const [index, expression] of expressions.entries()) {
              const bindsSerializedValue =
                isJsonStringifyCall(expression) ||
                (isIdentifier(expression) &&
                  serializedNames.has(
                    (expression as unknown as { name: string }).name,
                  ));
              if (!bindsSerializedValue) {
                continue;
              }

              // The text directly after this interpolation carries the cast.
              // A quasi's `value` is a plain `{ raw, cooked }` record, not an
              // AST node, so it carries no `type` to narrow on.
              const following = quasis[index + 1];
              const value = isAstNode(following) ? following.value : undefined;
              const raw =
                typeof value === "object" &&
                value !== null &&
                typeof (value as { raw?: unknown }).raw === "string"
                  ? (value as { raw: string }).raw
                  : "";
              if (!raw.startsWith("::jsonb")) {
                continue;
              }

              context.report({
                node: expression,
                messageId: "bareJsonbCast",
              });
            }
          },
        };
      },
    },
  },
};
