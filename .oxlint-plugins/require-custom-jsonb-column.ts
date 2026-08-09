import { eslintCompatPlugin } from "@oxlint/plugins";
// Require the custom JSONB column in Drizzle schema files.
//
// Drizzle's stock `p.jsonb()` from drizzle-orm/pg-core hands the bun-sql
// driver a JSON-stringified value, so Postgres stores it as a JSON-string
// primitive (`jsonb_typeof = 'string'`) instead of the parsed object/array.
// The project ships a safe replacement in apps/api/src/db/columns.ts that
// routes writes through `${JSON.stringify(value)}::text::jsonb`. Schema
// files must use that custom column, never the stock pg-core `jsonb`.
//
// Flagged:
//   import * as p from "drizzle-orm/pg-core";
//   value: p.jsonb("value")                       // namespace member call
//   import { jsonb } from "drizzle-orm/pg-core";   // stock named import
//   value: jsonb("value")                          // bare stock call
//   customType<...>({ dataType: () => "jsonb" })   // hand-rolled JSONB type
//
// Allowed:
//   import { jsonb } from "@/api/db/columns";       // the safe replacement
//   value: jsonb("value")
//   apps/api/src/db/columns.ts                      // defines the safe type

import { getImportedName, isIdentifier, isStringLiteral } from "./utils.ts";

type AstNode = { type: string } & Record<string, unknown>;

type FilenameContext = {
  filename?: string;
  getFilename?: () => string;
};

const PG_CORE_MODULE = "drizzle-orm/pg-core";

// The file that legitimately defines the custom JSONB type and may reference
// pg-core's customType. Matched by suffix so it works from any cwd.
const ALLOWLISTED_FILE = "apps/api/src/db/columns.ts";

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof node.type === "string";

const filenameForContext = (context: FilenameContext): string =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

const isAllowlistedFile = (filename: string): boolean =>
  filename.endsWith(ALLOWLISTED_FILE);

// The static text of a string literal or a zero-expression template
// literal: `` `jsonb` `` and `"jsonb"` name the same SQL type, so a backtick
// literal must not bypass the rule.
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

const isJsonbLiteral = (node: unknown): boolean =>
  staticStringValue(node) === "jsonb";

// Static member name of a call target: `p.jsonb`, `p["jsonb"]`, and
// `` p[`jsonb`] `` all reach the same pg-core export, so computed string
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

// A `dataType` callback whose body yields the "jsonb" string. Covers the
// arrow-expression body `() => "jsonb"`, the block-bodied arrow
// `() => { return "jsonb"; }`, and function expressions / object-method
// shorthand `function () { return "jsonb"; }` / `dataType() { return "jsonb"; }`.
// Block bodies are scanned for a `return "jsonb"` so switching function form
// can't sidestep the guard.
const returnsJsonbLiteral = (node: unknown): boolean => {
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
    return isJsonbLiteral(node.body);
  }
  const statements = node.body.body;
  if (!Array.isArray(statements)) {
    return false;
  }
  return statements.some(
    (statement) =>
      isAstNode(statement) &&
      statement.type === "ReturnStatement" &&
      isJsonbLiteral(statement.argument),
  );
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

// `{ dataType: () => "jsonb" }` config object passed to customType.
const hasJsonbDataType = (node: unknown): boolean => {
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
      returnsJsonbLiteral(property.value),
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-custom-jsonb-column" },
  rules: {
    "require-custom-jsonb-column": {
      meta: {
        type: "problem",
        messages: {
          stockJsonbCall:
            "Do not use stock `jsonb()` from drizzle-orm/pg-core. " +
            "Import the safe `jsonb` from @/api/db/columns instead.",
          handRolledJsonbType:
            "Do not hand-roll a JSONB customType outside apps/api/src/db/columns.ts. " +
            "Import the safe `jsonb` from @/api/db/columns instead.",
        },
      },
      createOnce(context) {
        // Namespace / default bindings for drizzle-orm/pg-core, e.g. the `p`
        // in `import * as p from "drizzle-orm/pg-core"`. Used to match
        // `<ns>.jsonb(...)`.
        const pgCoreNamespaceAliases = new Set<string>();
        // Local bindings for the named `jsonb` export of pg-core. Used to
        // match bare `jsonb(...)`. A `jsonb` imported from @/api/db/columns
        // never lands here, so the safe column is not flagged.
        const pgCoreJsonbAliases = new Set<string>();
        // Local bindings for pg-core `customType`, to detect hand-rolled
        // JSONB types outside columns.ts.
        const customTypeAliases = new Set<string>();

        return {
          before() {
            pgCoreNamespaceAliases.clear();
            pgCoreJsonbAliases.clear();
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
              if (importedName === "jsonb") {
                pgCoreJsonbAliases.add(specifier.local.name);
              } else if (importedName === "customType") {
                customTypeAliases.add(specifier.local.name);
              }
            }
          },

          CallExpression(node) {
            const callee = node.callee;

            // Bare `jsonb(...)` where `jsonb` came from pg-core.
            if (isIdentifier(callee) && pgCoreJsonbAliases.has(callee.name)) {
              context.report({ node, messageId: "stockJsonbCall" });
              return;
            }

            if (!isAstNode(callee)) {
              return;
            }

            // `<ns>.jsonb(...)` (or a computed-key equivalent) where `<ns>`
            // is a pg-core namespace alias.
            const namespaceMember =
              callee.type === "MemberExpression" &&
              isIdentifier(callee.object) &&
              pgCoreNamespaceAliases.has(callee.object.name)
                ? staticMemberName(callee)
                : null;
            if (namespaceMember === "jsonb") {
              context.report({ node, messageId: "stockJsonbCall" });
              return;
            }

            // `customType<...>({ dataType: () => "jsonb" })` outside columns.ts.
            const bareCustomType =
              isIdentifier(callee) && customTypeAliases.has(callee.name);
            const namespacedCustomType = namespaceMember === "customType";

            if (!bareCustomType && !namespacedCustomType) {
              return;
            }

            const args = node.arguments;
            if (Array.isArray(args) && args.some(hasJsonbDataType)) {
              context.report({ node, messageId: "handRolledJsonbType" });
            }
          },
        };
      },
    },
  },
});
