// Require the timestamptz column helper in Drizzle schema files.
//
// Drizzle's stock `timestamp()` from drizzle-orm/pg-core defaults to
// `timestamp without time zone`: the stored value has no UTC anchoring, so
// its meaning silently depends on every writer's session time zone. The
// project ships `timestamptz` in apps/api/src/db/columns.ts, which always
// sets `withTimezone: true`. Schema files must use that helper, never the
// stock pg-core `timestamp` — even with `{ withTimezone: true }` passed
// manually, so there is exactly one way to declare a timestamp column.
//
// Flagged:
//   import * as p from "drizzle-orm/pg-core";
//   at: p.timestamp("at")                            // namespace member call
//   import { timestamp } from "drizzle-orm/pg-core";  // stock named import
//   at: timestamp("at")                               // bare stock call
//   at: timestamp("at", { withTimezone: true })       // manual option object
//   customType<...>({ dataType: () => "timestamp" })  // hand-rolled naive type
//
// Allowed:
//   import { timestamptz } from "@/api/db/columns";   // the safe helper
//   at: timestamptz("at")
//   apps/api/src/db/columns.ts                        // defines the helper

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  isAstNode,
  isFileIn,
  isIdentifier,
  memberPropertyName,
  resolveImportedExpression,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const PG_CORE_MODULE = "drizzle-orm/pg-core";

// The file that legitimately defines the timestamptz helper and may call
// pg-core's timestamp. Matched by suffix so it works from any cwd.
const ALLOWLISTED_FILE = "apps/api/src/db/columns.ts";

// A naive timestamp SQL type, with or without precision. `timestamptz` and
// `timestamp with time zone` do not match. Case-insensitive with flexible
// whitespace: PostgreSQL accepts `TIMESTAMP` and multi-space/newline forms
// of the spelled-out type, so those must not bypass the rule.
const NAIVE_TIMESTAMP_TYPE =
  /^timestamp(\s*\(\s*\d+\s*\))?(\s+without\s+time\s+zone)?$/iu;

const isNaiveTimestampLiteral = (node: unknown): boolean => {
  // PostgreSQL tolerates surrounding whitespace in a spliced type name, so
  // `" timestamp "` is the same naive type; trim before matching.
  const value = staticStringValue(node)?.trim();
  return value !== undefined && NAIVE_TIMESTAMP_TYPE.test(value);
};

// `dataType` as an identifier, quoted, or statically computed key:
// `{"dataType": ...}` and `{["dataType"]: ...}` are the same key. A computed
// IDENTIFIER key (`{[dataType]: ...}`) is a variable reference, not the
// static key, so only the non-computed branch accepts identifiers.
const isDataTypeProperty = (property: AstNode): boolean => {
  const key = property.key;
  if (staticStringValue(key) === "dataType") {
    return true;
  }
  return property.computed === false && isIdentifier(key, "dataType");
};

// A `dataType` callback whose body yields a naive timestamp string. Covers
// the arrow-expression body `() => "timestamp"`, the block-bodied arrow
// `() => { return "timestamp"; }`, and function expressions / object-method
// shorthand. Block bodies are scanned for a matching `return` so switching
// function form can't sidestep the guard.
const returnsNaiveTimestampLiteral = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  if (
    node.type !== "ArrowFunctionExpression" &&
    node.type !== "FunctionExpression"
  ) {
    return false;
  }
  if (!isAstNode(node.body)) {
    return false;
  }
  if (node.body.type !== "BlockStatement") {
    return isNaiveTimestampLiteral(node.body);
  }
  const statements = node.body.body;
  if (!Array.isArray(statements)) {
    return false;
  }
  return statements.some(
    (statement) =>
      isAstNode(statement) &&
      statement.type === "ReturnStatement" &&
      isNaiveTimestampLiteral(statement.argument),
  );
};

// `{ dataType: () => "timestamp" }` config object passed to customType.
const hasNaiveTimestampDataType = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "ObjectExpression") {
    return false;
  }
  const properties = node.properties;
  if (!Array.isArray(properties)) {
    return false;
  }
  return properties.some(
    (property) =>
      isAstNode(property) &&
      property.type === "Property" &&
      isDataTypeProperty(property) &&
      returnsNaiveTimestampLiteral(property.value),
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-timestamptz-column" },
  rules: {
    "require-timestamptz-column": {
      meta: {
        type: "problem",
        messages: {
          stockTimestampCall:
            "Do not use stock `timestamp()` from drizzle-orm/pg-core; it " +
            "defaults to `timestamp without time zone`. Import `timestamptz` " +
            "from @/api/db/columns instead.",
          handRolledTimestampType:
            "Do not hand-roll a naive timestamp customType outside " +
            "apps/api/src/db/columns.ts. Import `timestamptz` from " +
            "@/api/db/columns instead.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return !isFileIn(context, [ALLOWLISTED_FILE]);
          },
          CallExpression(node) {
            let imported = resolveImportedExpression(context, node.callee);
            if (imported === null) {
              const callee = unwrapExpression(node.callee);
              if (callee?.type === "MemberExpression") {
                const namespace = resolveImportedExpression(
                  context,
                  callee.object,
                );
                const member = memberPropertyName(callee);
                // Keep the existing default-member guard, resolving the
                // default import's identity rather than its local spelling.
                if (
                  namespace?.source === PG_CORE_MODULE &&
                  namespace.imported === "default" &&
                  member !== null
                ) {
                  imported = { source: PG_CORE_MODULE, imported: member };
                }
              }
            }
            if (imported?.source !== PG_CORE_MODULE) {
              return;
            }
            if (imported.imported === "timestamp") {
              context.report({ node, messageId: "stockTimestampCall" });
              return;
            }
            if (imported.imported !== "customType") {
              return;
            }

            const args = node.arguments;
            if (Array.isArray(args) && args.some(hasNaiveTimestampDataType)) {
              context.report({ node, messageId: "handRolledTimestampType" });
            }
          },
        };
      },
    },
  },
});
