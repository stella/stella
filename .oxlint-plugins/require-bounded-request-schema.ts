// Request schemas must bound every string, array, record and file they accept.
//
// The HTTP core (apps/api/src/http) decodes a request against the route's
// valibot schemas before the handler runs, so the schema is the one place a
// size limit is enforced for every entry point (HTTP, generated MCP
// capabilities, the CLI). A bare `v.string()` accepts any length up to the
// body parser's ceiling, a bare `v.array()` any element count and a bare
// `v.record()` any key count; the handler then pays for it in memory,
// database writes, search terms, or model tokens. Bound a string with a
// `v.maxLength` step in its pipe (the shared `defaultVarcharSchema`,
// `userIdSchema`, `uuidSchema`, `resourceIdSchema(...)` and
// `paginationCursorSchema()` in `@/api/lib/custom-schema` already carry one),
// an array with `v.maxLength`, a record with `v.maxEntries`, and a file with
// `fileSchema({ maxBytes })` or a `v.maxSize` step.
//
// Detection is syntactic, and it only inspects positions that are request
// schemas by construction, so response and internal schemas stay out of
// scope:
//
//   1. The value of a `body`, `query`, `params`, or `headers` property of any
//      object literal, when that value is a valibot call (`v.*`), a request
//      schema helper (`workspaceParams`, the wire helpers of
//      `@stll/api-contract/http-input`, `withDescription`) or a same-file
//      binding to one. This covers safe-handler configs and
//      `defineEndpoint.*({ ... })` alike. A value of any other shape (a fetch
//      `headers` object, a `JSON.stringify` body) is not a schema and is
//      ignored, and so is a schema field that happens to be named `body`
//      (`v.object({ body: v.string() })`). `response` is never read.
//   2. A module-level `const` whose name ends in `Body`, `Query`, `Params`, or
//      `Headers`, optionally followed by `Schema` (`createRateTableBodySchema`),
//      initialised with one of those calls. This is the repo's naming for
//      request schemas that live in a shared `schemas.ts` and are imported
//      into the config from another file, which syntax analysis cannot follow.
//
// Within a request schema the walk descends through object entries (and the
// entries they spread in: a same-file entries object or `schema.entries`),
// array items, record values, tuple items, the options of `union`/`variant`/
// `intersect`, the optional/nullable wrappers, the schema arguments of the
// wire helpers and of any other call, and same-file `const` bindings
// (through `const b = a` chains). The bounds a `v.pipe(schema, ...steps)`
// declares apply to `schema` and to the wrappers around it, never to the
// fields of an object or the items of an array inside it. It reports:
//
//   - `v.string()` with no `maxLength`, `length`, `maxBytes`, `bytes`,
//     `maxGraphemes` or `graphemes` step, and no fixed-width format step
//     (`uuid`, `isoDate`, `isoDateTime`, `isoTime`, `isoTimeSecond`,
//     `isoWeek`; `isoTimestamp` is not fixed width, its fraction digits are
//     unbounded);
//   - `v.array(item)` and `arrayFromQuery(item)` with no `maxLength` or
//     `length` step;
//   - `v.record(key, value)` with no `maxEntries` or `entries` step;
//   - `v.file()` and `v.blob()` with no `maxSize` or `size` step (multipart
//     bodies are buffered whole, so the schema is the only per-field limit).
//
// A pipe step only counts when it is a `v.*` call or a same-file `const`
// bound to one: an imported or computed step (`uniqueItems()`) proves nothing.
// Accepted without proof: a pipe with a spread step (the bound may come from
// the spread), and any imported schema or helper, which is judged where it is
// defined. A `cursor` whose schema is an inline `v.string()`, bare, wrapped in
// optional/nullable wrappers or at the head of a pipe, is left to
// `require-pagination-cursor-schema`, which reports exactly those shapes.
//
// Known blind spots: record keys (bounded by the record's entry count, not
// their length), `v.custom`/`v.unknown` payloads, schemas assembled at
// runtime, and request schemas whose const name does not follow the naming
// above and that are imported from another file.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  unwrapExpression,
} from "./utils.ts";

const REQUEST_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  "body",
  "query",
  "params",
  "headers",
]);

const REQUEST_SCHEMA_CONST_NAME = /(?:Body|Query|Params|Headers)(?:Schema)?$/u;

const VALIBOT_NAMESPACE = "v";

// Helpers that build a `v.object` from their first argument's entries.
const OBJECT_HELPERS: ReadonlySet<string> = new Set(["workspaceParams"]);

// Request-schema helpers whose arguments are the schema they read: the wire
// helpers of `@stll/api-contract/http-input` and `withDescription`. Any other
// call is walked the same way, but only these mark a `body`/`query` value as
// a schema position.
const SCHEMA_HELPERS: ReadonlySet<string> = new Set([
  "arrayFromQuery",
  "booleanFromString",
  "jsonFromString",
  "numberFromString",
  "withDescription",
]);

const STRING_BOUNDS: ReadonlySet<string> = new Set([
  "bytes",
  "graphemes",
  "isoDate",
  "isoDateTime",
  "isoTime",
  "isoTimeSecond",
  "isoWeek",
  "length",
  "maxBytes",
  "maxGraphemes",
  "maxLength",
  "uuid",
]);
const ARRAY_BOUNDS: ReadonlySet<string> = new Set(["length", "maxLength"]);
const RECORD_BOUNDS: ReadonlySet<string> = new Set(["entries", "maxEntries"]);
const FILE_BOUNDS: ReadonlySet<string> = new Set(["maxSize", "size"]);

// A spread pipe step: any bound may come from it.
const UNPROVABLE_STEP = "...";

// Schemas whose first argument is the entries object.
const OBJECT_SCHEMAS: ReadonlySet<string> = new Set([
  "looseObject",
  "object",
  "objectWithRest",
  "strictObject",
]);

// Schemas that carry no string, list or file payload of their own.
const LEAF_SCHEMAS: ReadonlySet<string> = new Set([
  "any",
  "bigint",
  "boolean",
  "custom",
  "date",
  "enum",
  "instance",
  "literal",
  "nan",
  "never",
  "null",
  "number",
  "picklist",
  "symbol",
  "undefined",
  "unknown",
  "void",
]);

// Every valibot name that builds a schema rather than a pipe step. A pipe
// argument with one of these names checks the piped value again.
const SCHEMA_NAMES: ReadonlySet<string> = new Set([
  ...LEAF_SCHEMAS,
  ...OBJECT_SCHEMAS,
  "array",
  "blob",
  "exactOptional",
  "file",
  "intersect",
  "lazy",
  "looseTuple",
  "map",
  "nonNullable",
  "nonNullish",
  "nonOptional",
  "nullable",
  "nullish",
  "optional",
  "pipe",
  "record",
  "set",
  "strictTuple",
  "string",
  "tuple",
  "tupleWithRest",
  "undefinedable",
  "union",
  "variant",
]);

const PAGINATION_CURSOR_KEY = "cursor";

// The wrappers `require-pagination-cursor-schema` peels before it judges a
// cursor schema.
const CURSOR_WRAPPERS: ReadonlySet<string> = new Set([
  "exactOptional",
  "nullable",
  "nullish",
  "optional",
  "pipe",
]);

type MessageId =
  "unboundedString" | "unboundedArray" | "unboundedRecord" | "unboundedFile";

type Finding = { node: AstNode; messageId: MessageId };

const callArguments = (node: AstNode): unknown[] =>
  Array.isArray(node.arguments) ? node.arguments : [];

/** `name` for a `v.name(...)` call, null for any other node. */
const valibotName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const callee = node.callee;
  if (
    !isAstNode(callee) ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false ||
    !isIdentifier(callee.object, VALIBOT_NAMESPACE)
  ) {
    return null;
  }
  return getPropertyName(callee.property);
};

/** `name` for a bare `name(...)` call, null for any other node. */
const helperName = (node: unknown): string | null =>
  isAstNode(node) && node.type === "CallExpression" && isIdentifier(node.callee)
    ? node.callee.name
    : null;

const isObjectHelperCall = (node: unknown): boolean => {
  const name = helperName(node);
  return name !== null && OBJECT_HELPERS.has(name);
};

const isSchemaBuilder = (node: unknown): boolean => {
  if (valibotName(node) !== null) {
    return true;
  }
  const name = helperName(node);
  return (
    name !== null && (OBJECT_HELPERS.has(name) || SCHEMA_HELPERS.has(name))
  );
};

// The shape `require-pagination-cursor-schema` reports: an inline
// `v.string()` under optional/nullable wrappers or at the head of a pipe.
const isPaginationRuleCursor = (value: unknown): boolean => {
  let schema = unwrapExpression(value);
  while (schema !== null) {
    const name = valibotName(schema);
    if (name === "string") {
      return true;
    }
    if (name === null || !CURSOR_WRAPPERS.has(name)) {
      return false;
    }
    schema = unwrapExpression(callArguments(schema).at(0));
  }
  return false;
};

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

// A property of an object literal passed to an object schema is a field of
// that schema (`v.object({ body: v.string() })`), not a request slot.
const isSchemaField = (property: unknown): boolean => {
  if (!isAstNode(property)) {
    return false;
  }
  const object = property.parent;
  if (!isAstNode(object) || object.type !== "ObjectExpression") {
    return false;
  }
  const owner = object.parent;
  const name = valibotName(owner);
  return (
    (name !== null && OBJECT_SCHEMAS.has(name)) || isObjectHelperCall(owner)
  );
};

const hasBound = (
  steps: ReadonlySet<string>,
  accepted: ReadonlySet<string>,
): boolean =>
  steps.has(UNPROVABLE_STEP) || [...steps].some((step) => accepted.has(step));

const NO_STEPS: ReadonlySet<string> = new Set();

export default eslintCompatPlugin({
  meta: { name: "require-bounded-request-schema" },
  rules: {
    "require-bounded-request-schema": {
      meta: {
        type: "problem",
        messages: {
          unboundedString:
            "Request schema string has no length bound. Wrap it as " +
            "`v.pipe(v.string(), v.maxLength(n))`, or use a bounded schema " +
            "from @/api/lib/custom-schema (defaultVarcharSchema, " +
            "userIdSchema, uuidSchema, resourceIdSchema, " +
            "paginationCursorSchema).",
          unboundedArray:
            "Request schema list has no item bound. Wrap it as " +
            "`v.pipe(v.array(item), v.maxLength(n))` (or " +
            "`v.pipe(arrayFromQuery(item), v.maxLength(n))`) so a request " +
            "cannot carry an unbounded element count.",
          unboundedRecord:
            "Request schema record has no key bound. Wrap it as " +
            "`v.pipe(v.record(key, value), v.maxEntries(n))`, or list the " +
            "keys with `v.object`.",
          unboundedFile:
            "Request schema file has no size bound. Use " +
            "`fileSchema({ maxBytes })` from @/api/lib/custom-schema with a " +
            "limit from FILE_SIZE_LIMIT_BYTES in @/api/lib/limits.",
        },
      },
      createOnce(context) {
        let reported = new Set<unknown>();

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

        // The valibot step names a pipe's trailing arguments declare. A
        // spread may hide any bound; an imported or computed step names none.
        const pipeSteps = (args: readonly unknown[]): Set<string> => {
          const steps = new Set<string>();
          for (const argument of args) {
            if (isAstNode(argument) && argument.type === "SpreadElement") {
              steps.add(UNPROVABLE_STEP);
              continue;
            }
            let step: unknown = unwrapExpression(argument);
            if (isIdentifier(step)) {
              step = unwrapExpression(resolveSchemaInitializer(step));
            }
            const name = valibotName(step);
            if (name !== null) {
              steps.add(name);
            }
          }
          return steps;
        };

        // What an entries spread contributes: a same-file entries object
        // (`...commonProperties`), or the schema behind `...schema.entries`.
        const spreadEntries = (argument: unknown): unknown => {
          const value = unwrapExpression(argument);
          if (isIdentifier(value)) {
            const init = unwrapExpression(resolveSchemaInitializer(value));
            return init?.type === "ObjectExpression" ? init : value;
          }
          if (
            value?.type === "MemberExpression" &&
            value.computed === false &&
            getPropertyName(value.property) === "entries"
          ) {
            return value.object;
          }
          return value;
        };

        // A call that is not a valibot builder: an object or array helper, or
        // any other call whose schema-shaped arguments are accepted input.
        const collectHelperCall = ({
          current,
          args,
          steps,
          descend,
          findings,
        }: {
          current: AstNode;
          args: readonly unknown[];
          steps: ReadonlySet<string>;
          descend: (child: unknown, childSteps?: ReadonlySet<string>) => void;
          findings: Finding[];
        }): void => {
          const helper = helperName(current);
          if (helper !== null && OBJECT_HELPERS.has(helper)) {
            descend(args.at(0));
            return;
          }
          if (helper === "arrayFromQuery") {
            if (!hasBound(steps, ARRAY_BOUNDS)) {
              findings.push({ node: current, messageId: "unboundedArray" });
            }
            descend(args.at(0));
            return;
          }
          // Any other call (a wire helper, `withDescription`, an imported
          // schema factory): its schema-shaped arguments are part of the
          // accepted input. Literal options carry no schema.
          for (const argument of args) {
            const unwrapped = unwrapExpression(argument);
            if (
              unwrapped?.type === "Identifier" ||
              unwrapped?.type === "CallExpression"
            ) {
              descend(unwrapped, steps);
            }
          }
        };

        // An object literal of entries: each value is a field schema, a spread
        // brings in another object's entries, and a cursor the pagination
        // rule owns is left to it.
        const collectEntries = (
          current: AstNode,
          descend: (child: unknown, childSteps?: ReadonlySet<string>) => void,
        ): void => {
          for (const property of Array.isArray(current.properties)
            ? current.properties
            : []) {
            if (!isAstNode(property)) {
              continue;
            }
            if (property.type === "SpreadElement") {
              descend(spreadEntries(property.argument));
              continue;
            }
            if (
              getPropertyName(property.key) === PAGINATION_CURSOR_KEY &&
              isPaginationRuleCursor(property.value)
            ) {
              continue;
            }
            descend(property.value);
          }
        };

        // Judges one schema node; `descend` walks a child schema.
        const collectNode = (
          current: AstNode,
          steps: ReadonlySet<string>,
          descend: (child: unknown, childSteps?: ReadonlySet<string>) => void,
          findings: Finding[],
        ): void => {
          if (current.type === "Identifier") {
            const init = resolveSchemaInitializer(current);
            if (isSchemaBuilder(unwrapExpression(init))) {
              descend(init, steps);
            }
            return;
          }
          if (current.type === "ArrayExpression") {
            for (const element of Array.isArray(current.elements)
              ? current.elements
              : []) {
              descend(element, steps);
            }
            return;
          }
          if (current.type === "ObjectExpression") {
            collectEntries(current, descend);
            return;
          }
          if (current.type !== "CallExpression") {
            return;
          }

          const args = callArguments(current);
          const name = valibotName(current);
          if (name === null) {
            collectHelperCall({ current, args, steps, descend, findings });
            return;
          }
          if (LEAF_SCHEMAS.has(name)) {
            return;
          }
          switch (name) {
            case "pipe": {
              const merged = new Set([...steps, ...pipeSteps(args.slice(1))]);
              descend(args.at(0), merged);
              // A schema later in the pipe checks a transformed value, which
              // is still request input.
              for (const later of args.slice(1)) {
                const unwrapped = unwrapExpression(later);
                const laterName = valibotName(unwrapped);
                if (
                  laterName === null
                    ? unwrapped?.type === "CallExpression"
                    : SCHEMA_NAMES.has(laterName)
                ) {
                  descend(unwrapped);
                }
              }
              return;
            }
            case "string":
              if (!hasBound(steps, STRING_BOUNDS)) {
                findings.push({ node: current, messageId: "unboundedString" });
              }
              return;
            case "array":
              if (!hasBound(steps, ARRAY_BOUNDS)) {
                findings.push({ node: current, messageId: "unboundedArray" });
              }
              descend(args.at(0));
              return;
            case "record":
              if (!hasBound(steps, RECORD_BOUNDS)) {
                findings.push({ node: current, messageId: "unboundedRecord" });
              }
              // Keys are out of scope; see the header.
              descend(args.at(1));
              return;
            case "file":
            case "blob":
              if (!hasBound(steps, FILE_BOUNDS)) {
                findings.push({ node: current, messageId: "unboundedFile" });
              }
              return;
            case "object":
            case "strictObject":
            case "looseObject":
              descend(args.at(0));
              return;
            case "objectWithRest":
              descend(args.at(0));
              descend(args.at(1));
              return;
            case "variant":
              descend(args.at(1), steps);
              return;
            default:
              // Wrappers (`optional`, `nullable`, ...) and combinators
              // (`union`, `intersect`, `tuple`, ...): a pipe's bounds still
              // reach the wrapped schema, and every schema-shaped argument is
              // part of the accepted input. Messages and defaults are not.
              for (const argument of args) {
                const unwrapped = unwrapExpression(argument);
                if (
                  unwrapped?.type === "Identifier" ||
                  unwrapped?.type === "ArrayExpression" ||
                  unwrapped?.type === "CallExpression"
                ) {
                  descend(unwrapped, steps);
                }
              }
          }
        };

        const collect = (
          node: unknown,
          steps: ReadonlySet<string>,
          visited: Set<unknown>,
          findings: Finding[],
        ): void => {
          const current = unwrapExpression(node);
          // `visited` holds the current path only: it stops a `const` cycle,
          // while a schema reached twice under different pipe bounds is
          // judged under each.
          if (current === null || visited.has(current)) {
            return;
          }
          visited.add(current);
          collectNode(
            current,
            steps,
            (child, childSteps = NO_STEPS) => {
              collect(child, childSteps, visited, findings);
            },
            findings,
          );
          visited.delete(current);
        };

        const inspect = (schema: unknown): void => {
          const findings: Finding[] = [];
          collect(schema, NO_STEPS, new Set(), findings);
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
