// Disallow raw error values in production log sinks.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/strict-boolean-expressions
//
// Stella logs privileged legal workflows. Production logs should carry
// structural error information (`errorTag(error)`, `"error.type"`) and
// correlation IDs, not raw messages, stacks, causes, or stringified errors.
//
// Safe patterns:
//   logger.error("worker.failed", { "error.type": errorTag(error) })
//   logger.warn("sse.failed", { "message.bytes": message.length })
//   process.stderr.write(`worker error: ${type}\n`)
//
// Flagged:
//   logger.error("worker.failed", { error: String(error) })
//   logger.warn("worker.failed", { error })
//   logger.error("request.failed", { "error.message": error.message })
//   process.stderr.write(`worker error: ${error.message}\n`)

import {
  getPropertyName,
  isCallTo,
  isIdentifier,
  isMemberAccess,
} from "./utils.ts";

const LOGGER_METHODS = new Set(["debug", "error", "info", "warn"]);
const RAW_ERROR_PROPERTY_NAMES = new Set([
  "cause",
  "error",
  "error.cause",
  "error.message",
  "error.stack",
  "stack",
]);
const RAW_ERROR_IDENTIFIERS = new Set(["cause", "error", "stack"]);
const RAW_ERROR_MEMBER_PROPERTIES = new Set(["cause", "message", "stack"]);

const isLoggerCall = (node) => {
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    isIdentifier(callee.object, "logger") &&
    isIdentifier(callee.property) &&
    LOGGER_METHODS.has(callee.property.name)
  );
};

const isStderrWriteCall = (node) => {
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    !isIdentifier(callee.property, "write")
  ) {
    return false;
  }

  return isMemberAccess(callee.object, "process", "stderr");
};

const isStringErrorCall = (node) =>
  isCallTo(node, "String") && node.arguments.some(isRawErrorExpression);

const isRawErrorMember = (node) => {
  if (
    node.type !== "MemberExpression" ||
    node.computed ||
    !isIdentifier(node.property) ||
    !RAW_ERROR_MEMBER_PROPERTIES.has(node.property.name)
  ) {
    return false;
  }

  return (
    isIdentifier(node.object) && RAW_ERROR_IDENTIFIERS.has(node.object.name)
  );
};

const isRawErrorExpression = (node) => {
  if (!node) {
    return false;
  }

  if (node.type === "Identifier" && RAW_ERROR_IDENTIFIERS.has(node.name)) {
    return true;
  }

  if (node.type === "MemberExpression") {
    return isRawErrorMember(node) || isRawErrorExpression(node.object);
  }

  if (isStringErrorCall(node)) {
    return true;
  }

  if (node.type === "TemplateLiteral") {
    return node.expressions.some(isRawErrorExpression);
  }

  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    return isRawErrorExpression(node.left) || isRawErrorExpression(node.right);
  }

  if (node.type === "ConditionalExpression") {
    return (
      isRawErrorExpression(node.consequent) ||
      isRawErrorExpression(node.alternate)
    );
  }

  if (node.type === "ChainExpression") {
    return isRawErrorExpression(node.expression);
  }

  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return isRawErrorExpression(node.expression);
  }

  return false;
};

const checkLoggerAttributeNode = (context, node) => {
  if (!node) {
    return;
  }

  switch (node.type) {
    case "ObjectExpression":
      checkLoggerAttributeObject(context, node);
      break;
    case "ConditionalExpression":
      checkLoggerAttributeNode(context, node.consequent);
      checkLoggerAttributeNode(context, node.alternate);
      break;
    case "LogicalExpression":
      checkLoggerAttributeNode(context, node.left);
      checkLoggerAttributeNode(context, node.right);
      break;
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ChainExpression":
      checkLoggerAttributeNode(context, node.expression);
      break;
    default:
      if (isRawErrorExpression(node)) {
        context.report({
          node,
          messageId: "rawErrorAttribute",
          data: { name: "argument" },
        });
      }
  }
};

const checkLoggerAttributeObject = (context, objectNode) => {
  for (const prop of objectNode.properties) {
    if (prop.type === "SpreadElement") {
      checkLoggerAttributeNode(context, prop.argument);
      continue;
    }

    if (prop.type !== "Property") {
      continue;
    }

    const keyName = getPropertyName(prop.key);
    if (isRawErrorExpression(prop.value)) {
      context.report({
        node: prop,
        messageId: "rawErrorAttribute",
        data: { name: keyName ?? "property" },
      });
      continue;
    }

    if (!keyName || !RAW_ERROR_PROPERTY_NAMES.has(keyName)) {
      continue;
    }

    context.report({
      node: prop,
      messageId: "rawErrorAttribute",
      data: { name: keyName },
    });
  }
};

export default {
  meta: { name: "no-raw-error-logging" },
  rules: {
    "no-raw-error-logging": {
      meta: {
        type: "problem",
        messages: {
          rawErrorAttribute:
            "Do not log raw '{{name}}' values. Log a structural error tag with errorTag(error) as 'error.type' instead.",
          rawErrorStderr:
            "Do not write raw error messages, stacks, causes, or String(error) to stderr. Use the error class/tag instead.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (isLoggerCall(node)) {
              for (const arg of node.arguments) {
                checkLoggerAttributeNode(context, arg);
              }
              return;
            }

            if (!isStderrWriteCall(node)) {
              return;
            }

            if (node.arguments.some(isRawErrorExpression)) {
              context.report({
                node,
                messageId: "rawErrorStderr",
              });
            }
          },
        };
      },
    },
  },
};
