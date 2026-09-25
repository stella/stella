import { eslintCompatPlugin } from "@oxlint/plugins";

import { getPropertyName, isAstNode, isIdentifier } from "./utils.ts";
import type { AstNode } from "./utils.ts";

// Reject log attribute keys the logger would redact.
//
// `sanitizeLogAttributes` (apps/api/src/lib/observability/logger.ts) drops
// every attribute whose key matches the sensitive-key denylist and replaces
// it with a `log.attributes_dropped` count. That is the right behaviour for
// a key that carries a payload, and a silent loss for one that does not: a
// `queueName` attribute never reached a sink, and the test that covered it
// asserted the call argument rather than the record. This rule moves the
// decision to where the key is written.
//
// Flagged: a static key (identifier, string literal, or shorthand property)
// that matches the denylist, inside the attribute object of
// `logger.debug|info|warn|error(message, { ... })`; and inside the `ctx` of
// `observeFailure(error, { sink, ctx: { ... } })`, any key outside the
// reviewed `FAILURE_CONTEXT_KEYS`, since the owner drops it at runtime.
//
// Accepted: a key that does not match; computed keys and spreads, which
// carry no static name to check; and any attribute object that is not a
// direct argument of a logger call, since a helper that forwards fields
// (`createQueueWorkerErrorLogger(event, fields)`) is checked at the logger
// call inside it only when its literal is written there.
//
// The pattern is a copy of `SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN` in
// apps/api/src/lib/observability/log-attribute-policy.ts, and the context keys
// a copy of `FAILURE_CONTEXT_KEYS` in
// apps/api/src/lib/observability/observe-failure.ts; plugins cannot import
// application modules, so
// apps/api/src/tests/security/oxlint-guardrails.test.ts holds each pair equal.

const RULE_NAME = "no-redacted-log-attribute-key";
const LOGGER_IDENTIFIER = "logger";
const LOGGER_METHODS = new Set(["debug", "error", "info", "warn"]);

export const SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN =
  /(?:body|content|email|fileName|message|name|title|password|secret|credential|authorization|cookie|bearer|api[_-]?key|prompt(?!_?token)|snippet|subject|phone)/iu;

export const FAILURE_CONTEXT_KEYS = [
  "adapterKey",
  "decisionId",
  "documentId",
  "entityId",
  "feature",
  "jobId",
  "method",
  "mode",
  "modelId",
  "operation",
  "organizationId",
  "phase",
  "queue",
  "requestId",
  "route",
  "runId",
  "source",
  "stage",
  "step",
  "threadId",
  "toolName",
  "userFileId",
  "versionId",
  "workspaceId",
];

const FAILURE_CONTEXT_KEY_SET = new Set(FAILURE_CONTEXT_KEYS);
const OBSERVE_FAILURE_IDENTIFIER = "observeFailure";
const CONTEXT_PROPERTY = "ctx";

const isLoggerCall = (node: { callee: unknown }): boolean => {
  const callee = node.callee;
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isIdentifier(callee.object, LOGGER_IDENTIFIER) &&
    isIdentifier(callee.property) &&
    LOGGER_METHODS.has(callee.property.name)
  );
};

const isObserveFailureCall = (node: { callee: unknown }): boolean =>
  isIdentifier(node.callee, OBSERVE_FAILURE_IDENTIFIER);

const objectProperties = (node: unknown): unknown[] =>
  isAstNode(node) &&
  node.type === "ObjectExpression" &&
  Array.isArray(node.properties)
    ? node.properties
    : [];

const staticPropertyKey = (property: unknown): string | null =>
  isAstNode(property) && property.type === "Property" && !property.computed
    ? getPropertyName(property.key)
    : null;

type UnreviewedContextKey = { node: AstNode; key: string };

// The `ctx` keys of an `observeFailure` call outside the reviewed list.
const unreviewedContextKeys = (node: {
  arguments: unknown[];
}): UnreviewedContextKey[] => {
  const options = node.arguments.at(1);
  const ctx = objectProperties(options).find(
    (property) => staticPropertyKey(property) === CONTEXT_PROPERTY,
  );
  if (!isAstNode(ctx) || ctx.type !== "Property") {
    return [];
  }
  const unreviewed: UnreviewedContextKey[] = [];
  for (const property of objectProperties(ctx.value)) {
    const key = staticPropertyKey(property);
    if (
      key !== null &&
      isAstNode(property) &&
      !FAILURE_CONTEXT_KEY_SET.has(key)
    ) {
      unreviewed.push({ node: property, key });
    }
  }
  return unreviewed;
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          redactedKey:
            "Log attribute `{{key}}` matches the logger's sensitive-key " +
            "denylist, so the sanitizer drops it and the record ships " +
            "without it. Rename the key (for example `queue` instead of " +
            "`queueName`), or leave the value out if it is a payload.",
          unreviewedContextKey:
            "Failure context key `{{key}}` is not in FAILURE_CONTEXT_KEYS, " +
            "so observeFailure drops it. Use a reviewed correlation key, or " +
            "add this one to the reviewed list with its reason.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            if (isObserveFailureCall(node)) {
              for (const { node: property, key } of unreviewedContextKeys(
                node,
              )) {
                context.report({
                  node: property,
                  messageId: "unreviewedContextKey",
                  data: { key },
                });
              }
              return;
            }
            if (!isLoggerCall(node)) {
              return;
            }
            const attributes = node.arguments.at(1);
            if (
              !isAstNode(attributes) ||
              attributes.type !== "ObjectExpression" ||
              !Array.isArray(attributes.properties)
            ) {
              return;
            }
            for (const property of attributes.properties) {
              if (
                !isAstNode(property) ||
                property.type !== "Property" ||
                property.computed
              ) {
                continue;
              }
              const key = getPropertyName(property.key);
              if (
                key === null ||
                !SENSITIVE_LOG_ATTRIBUTE_KEY_PATTERN.test(key)
              ) {
                continue;
              }
              context.report({
                node: property,
                messageId: "redactedKey",
                data: { key },
              });
            }
          },
        };
      },
    },
  },
});
