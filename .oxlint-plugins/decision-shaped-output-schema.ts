// Route decision-shaped structured output to the decision model.
//
// A generative structured-output call bills text generation for its answer.
// When every field of the output schema is a closed choice, a yes/no, a number
// or a date, nothing in that answer is text: the model is picking from N, and
// `decide()` / `decideMany()`
// (apps/api/src/lib/workflow/decisions/decide.ts) ask the
// organization's decision model instead, under a confidence floor and with one
// logged reading per question. A single free-text field keeps the call
// generative, so the test is exact rather than a heuristic: a `v.string()` not
// piped through `v.isoDate()` / `v.isoDateTime()` makes the schema prose.
//
// Flagged:
//   generateTanStackObjectForRole({
//     outputSchema: v.strictObject({ applies: v.boolean() }),
//   })
//
// Allowed:
//   generateTanStackObjectForRole({
//     outputSchema: v.strictObject({
//       verdict: v.picklist(VERDICTS),
//       rationale: v.string(),
//     }),
//   })
//
// The call is recognized by its `outputSchema` option, not by its callee:
// `outputSchema` is the vocabulary of the structured-output helpers and of
// every file-local wrapper around them, so a schema handed to a wrapper is
// caught where the literal is written. A wrapper forwarding
// `input.outputSchema` resolves to nothing and is not reported.
//
// Analysis boundary: single file, syntax only. The schema is read inline or
// through a same-file `const`, with one level of `v.pipe(schema, ...)` peeled;
// a schema imported from another module, returned by a helper, or composed
// through a spread is not resolved and not reported. A valibot entry this rule
// does not recognize counts as prose, so an unfamiliar shape cannot produce a
// report.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  getCalleeName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

const OBJECT_SCHEMA_NAMES = new Set(["object", "strictObject", "looseObject"]);
// Closed-set, numeric and temporal leaves: an answer, not a composition.
const DECIDED_LEAF_NAMES = new Set([
  "boolean",
  "literal",
  "number",
  "picklist",
]);
// Wrappers that decide nothing themselves; the decision is their operand.
const WRAPPER_NAMES = new Set([
  "array",
  "nullable",
  "nullish",
  "optional",
  "undefinedable",
]);
const DATE_ACTION_NAMES = new Set(["isoDate", "isoDateTime"]);

// Depth cap for const-to-const aliasing and nested composition. A real output
// schema nests far below this; a cyclic alias cannot outrun it.
const MAX_DEPTH = 12;

// Last segment of a callee chain, so `v.picklist`, `valibot.picklist` and a
// bare imported `picklist` all read as "picklist". Null for a computed chain
// or a non-call node.
const valibotCallName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const calleeName = getCalleeName(node.callee);
  return calleeName === null ? null : (calleeName.split(".").at(-1) ?? null);
};

const isValibotCall = (node: unknown, name: string): boolean =>
  valibotCallName(node) === name;

const callArguments = (node: AstNode): unknown[] =>
  Array.isArray(node.arguments) ? node.arguments : [];

// The `outputSchema: ...` Property of a call's options object, or null.
const outputSchemaProperty = (options: AstNode): AstNode | null => {
  const properties = Array.isArray(options.properties)
    ? options.properties
    : [];
  for (const property of properties) {
    if (
      isAstNode(property) &&
      property.type === "Property" &&
      getPropertyName(property.key) === "outputSchema"
    ) {
      return property;
    }
  }
  return null;
};

// An explicit marker is reserved for calls that intentionally exercise or
// fall back to the generative structured-output path. The helper's type owns
// the vocabulary, so exceptions are searchable and cannot be free-form lint
// comments.
const hasGenerativeOutputMode = (options: AstNode): boolean => {
  const properties = Array.isArray(options.properties)
    ? options.properties
    : [];
  return properties.some((property) => {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      getPropertyName(property.key) !== "outputMode"
    ) {
      return false;
    }
    const value = unwrapExpression(property.value);
    return value?.type === "Literal" && value.value === "generative";
  });
};

// Entry values of a `v.object(...)` / `v.strictObject(...)` literal. Null when
// the entry list is absent or carries a spread, which this walk cannot
// enumerate.
const objectSchemaEntries = (schema: AstNode): unknown[] | null => {
  const entries = unwrapExpression(callArguments(schema).at(0));
  if (entries?.type !== "ObjectExpression") {
    return null;
  }
  const properties = Array.isArray(entries.properties)
    ? entries.properties
    : [];
  const values: unknown[] = [];
  for (const property of properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      return null;
    }
    values.push(property.value);
  }
  return values;
};

export default eslintCompatPlugin({
  meta: { name: "decision-shaped-output-schema" },
  rules: {
    "decision-shaped-output-schema": {
      meta: {
        type: "problem",
        messages: {
          decisionShapedSchema:
            "Every field of this output is a closed choice, a boolean, a " +
            "number or a date: that is a decision, not a generation. Ask it " +
            "through decide() or decideMany() from " +
            "@/api/lib/workflow/decisions/decide and keep the generative model for " +
            "text.",
        },
      },
      createOnce(context) {
        // Same-file `const name = <schema>` initializers, so a schema named
        // beside its call site resolves. Cleared per file.
        const schemaConstants = new Map<string, unknown>();
        const pendingProperties: AstNode[] = [];

        // Peel TS wrappers and same-file const aliases. `v.pipe(...)` survives
        // here because its actions carry the date evidence.
        const resolveAlias = (node: unknown, depth: number): AstNode | null => {
          if (depth > MAX_DEPTH) {
            return null;
          }
          const expression = unwrapExpression(node);
          if (expression === null || !isIdentifier(expression)) {
            return expression;
          }
          const initializer = schemaConstants.get(expression.name);
          return initializer === undefined
            ? null
            : resolveAlias(initializer, depth + 1);
        };

        const isDecisionShaped = (node: unknown, depth: number): boolean => {
          if (depth > MAX_DEPTH) {
            return false;
          }
          const schema = resolveAlias(node, depth);
          if (schema?.type !== "CallExpression") {
            return false;
          }
          const name = valibotCallName(schema);
          if (name === null) {
            return false;
          }
          const args = callArguments(schema);
          if (DECIDED_LEAF_NAMES.has(name)) {
            return true;
          }
          if (WRAPPER_NAMES.has(name)) {
            return isDecisionShaped(args.at(0), depth + 1);
          }
          if (name === "union") {
            const members = unwrapExpression(args.at(0));
            if (members?.type !== "ArrayExpression") {
              return false;
            }
            const elements = Array.isArray(members.elements)
              ? members.elements
              : [];
            return (
              elements.length > 0 &&
              elements.every((element) => isDecisionShaped(element, depth + 1))
            );
          }
          if (OBJECT_SCHEMA_NAMES.has(name)) {
            const entries = objectSchemaEntries(schema);
            return (
              entries?.every((entry) => isDecisionShaped(entry, depth + 1)) ===
              true
            );
          }
          if (name === "pipe") {
            // A string leaves prose behind only when a date action pins its
            // format; every other pipe inherits its base's shape.
            if (isValibotCall(resolveAlias(args.at(0), depth), "string")) {
              return args.slice(1).some((action) => {
                const actionName = valibotCallName(action);
                return actionName !== null && DATE_ACTION_NAMES.has(actionName);
              });
            }
            return isDecisionShaped(args.at(0), depth + 1);
          }
          return false;
        };

        const reportDecisionShapedSchema = (property: AstNode): void => {
          // One level of `v.pipe(schema, v.description(...))` around the
          // object literal, as the schema modules write it.
          const aliased = resolveAlias(property.value, 0);
          const schema =
            aliased !== null && isValibotCall(aliased, "pipe")
              ? resolveAlias(callArguments(aliased).at(0), 0)
              : aliased;
          if (
            schema?.type !== "CallExpression" ||
            !OBJECT_SCHEMA_NAMES.has(valibotCallName(schema) ?? "")
          ) {
            return;
          }
          const entries = objectSchemaEntries(schema);
          if (entries === null || entries.length === 0) {
            return;
          }
          if (!entries.every((entry) => isDecisionShaped(entry, 0))) {
            return;
          }
          context.report({ node: property, messageId: "decisionShapedSchema" });
        };

        return {
          Program() {
            schemaConstants.clear();
            pendingProperties.length = 0;
          },
          VariableDeclaration(node) {
            if (node.kind !== "const") {
              return;
            }
            const declarations = Array.isArray(node.declarations)
              ? node.declarations
              : [];
            for (const declaration of declarations) {
              if (
                isAstNode(declaration) &&
                isIdentifier(declaration.id) &&
                isAstNode(declaration.init)
              ) {
                schemaConstants.set(declaration.id.name, declaration.init);
              }
            }
          },
          CallExpression(node) {
            const options = unwrapExpression(
              Array.isArray(node.arguments) ? node.arguments.at(0) : undefined,
            );
            if (options?.type !== "ObjectExpression") {
              return;
            }
            if (hasGenerativeOutputMode(options)) {
              return;
            }
            const property = outputSchemaProperty(options);
            if (property !== null) {
              pendingProperties.push(property);
            }
          },
          // Deferred: a schema constant may be declared below its call site.
          "Program:exit"() {
            for (const property of pendingProperties) {
              reportDecisionShapedSchema(property);
            }
          },
        };
      },
    },
  },
});
