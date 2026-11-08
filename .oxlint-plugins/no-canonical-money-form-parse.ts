// User-entered values in web forms must carry the formatting locale into the
// money owner. This syntactic boundary detects direct DOM/Form field values;
// aliases and values returned by other functions are outside its analysis.
import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  type AstNode,
  everyNode,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const FORM_FIELD_OWNERS = new Set([
  "currentTarget",
  "dataset",
  "state",
  "target",
]);
const FORM_TEXT_NAMES = new Set(["amountInputValue", "draft", "input"]);

/** The expression that carries the amount: its `amount` property, or the argument. */
const amountExpression = (argument: unknown): unknown => {
  const unwrapped = unwrapExpression(argument);
  if (
    unwrapped?.type !== "ObjectExpression" ||
    !Array.isArray(unwrapped.properties)
  ) {
    return unwrapped;
  }
  const properties: unknown[] = unwrapped.properties;
  return properties
    .filter(isAstNode)
    .find(
      (property) =>
        property.type === "Property" &&
        getPropertyName(property.key) === "amount",
    )?.value;
};

/** A read of a form field's value, or of a name that holds form text. */
const isFormText = (node: AstNode): boolean => {
  if (isIdentifier(node)) {
    return FORM_TEXT_NAMES.has(node.name);
  }
  if (
    node.type !== "MemberExpression" ||
    memberPropertyName(node) !== "value"
  ) {
    return false;
  }
  const owner = unwrapExpression(node.object);
  const ownerName = isIdentifier(owner)
    ? owner.name
    : memberPropertyName(owner);
  return ownerName !== null && FORM_FIELD_OWNERS.has(ownerName);
};

export default eslintCompatPlugin({
  meta: { name: "no-canonical-money-form-parse" },
  rules: {
    "no-canonical-money-form-parse": {
      meta: {
        type: "problem",
        messages: {
          localeParser:
            "Use parseLocaleMinorUnits with the formatting locale for user-entered money text.",
        },
      },
      createOnce(context) {
        let canonicalBindings = new Set<Variable>();
        return {
          Program() {
            canonicalBindings = new Set();
          },
          ImportDeclaration(node) {
            if (node.source.value !== "@stll/money") {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                specifier.type === "ImportSpecifier" &&
                specifier.imported.type === "Identifier" &&
                (specifier.imported.name === "tryToMinorUnits" ||
                  specifier.imported.name === "toMinorUnits") &&
                isIdentifierReference(specifier.local)
              ) {
                const binding = resolveVariable(context, specifier.local);
                if (binding !== null) {
                  canonicalBindings.add(binding);
                }
              }
            }
          },
          CallExpression(node) {
            if (!isIdentifierReference(node.callee)) {
              return;
            }
            const binding = resolveVariable(context, node.callee);
            if (binding === null || !canonicalBindings.has(binding)) {
              return;
            }
            if (
              everyNode(amountExpression(node.arguments.at(0))).some(isFormText)
            ) {
              context.report({ node, messageId: "localeParser" });
            }
          },
        };
      },
    },
  },
});
