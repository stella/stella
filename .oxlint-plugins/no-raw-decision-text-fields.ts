// Keep publisher decision text behind the TextField boundary in adapters.
//
// Flags:
//   return { metadata: { abstract: rawAbstract } };
//   decision.metadata["headnote"] = parsedHeadnote;
//   return { textFields: { legalSentence: "not stated" } };
//   decision.textFields.summary = `${prefix}: ${text}`;
//
// Allows:
//   const source = { summary: rawSummary };
//   return {
//     metadata: { sourceId },
//     textFields: { summary: sourceTextField(adapterKey, source.summary) },
//   };
//   decision.textFields.summary = parsedTextField;
//
// Metadata aliases and spreads cross checkedDecisionMetadata before emission.
// Non-literal textFields values remain enforced by the IngestionResult type.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_METADATA_KEYS,
} from "@stll/api-contract/case-law-text-field";

import {
  getPropertyName,
  isAstNode,
  isStringLiteral,
  unwrapExpression,
} from "./utils.ts";

const DECISION_TEXT_FIELD_KEY_SET: ReadonlySet<string> = new Set(
  DECISION_TEXT_FIELD_KEYS,
);
const DECISION_TEXT_METADATA_KEY_SET: ReadonlySet<string> = new Set(
  DECISION_TEXT_METADATA_KEYS,
);

const METADATA_KEY = "metadata";
const TEXT_FIELDS_KEY = "textFields";
const CHECKED_METADATA_CONSTRUCTOR = "checkedDecisionMetadata";

const peelExpression = (
  value: unknown,
): ReturnType<typeof unwrapExpression> => {
  const expression = unwrapExpression(value);
  return expression?.type === "TSNonNullExpression"
    ? peelExpression(expression.expression)
    : expression;
};

const staticPropertyName = (node: unknown): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type !== "Property" && node.type !== "MemberExpression") {
    return null;
  }
  if (node.computed === true) {
    return isStringLiteral(node.key ?? node.property)
      ? getPropertyName(node.key ?? node.property)
      : null;
  }
  return getPropertyName(node.key ?? node.property);
};

const isRawTextLiteral = (value: unknown): boolean => {
  const expression = peelExpression(value);
  return isStringLiteral(expression) || expression?.type === "TemplateLiteral";
};

const objectExpression = (value: unknown) => {
  const expression = peelExpression(value);
  return expression?.type === "ObjectExpression" ? expression : null;
};

const hasSiblingProperty = (node: unknown, name: string): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const object = objectExpression(node.parent);
  if (object === null || !Array.isArray(object.properties)) {
    return false;
  }
  return object.properties.some(
    (property) =>
      isAstNode(property) &&
      property.type === "Property" &&
      staticPropertyName(property) === name,
  );
};

const isCheckedMetadataCall = (value: unknown): boolean => {
  const expression = peelExpression(value);
  if (expression?.type !== "CallExpression") {
    return false;
  }
  const callee = peelExpression(expression.callee);
  return (
    callee?.type === "Identifier" &&
    callee.name === CHECKED_METADATA_CONSTRUCTOR
  );
};

const reportMetadataValue = (context, node, value: unknown) => {
  const object = objectExpression(value);
  if (object === null) {
    if (!isCheckedMetadataCall(value)) {
      context.report({ node, messageId: "uncheckedMetadata" });
    }
    return;
  }
  if (!Array.isArray(object.properties)) {
    return;
  }
  for (const property of object.properties) {
    if (!isAstNode(property)) {
      continue;
    }
    if (property.type === "SpreadElement") {
      context.report({ node: property, messageId: "uncheckedMetadata" });
      continue;
    }
    if (property.type !== "Property") {
      continue;
    }
    const name = staticPropertyName(property);
    if (name === null) {
      context.report({ node: property, messageId: "uncheckedMetadata" });
      continue;
    }
    if (name === DECISION_TEXT_ABSENCE_METADATA_KEY) {
      context.report({ node: property, messageId: "reservedMetadata" });
    } else if (DECISION_TEXT_METADATA_KEY_SET.has(name)) {
      context.report({ node: property, messageId: "metadataTextField" });
    }
  }
};

const reportRawTextFieldProperties = (context, value: unknown) => {
  const object = objectExpression(value);
  if (object === null || !Array.isArray(object.properties)) {
    return;
  }
  for (const property of object.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      continue;
    }
    const name = staticPropertyName(property);
    if (name === null) {
      context.report({ node: property, messageId: "rawTextField" });
      continue;
    }
    if (
      !DECISION_TEXT_FIELD_KEY_SET.has(name) ||
      !isRawTextLiteral(property.value)
    ) {
      continue;
    }
    context.report({ node: property, messageId: "rawTextField" });
  }
};

const containingMemberName = (node: unknown): string | null => {
  const member = peelExpression(node);
  if (member?.type !== "MemberExpression") {
    return null;
  }
  return staticPropertyName(member);
};

const memberContainerName = (node: unknown): string | null => {
  const member = peelExpression(node);
  if (member?.type !== "MemberExpression") {
    return null;
  }
  return containingMemberName(member.object);
};

const isObjectAssign = (node: unknown): boolean => {
  const expression = peelExpression(node);
  if (expression?.type !== "MemberExpression") {
    return false;
  }
  const object = peelExpression(expression.object);
  return (
    object?.type === "Identifier" &&
    object.name === "Object" &&
    staticPropertyName(expression) === "assign"
  );
};

const protectedMemberTarget = (
  node: unknown,
  protectedKeys: ReadonlySet<string>,
): { container: string; key: string } | null => {
  const member = peelExpression(node);
  if (member?.type !== "MemberExpression") {
    return null;
  }
  const key = staticPropertyName(member);
  if (key === null || !protectedKeys.has(key)) {
    return null;
  }
  const container = containingMemberName(member.object);
  return container === null ? null : { container, key };
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-decision-text-fields" },
  rules: {
    "no-raw-decision-text-fields": {
      meta: {
        type: "problem",
        messages: {
          metadataTextField:
            "Decision text belongs under IngestionResult.textFields, not metadata. Wrap the source value with sourceTextField, presentTextField, or absentTextField.",
          reservedMetadata:
            "Decision text persistence metadata is pipeline-owned and cannot be written by adapters.",
          rawTextField:
            "Do not write raw string or template literals to IngestionResult.textFields. Use sourceTextField, presentTextField, or absentTextField.",
          uncheckedMetadata:
            "Decision metadata aliases, spreads, and dynamic writes must cross checkedDecisionMetadata.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          Property(node) {
            if (objectExpression(node.parent) === null) {
              return;
            }
            const container = staticPropertyName(node);
            if (container === METADATA_KEY) {
              if (hasSiblingProperty(node, TEXT_FIELDS_KEY)) {
                reportMetadataValue(context, node, node.value);
              }
              return;
            }
            if (container === TEXT_FIELDS_KEY) {
              reportRawTextFieldProperties(context, node.value);
            }
          },
          AssignmentExpression(node) {
            const assignedContainer = containingMemberName(node.left);
            if (assignedContainer === METADATA_KEY) {
              reportMetadataValue(context, node.left, node.right);
            } else if (assignedContainer === TEXT_FIELDS_KEY) {
              reportRawTextFieldProperties(context, node.right);
            }

            const metadataTarget = protectedMemberTarget(
              node.left,
              DECISION_TEXT_METADATA_KEY_SET,
            );
            if (metadataTarget?.container === METADATA_KEY) {
              context.report({
                node: node.left,
                messageId:
                  metadataTarget.key === DECISION_TEXT_ABSENCE_METADATA_KEY
                    ? "reservedMetadata"
                    : "metadataTextField",
              });
              return;
            }
            const targetContainer = memberContainerName(node.left);
            const targetKey = staticPropertyName(peelExpression(node.left));
            if (targetContainer === METADATA_KEY && targetKey === null) {
              context.report({
                node: node.left,
                messageId: "uncheckedMetadata",
              });
              return;
            }
            if (
              protectedMemberTarget(node.left, DECISION_TEXT_FIELD_KEY_SET)
                ?.container === TEXT_FIELDS_KEY &&
              isRawTextLiteral(node.right)
            ) {
              context.report({ node: node.left, messageId: "rawTextField" });
              return;
            }
            if (targetContainer === TEXT_FIELDS_KEY && targetKey === null) {
              context.report({ node: node.left, messageId: "rawTextField" });
            }
          },
          CallExpression(node) {
            if (!isObjectAssign(node.callee)) {
              return;
            }
            const target = Array.isArray(node.arguments)
              ? node.arguments.at(0)
              : undefined;
            const container = containingMemberName(target);
            if (container === METADATA_KEY) {
              context.report({ node, messageId: "uncheckedMetadata" });
            } else if (container === TEXT_FIELDS_KEY) {
              context.report({ node, messageId: "rawTextField" });
            }
          },
        };
      },
    },
  },
});
