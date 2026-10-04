// Keep a literal out of an attribute that is derived from data.
//
// Some stored attributes are facts about the bytes or the record they
// describe: whether a file is encrypted is one. Each has one detector module
// that computes it, and every writer takes the detector's value. A writer
// that types the value in instead (`encrypted: false`) records a guess, and a
// guess made once for the common case is silently wrong for every record that
// is not that case.
//
// The registry is `scripts/derived-attributes.ts`: each row names the
// attribute, its detector module, and the source trees it governs. The rule
// reports, outside the attribute's detector, a boolean literal written to the
// attribute's name as
//
//   - an object property:        { encrypted: false }
//   - a variable initializer:    let encrypted = false;
//   - an assignment:             encrypted = true; content.encrypted = true;
//   - a default value:           ({ encrypted = false }) => …
//   - a class field:             encrypted = false;
//
// Only boolean literals: the registered attributes are flags, and a string
// under the same key is usually a message keyed by it (`{ encrypted: "…" }`).
//
// Detection boundary: syntax only. A literal reached through another name
// (`const no = false; ({ encrypted: no })`), a computed key, or an expression
// that merely contains a literal (`x ?? false`) is out of scope; the
// writer-enumerating test beside each detector covers what reaches a writer.
// Types are untouched: a type literal `encrypted: false` states a shape, not a
// value.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isFileIn,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

type DerivedAttribute = {
  name: string;
  detector: string;
  within: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const configuredAttributes = (options: unknown): DerivedAttribute[] => {
  if (!isRecord(options) || !Array.isArray(options.attributes)) {
    return [];
  }
  return options.attributes.flatMap((attribute: unknown) => {
    if (
      !isRecord(attribute) ||
      typeof attribute.name !== "string" ||
      typeof attribute.detector !== "string" ||
      !isStringArray(attribute.within)
    ) {
      return [];
    }
    return [
      {
        name: attribute.name,
        detector: attribute.detector,
        within: attribute.within,
      },
    ];
  });
};

// Whether the linted file lies under one of the repository-relative prefixes.
const isWithin = (filename: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => `/${filename}`.includes(`/${prefix}`));

const isLiteralValue = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    isAstNode(expression) &&
    expression.type === "Literal" &&
    typeof expression.value === "boolean"
  );
};

const assignedName = (target: unknown): string | null => {
  if (isIdentifier(target)) {
    return target.name;
  }
  if (
    isAstNode(target) &&
    target.type === "MemberExpression" &&
    target.computed !== true
  ) {
    return getPropertyName(target.property);
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-literal-derived-attribute" },
  rules: {
    "no-literal-derived-attribute": {
      meta: {
        type: "problem",
        messages: {
          literalDerivedAttribute:
            "`{{name}}` is derived from the data it describes: take it from its detector ({{detector}}), never from a literal. See scripts/derived-attributes.ts.",
        },
        schema: [
          {
            type: "object",
            properties: {
              attributes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    detector: { type: "string" },
                    within: { type: "array", items: { type: "string" } },
                  },
                  required: ["name", "detector", "within"],
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        const active = new Map<string, DerivedAttribute>();

        const reportIfDerived = (
          node: unknown,
          name: string | null,
          value: unknown,
        ) => {
          if (name === null || !isLiteralValue(value)) {
            return;
          }
          const attribute = active.get(name);
          if (attribute === undefined || !isAstNode(node)) {
            return;
          }
          context.report({
            node,
            messageId: "literalDerivedAttribute",
            data: { name, detector: attribute.detector },
          });
        };

        return {
          before() {
            active.clear();
            const filename = filenameForContext(context);
            for (const attribute of configuredAttributes(
              context.options.at(0),
            )) {
              if (
                isWithin(filename, attribute.within) &&
                !isFileIn(context, [attribute.detector])
              ) {
                active.set(attribute.name, attribute);
              }
            }
            return active.size > 0;
          },
          Property(node) {
            if (node.computed || !isAstNode(node.parent)) {
              return;
            }
            const name = getPropertyName(node.key);
            if (node.parent.type === "ObjectExpression") {
              reportIfDerived(node, name, node.value);
              return;
            }
            // A destructured input's default: `{ encrypted = false }` or
            // `{ encrypted: local = false }`, keyed by the property name.
            const value = node.value;
            if (
              node.parent.type === "ObjectPattern" &&
              isAstNode(value) &&
              value.type === "AssignmentPattern"
            ) {
              reportIfDerived(node, name, value.right);
            }
          },
          PropertyDefinition(node) {
            if (node.computed) {
              return;
            }
            reportIfDerived(node, getPropertyName(node.key), node.value);
          },
          VariableDeclarator(node) {
            reportIfDerived(node, assignedName(node.id), node.init);
          },
          AssignmentExpression(node) {
            reportIfDerived(node, assignedName(node.left), node.right);
          },
          AssignmentPattern(node) {
            // Inside an object pattern the enclosing property reports it.
            if (isAstNode(node.parent) && node.parent.type === "Property") {
              return;
            }
            reportIfDerived(node, assignedName(node.left), node.right);
          },
        };
      },
    },
  },
});
