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

import { getImportedName, isIdentifier } from "./utils.ts";

type AstNode = { type: string } & Record<string, unknown>;

type RuleContext = {
  filename?: string;
  getFilename?: () => string;
  report: (diagnostic: { node: unknown; messageId: string }) => void;
};

const PG_CORE_MODULE = "drizzle-orm/pg-core";

// The file that legitimately defines the custom JSONB type and may reference
// pg-core's customType. Matched by suffix so it works from any cwd.
const ALLOWLISTED_FILE = "apps/api/src/db/columns.ts";

const isAstNode = (node: unknown): node is AstNode =>
  typeof node === "object" &&
  node !== null &&
  "type" in node &&
  typeof (node as { type: unknown }).type === "string";

const filenameForContext = (context: RuleContext): string =>
  (context.filename ?? context.getFilename?.() ?? "").replaceAll("\\", "/");

const isAllowlistedFile = (filename: string): boolean =>
  filename.endsWith(ALLOWLISTED_FILE);

// `() => "jsonb"` arrow body, used to detect a hand-rolled customType.
const returnsJsonbLiteral = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "ArrowFunctionExpression" &&
  isAstNode(node.body) &&
  node.body.type === "Literal" &&
  node.body.value === "jsonb";

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
      property.computed === false &&
      isIdentifier(property.key, "dataType") &&
      returnsJsonbLiteral(property.value),
  );
};

export default {
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
      create(context: RuleContext) {
        if (isAllowlistedFile(filenameForContext(context))) {
          return {};
        }

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
          ImportDeclaration(node: AstNode) {
            if (node.source == null || typeof node.source !== "object") {
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

          CallExpression(node: AstNode) {
            const callee = node.callee;

            // Bare `jsonb(...)` where `jsonb` came from pg-core.
            if (isIdentifier(callee) && pgCoreJsonbAliases.has(callee.name)) {
              context.report({ node, messageId: "stockJsonbCall" });
              return;
            }

            if (!isAstNode(callee)) {
              return;
            }

            // `<ns>.jsonb(...)` where `<ns>` is a pg-core namespace alias.
            if (
              callee.type === "MemberExpression" &&
              callee.computed === false &&
              isIdentifier(callee.object) &&
              pgCoreNamespaceAliases.has(callee.object.name) &&
              isIdentifier(callee.property, "jsonb")
            ) {
              context.report({ node, messageId: "stockJsonbCall" });
              return;
            }

            // `customType<...>({ dataType: () => "jsonb" })` outside columns.ts.
            const bareCustomType =
              isIdentifier(callee) && customTypeAliases.has(callee.name);
            const namespacedCustomType =
              callee.type === "MemberExpression" &&
              callee.computed === false &&
              isIdentifier(callee.object) &&
              pgCoreNamespaceAliases.has(callee.object.name) &&
              isIdentifier(callee.property, "customType");

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
};
