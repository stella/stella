// Request schemas must bound every string and array they accept.
//
// Elysia validates a request against its TypeBox schema before the handler
// runs, so the schema is the one place a size limit is enforced for every
// entry point (HTTP, generated MCP capabilities, the CLI). A bare `t.String()`
// accepts any length up to the body parser's ceiling, and a bare `t.Array()`
// any element count; the handler then pays for it in memory, database writes,
// search terms, or model tokens. Bound strings with `maxLength` (the shared
// `tDefaultVarchar`, `tUserId`, `tSafeId`, `tUuid`, and `tPaginationCursor`
// in `@/api/lib/custom-schema` already carry one) and arrays with `maxItems`.
//
// Detection is syntactic, and it only inspects positions that are request
// schemas by construction, so response and internal schemas stay out of
// scope:
//
//   1. The value of a `body`, `query`, `params`, or `headers` property of any
//      object literal, when that value is a TypeBox builder call (`t.*`,
//      `Type.*`, `workspaceParams(...)`) or a same-file binding to one. This
//      covers handler `config` objects, `createSafe*Handler({ ... })`, and
//      Elysia route options alike. A value of any other shape (a fetch
//      `headers` object, a `JSON.stringify` body) is not a schema and is
//      ignored, and so is a schema field that happens to be named `body`
//      (`t.Object({ body: t.String() })`). `response` is never read.
//   2. A module-level `const` whose name ends in `Body`, `Query`, `Params`, or
//      `Headers`, optionally followed by `Schema` (`createRateTableBodySchema`,
//      `tListQuery`), initialised with a TypeBox builder. This is the repo's
//      naming for request schemas that live in a shared `schemas.ts` and are
//      imported into the config from another file, which syntax analysis
//      cannot follow.
//
// Within a request schema the walk descends through `t.Object` properties,
// `t.Array` items, `t.Record` values, and the arguments of the composing
// builders (`Optional`, `Nullable`, `Union`, `Intersect`, `Composite`,
// `Partial`, `Pick`, ...), following same-file `const` bindings. It reports:
//
//   - `t.String()` whose options object has no `maxLength` (a `format` of
//     `uuid` or `date` is fixed-width and accepted; `date-time` is not, its
//     fraction digits are unbounded);
//   - `t.Array(items)` whose options object has no `maxItems`.
//
//   - `t.File()` whose options have no `maxSize`, and `t.Files()` without
//     both `maxSize` and `maxItems` (multipart bodies are buffered whole, so
//     the schema is the only per-field limit).
//
// Same-file `const` aliases are followed through chains (`const b = a`).
// Accepted without proof: an options argument that is not an object literal,
// or one containing a spread (the bound may come from the spread), and any
// imported schema or helper call, which is judged where it is defined. A
// `cursor` whose schema is an inline `t.String(...)`, bare or in
// `t.Optional(...)`, is left to `require-pagination-cursor-schema`, which
// reports exactly those shapes; other cursor schemas are walked here.
//
// Known blind spots: `t.Record` keys, `t.RegExp`, schemas assembled at
// runtime, and request schemas whose const name does not follow the naming
// above and that are imported from another file.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const REQUEST_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "body",
  "query",
  "params",
  "headers",
]);

const REQUEST_SCHEMA_CONST_NAME = /(?:Body|Query|Params|Headers)(?:Schema)?$/u;

const TYPEBOX_NAMESPACES: ReadonlySet<string> = new Set(["t", "Type"]);

// Helpers that build a `t.Object` from their first argument's properties.
const OBJECT_HELPERS: ReadonlySet<string> = new Set(["workspaceParams"]);

// Fixed-width string formats; every other format still needs a `maxLength`.
const FIXED_WIDTH_FORMATS: ReadonlySet<string> = new Set(["uuid", "date"]);

// Builders that carry no string or array payload of their own.
const LEAF_BUILDERS: ReadonlySet<string> = new Set([
  "Any",
  "Boolean",
  "BooleanString",
  "Integer",
  "Literal",
  "Null",
  "Number",
  "Numeric",
  "RegExp",
  "Undefined",
  "UnionEnum",
  "Unknown",
  "Unsafe",
]);

const PAGINATION_CURSOR_KEY = "cursor";

type Finding = {
  node: AstNode;
  messageId:
    | "unboundedString"
    | "unboundedArray"
    | "unboundedFile"
    | "unboundedFiles";
};

const typeboxBuilderName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const callee = node.callee;
  if (
    !isAstNode(callee) ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false ||
    !isIdentifier(callee.object) ||
    !TYPEBOX_NAMESPACES.has(callee.object.name)
  ) {
    return null;
  }
  return getPropertyName(callee.property);
};

const isObjectHelperCall = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  isIdentifier(node.callee) &&
  OBJECT_HELPERS.has(node.callee.name);

const isSchemaBuilder = (node: unknown): boolean =>
  typeboxBuilderName(node) !== null || isObjectHelperCall(node);

const callArguments = (node: AstNode): unknown[] =>
  Array.isArray(node.arguments) ? node.arguments : [];

// Whether an options argument proves `key` is set. Missing options prove
// nothing; a non-literal or spread-bearing object is not provably unbounded.
const optionsBound = (
  options: unknown,
  accepts: (key: string, value: unknown) => boolean,
): boolean => {
  const unwrapped = unwrapExpression(options);
  if (unwrapped === null) {
    return false;
  }
  if (unwrapped.type !== "ObjectExpression") {
    return true;
  }
  const properties = Array.isArray(unwrapped.properties)
    ? unwrapped.properties
    : [];
  return properties.some((property) => {
    if (!isAstNode(property) || property.type === "SpreadElement") {
      return true;
    }
    if (property.type !== "Property" || property.computed === true) {
      return true;
    }
    const key = getPropertyName(property.key);
    return key !== null && accepts(key, property.value);
  });
};

const stringIsBounded = (options: unknown): boolean =>
  optionsBound(
    options,
    (key, value) =>
      key === "maxLength" ||
      (key === "format" &&
        isAstNode(value) &&
        value.type === "Literal" &&
        typeof value.value === "string" &&
        FIXED_WIDTH_FORMATS.has(value.value)),
  );

const arrayIsBounded = (options: unknown): boolean =>
  optionsBound(options, (key) => key === "maxItems");

const fileIsBounded = (options: unknown): boolean =>
  optionsBound(options, (key) => key === "maxSize");

// Multipart bodies are buffered whole; the per-field limits live here.
const filesAreBounded = (options: unknown): boolean =>
  fileIsBounded(options) && optionsBound(options, (key) => key === "maxItems");

// The cursor shapes `require-pagination-cursor-schema` reports: an inline
// `t.String(...)`, bare or wrapped in `t.Optional(...)`. Any other cursor
// composition is walked like every other field.
const isPaginationRuleCursor = (value: unknown): boolean => {
  let schema = unwrapExpression(value);
  if (typeboxBuilderName(schema) === "Optional" && schema !== null) {
    schema = unwrapExpression(callArguments(schema).at(0));
  }
  return typeboxBuilderName(schema) === "String";
};

const isIdentifierReference = (
  node: unknown,
): node is ESTree.IdentifierReference =>
  isIdentifier(node) && Array.isArray(node.range);

const isModuleLevelDeclarator = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const declaration = node.parent;
  if (
    !isAstNode(declaration) ||
    declaration.type !== "VariableDeclaration" ||
    declaration.kind !== "const"
  ) {
    return false;
  }
  const owner = declaration.parent;
  if (isAstNode(owner) && owner.type === "Program") {
    return true;
  }
  return (
    isAstNode(owner) &&
    owner.type === "ExportNamedDeclaration" &&
    isAstNode(owner.parent) &&
    owner.parent.type === "Program"
  );
};

// A property of an object literal passed to a schema builder is a field of
// that schema (`t.Object({ body: t.String() })`), not a request slot.
const isSchemaField = (property: unknown): boolean => {
  if (!isAstNode(property)) {
    return false;
  }
  const object = property.parent;
  return (
    isAstNode(object) &&
    object.type === "ObjectExpression" &&
    isSchemaBuilder(object.parent)
  );
};

export default eslintCompatPlugin({
  meta: { name: "require-bounded-request-schema" },
  rules: {
    "require-bounded-request-schema": {
      meta: {
        type: "problem",
        messages: {
          unboundedString:
            "Request schema string has no maxLength. Add `{ maxLength }` or " +
            "use a bounded helper from @/api/lib/custom-schema (tDefaultVarchar, " +
            "tUserId, tSafeId, tUuid, tPaginationCursor).",
          unboundedArray:
            "Request schema array has no maxItems. Add `{ maxItems }` so a " +
            "request cannot carry an unbounded element count.",
          unboundedFile:
            "Request schema file has no maxSize. Add `{ maxSize }` (see " +
            "FILE_SIZE_LIMITS in @/api/lib/limits).",
          unboundedFiles:
            "Request schema file list needs both maxSize and maxItems.",
        },
      },
      createOnce(context) {
        let reported = new Set<unknown>();

        // Follows `const b = a` chains to the first non-identifier initializer.
        const resolveSchemaInitializer = (identifier: unknown): unknown => {
          const seen = new Set<unknown>();
          let current: unknown = identifier;
          while (
            isAstNode(current) &&
            current.type === "Identifier" &&
            !seen.has(current)
          ) {
            seen.add(current);
            current = unwrapExpression(resolveConstInitializer(current));
          }
          return current === identifier ? null : current;
        };

        const resolveConstInitializer = (identifier: unknown): unknown => {
          if (!isIdentifierReference(identifier)) {
            return null;
          }
          let scope: ReturnType<typeof context.sourceCode.getScope> | null =
            context.sourceCode.getScope(identifier);
          while (scope) {
            const variable = scope.set.get(identifier.name);
            if (variable) {
              for (const def of variable.defs) {
                if (
                  def.type === "Variable" &&
                  isAstNode(def.node) &&
                  def.node.type === "VariableDeclarator" &&
                  isAstNode(def.parent) &&
                  def.parent.type === "VariableDeclaration" &&
                  def.parent.kind === "const"
                ) {
                  return def.node.init;
                }
              }
              return null;
            }
            scope = scope.upper;
          }
          return null;
        };

        const collect = (
          node: unknown,
          visited: Set<unknown>,
          findings: Finding[],
        ): void => {
          const current = unwrapExpression(node);
          if (current === null || visited.has(current)) {
            return;
          }
          visited.add(current);

          if (current.type === "Identifier") {
            const init = resolveSchemaInitializer(current);
            if (isSchemaBuilder(unwrapExpression(init))) {
              collect(init, visited, findings);
            }
            return;
          }
          if (current.type === "ArrayExpression") {
            for (const element of Array.isArray(current.elements)
              ? current.elements
              : []) {
              collect(element, visited, findings);
            }
            return;
          }
          if (current.type === "ObjectExpression") {
            for (const property of Array.isArray(current.properties)
              ? current.properties
              : []) {
              if (!isAstNode(property)) {
                continue;
              }
              if (property.type === "SpreadElement") {
                collect(property.argument, visited, findings);
                continue;
              }
              if (
                getPropertyName(property.key) === PAGINATION_CURSOR_KEY &&
                isPaginationRuleCursor(property.value)
              ) {
                continue;
              }
              collect(property.value, visited, findings);
            }
            return;
          }
          if (current.type !== "CallExpression") {
            return;
          }

          const args = callArguments(current);
          if (isObjectHelperCall(current)) {
            collect(args.at(0), visited, findings);
            return;
          }
          const builder = typeboxBuilderName(current);
          if (builder === null || LEAF_BUILDERS.has(builder)) {
            return;
          }
          switch (builder) {
            case "String":
              if (!stringIsBounded(args.at(0))) {
                findings.push({ node: current, messageId: "unboundedString" });
              }
              return;
            case "File":
              if (!fileIsBounded(args.at(0))) {
                findings.push({ node: current, messageId: "unboundedFile" });
              }
              return;
            case "Files":
              if (!filesAreBounded(args.at(0))) {
                findings.push({ node: current, messageId: "unboundedFiles" });
              }
              return;
            case "Array":
              if (!arrayIsBounded(args.at(1))) {
                findings.push({ node: current, messageId: "unboundedArray" });
              }
              collect(args.at(0), visited, findings);
              return;
            case "Object":
              // The second argument is the object's options, not a schema.
              collect(args.at(0), visited, findings);
              return;
            case "Record":
              // Keys are out of scope; see the header.
              collect(args.at(1), visited, findings);
              return;
            default:
              // Composing builders: every schema-shaped argument is part of
              // the accepted input. Option objects are not descended into.
              for (const argument of args) {
                const unwrapped = unwrapExpression(argument);
                if (unwrapped?.type !== "ObjectExpression") {
                  collect(unwrapped, visited, findings);
                }
              }
          }
        };

        const inspect = (schema: unknown): void => {
          const findings: Finding[] = [];
          collect(schema, new Set(), findings);
          for (const { node, messageId } of findings) {
            if (reported.has(node)) {
              continue;
            }
            reported.add(node);
            context.report({ node, messageId });
          }
        };

        return {
          before() {
            reported = new Set();
          },
          Property(node) {
            if (node.computed || isSchemaField(node)) {
              return;
            }
            const key = getPropertyName(node.key);
            if (key === null || !REQUEST_SCHEMA_KEYS.has(key)) {
              return;
            }
            const value = unwrapExpression(node.value);
            if (value === null) {
              return;
            }
            if (value.type === "Identifier") {
              const init = resolveSchemaInitializer(value);
              if (isSchemaBuilder(unwrapExpression(init))) {
                inspect(init);
              }
              return;
            }
            if (isSchemaBuilder(value)) {
              inspect(value);
            }
          },
          VariableDeclarator(node) {
            if (
              !isIdentifier(node.id) ||
              !REQUEST_SCHEMA_CONST_NAME.test(node.id.name) ||
              !isModuleLevelDeclarator(node) ||
              !isSchemaBuilder(unwrapExpression(node.init))
            ) {
              return;
            }
            inspect(node.init);
          },
        };
      },
    },
  },
});
