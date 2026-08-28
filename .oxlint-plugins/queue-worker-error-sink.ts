// Keep every queue worker's `error` event on the throttled sink.
//
// A BullMQ worker's `error` event fires once per failed blocking poll, so a
// Valkey disruption raises one event per poll on every worker at once. A
// handler that logs each occurrence turns a transient into an unbounded run of
// identical lines, which buries every other record for the duration and makes
// the error rate report the retry rate. `createQueueWorkerErrorLogger` bounds
// that, and the bound only holds while every handler goes through it.
//
// The call sites are ordinary callbacks, so no type can carry this. A source
// scan cannot either: it misses an event name held in a constant, and
// `logger.error(WORKER_ERROR_EVENT, fields)` would restore the storm while
// reading as ordinary code. Hence an AST rule, matching both the callback that
// logs directly and the sink named through a binding.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import { isAstNode, isIdentifier, isStringLiteral } from "./utils.ts";

const SINK_EVENT_SUFFIX = ".worker_error";

const walk = (value: unknown, visit: (node: AstNode) => void): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walk(entry, visit);
    }
    return;
  }
  if (!isAstNode(value)) {
    return;
  }
  visit(value);
  for (const key of Object.keys(value)) {
    // `parent` back-references would make this walk cyclic.
    if (key === "parent") {
      continue;
    }
    walk(value[key], visit);
  }
};

const isLoggerErrorCall = (node: AstNode): boolean => {
  if (node.type !== "CallExpression" || !isAstNode(node.callee)) {
    return false;
  }
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifier(callee.object, "logger") &&
    isIdentifier(callee.property, "error")
  );
};

const isFunctionNode = (node: unknown): node is AstNode =>
  isAstNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression");

// `<emitter>.on("error", <function>)` — the registration this rule guards.
const errorHandlerArgument = (node: AstNode): AstNode | null => {
  if (node.type !== "CallExpression" || !isAstNode(node.callee)) {
    return null;
  }
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed === true ||
    !isIdentifier(callee.property, "on")
  ) {
    return null;
  }
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  const [event, handler] = args;
  if (!isStringLiteral(event) || event.value !== "error") {
    return null;
  }
  return isFunctionNode(handler) ? handler : null;
};

const staticStringValue = (
  node: unknown,
  constants: ReadonlyMap<string, string>,
): string | null => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (isIdentifier(node)) {
    return constants.get(node.name) ?? null;
  }
  // A template with no substitutions is still a fixed name.
  if (isAstNode(node) && node.type === "TemplateLiteral") {
    const expressions = Array.isArray(node.expressions) ? node.expressions : [];
    const quasis = Array.isArray(node.quasis) ? node.quasis : [];
    if (expressions.length > 0 || quasis.length !== 1) {
      return null;
    }
    const [only] = quasis;
    if (!isAstNode(only) || !isAstNode(only.value)) {
      return null;
    }
    const cooked = only.value["cooked"];
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
};

const collectStringConstants = (program: unknown): Map<string, string> => {
  const constants = new Map<string, string>();
  walk(program, (node) => {
    if (node.type !== "VariableDeclarator") {
      return;
    }
    if (!isIdentifier(node.id) || !isStringLiteral(node.init)) {
      return;
    }
    constants.set(node.id.name, node.init.value);
  });
  return constants;
};

export default eslintCompatPlugin({
  meta: { name: "queue-worker-error-sink" },
  rules: {
    "queue-worker-error-sink": {
      meta: {
        type: "problem",
        messages: {
          directLogInHandler:
            "A worker `error` callback must not call logger.error directly. " +
            "A Valkey disruption raises this event once per failed poll, so an unthrottled sink logs an unbounded run of identical lines. " +
            "Pass createQueueWorkerErrorLogger(event, fields) as the handler, or delegate to one built outside the callback.",
          namedSinkOutsideHelper:
            "A `*.worker_error` event may only be logged by createQueueWorkerErrorLogger. " +
            "Logging it here reintroduces the unbounded run this helper exists to bound, for this queue alone. " +
            "Build the handler with createQueueWorkerErrorLogger instead.",
        },
        schema: [],
      },
      createOnce(context) {
        return {
          Program(program) {
            const constants = collectStringConstants(program);

            walk(program, (node) => {
              const handler = errorHandlerArgument(node);
              if (handler !== null) {
                walk(handler, (inner) => {
                  if (isLoggerErrorCall(inner)) {
                    context.report({
                      node: inner,
                      messageId: "directLogInHandler",
                    });
                  }
                });
              }

              if (!isLoggerErrorCall(node)) {
                return;
              }
              const args = Array.isArray(node.arguments) ? node.arguments : [];
              const name = staticStringValue(args[0], constants);
              if (name !== null && name.endsWith(SINK_EVENT_SUFFIX)) {
                context.report({
                  node,
                  messageId: "namedSinkOutsideHelper",
                });
              }
            });
          },
        };
      },
    },
  },
});
