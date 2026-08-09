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

import { eslintCompatPlugin, type Ranged } from "@oxlint/plugins";

import { getImportedName, isIdentifier, isStringLiteral } from "./utils.ts";

type AstNode = Ranged & { type: string } & Record<string, unknown>;

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
};

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

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const filenameForContext = (context: RuleContext): string =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

const isAllowlistedFile = (filename: string): boolean =>
  filename.endsWith(ALLOWLISTED_FILE);

// The static text of a string literal or a zero-expression template
// literal: `` `timestamp` `` and `"timestamp"` name the same SQL type, so a
// backtick literal must not bypass the rule.
const staticStringValue = (node: unknown): string | null => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (!isAstNode(node) || node.type !== "TemplateLiteral") {
    return null;
  }
  const expressions = node.expressions;
  const quasis = node.quasis;
  if (!Array.isArray(expressions) || expressions.length !== 0) {
    return null;
  }
  if (!Array.isArray(quasis) || quasis.length !== 1) {
    return null;
  }
  const quasi = quasis[0];
  if (!isAstNode(quasi)) {
    return null;
  }
  const value = quasi.value;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const cooked = (value as { cooked?: unknown }).cooked;
  return typeof cooked === "string" ? cooked : null;
};

const isNaiveTimestampLiteral = (node: unknown): boolean => {
  // PostgreSQL tolerates surrounding whitespace in a spliced type name, so
  // `" timestamp "` is the same naive type; trim before matching.
  const value = staticStringValue(node)?.trim();
  return value !== undefined && NAIVE_TIMESTAMP_TYPE.test(value);
};

// Static member name of a call target: `p.timestamp`, `p["timestamp"]`, and
// `` p[`timestamp`] `` all reach the same pg-core export, so computed string
// keys must not bypass the rule.
const staticMemberName = (callee: AstNode): string | null => {
  if (callee.type !== "MemberExpression") {
    return null;
  }
  if (callee.computed === false) {
    return isIdentifier(callee.property) ? callee.property.name : null;
  }
  return staticStringValue(callee.property);
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
        // Namespace / default bindings for drizzle-orm/pg-core, e.g. the `p`
        // in `import * as p from "drizzle-orm/pg-core"`. Used to match
        // `<ns>.timestamp(...)`.
        const pgCoreNamespaceAliases = new Set<string>();
        // Local bindings for the named `timestamp` export of pg-core. Used to
        // match bare `timestamp(...)`. A `timestamptz` imported from
        // @/api/db/columns never lands here, so the safe helper is not
        // flagged.
        const pgCoreTimestampAliases = new Set<string>();
        // Local bindings for pg-core `customType`, to detect hand-rolled
        // naive timestamp types outside columns.ts.
        const customTypeAliases = new Set<string>();

        return {
          before() {
            pgCoreNamespaceAliases.clear();
            pgCoreTimestampAliases.clear();
            customTypeAliases.clear();
            return !isAllowlistedFile(filenameForContext(context));
          },
          ImportDeclaration(node) {
            if (
              node.source === null ||
              node.source === undefined ||
              typeof node.source !== "object"
            ) {
              return;
            }
            const source = (node.source as { value?: unknown }).value;
            if (source !== PG_CORE_MODULE) {
              return;
            }

            const specifiers = node.specifiers;
            if (!Array.isArray(specifiers)) {
              return;
            }

            for (const specifier of specifiers) {
              if (!isAstNode(specifier)) {
                continue;
              }

              if (
                specifier.type === "ImportNamespaceSpecifier" ||
                specifier.type === "ImportDefaultSpecifier"
              ) {
                if (isIdentifier(specifier.local)) {
                  pgCoreNamespaceAliases.add(specifier.local.name);
                }
                continue;
              }

              if (specifier.type !== "ImportSpecifier") {
                continue;
              }

              const importedName = getImportedName(specifier);
              if (!isIdentifier(specifier.local)) {
                continue;
              }
              if (importedName === "timestamp") {
                pgCoreTimestampAliases.add(specifier.local.name);
              } else if (importedName === "customType") {
                customTypeAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;

            // Bare `timestamp(...)` where `timestamp` came from pg-core.
            if (
              isIdentifier(callee) &&
              pgCoreTimestampAliases.has(callee.name)
            ) {
              context.report({ node, messageId: "stockTimestampCall" });
              return;
            }

            if (!isAstNode(callee)) {
              return;
            }

            // `<ns>.timestamp(...)` (or a computed-key equivalent) where
            // `<ns>` is a pg-core namespace alias.
            const namespaceMember =
              callee.type === "MemberExpression" &&
              isIdentifier(callee.object) &&
              pgCoreNamespaceAliases.has(callee.object.name)
                ? staticMemberName(callee)
                : null;
            if (namespaceMember === "timestamp") {
              context.report({ node, messageId: "stockTimestampCall" });
              return;
            }

            // `customType<...>({ dataType: () => "timestamp" })` outside
            // columns.ts.
            const bareCustomType =
              isIdentifier(callee) && customTypeAliases.has(callee.name);
            const namespacedCustomType = namespaceMember === "customType";

            if (!bareCustomType && !namespacedCustomType) {
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
