// Disallow secret-named identifiers or properties inside log / serialize sinks.
// oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/strict-boolean-expressions
//
// The TypeScript ecosystem cannot prove a string isn't a secret. Stella handles
// privileged legal data; an accidental `console.error(err, { apiKey })`,
// `JSON.stringify({ refreshToken })`, or `new Error(`probe failed: ${apiKey}`)`
// drops the secret into Sentry, logs, or response payloads. `no-console` and
// `no-raw-error-logging` already cover console + logger; this rule covers the
// remaining sinks (JSON.stringify, analytics helpers, Sentry, `new <…>Error`).
//
// Strategy: identifier-name driven. Forbid a fixed set of secret-suggestive
// names from appearing as ObjectExpression keys, MemberExpression properties,
// Identifier values, or TemplateLiteral expressions inside known sink calls.
// The rule is intentionally
// crude — it cannot follow type information, but the same crudeness means it
// catches `const k = apiKey; JSON.stringify({ k })` no better than it catches
// the direct form. Accept that gap; pair the rule with named brands for the
// type-level mix-up class of bug.
//
// Safe patterns (current codebase, all unchanged):
//   createOpenRouter({ apiKey: key })          // SDK init, not a sink
//   body.set("client_secret", clientSecret)    // URL body, not a sink
//   JSON.stringify(config)                     // variable, no forbidden name
//   { apiKey: maskApiKey(raw) }                // masked, returned to client
//
// Flagged:
//   JSON.stringify({ apiKey })
//   JSON.stringify({ providerKey: apiKey })
//   JSON.stringify({ token: session.refreshToken })   // member access
//   captureError(err, { refreshToken })
//   captureError(err, creds.clientSecret)              // member access
//   new Error(`probe failed: ${apiKey}`)
//   new APIError({ message: "x", cause: { clientSecret } })

import { getCalleeName, getPropertyName, isIdentifier } from "./utils.ts";

const SECRET_NAMES = new Set([
  "apiKey",
  "accessToken",
  "authToken",
  "bearerToken",
  "clientSecret",
  "password",
  "privateKey",
  "refreshToken",
  "staticToken",
]);

// Exact-name sink callees. Matched against the dotted callee path
// resolved by getCalleeName (Identifier or non-computed MemberExpression).
const SINK_CALLEES = new Set([
  "JSON.stringify",
  "Sentry.captureException",
  "Sentry.captureMessage",
  "captureError",
  "captureMessage",
  "posthog.capture",
]);

const isErrorConstructor = (node) => {
  if (node.type !== "NewExpression") {
    return false;
  }
  const name = getCalleeName(node.callee);
  if (name === null) {
    return false;
  }
  // Builtin and project-tagged error classes share the ...Error suffix.
  // The trailing-Error heuristic intentionally catches NewExpression on
  // any subclass (HandlerError, APIError, TaggedError, etc.).
  return name === "Error" || name.endsWith("Error");
};

const isSinkCall = (node) => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const name = getCalleeName(node.callee);
  return name !== null && SINK_CALLEES.has(name);
};

const reportIfSecretIdentifier = (context, node, contextLabel) => {
  if (isIdentifier(node) && SECRET_NAMES.has(node.name)) {
    context.report({
      node,
      messageId: "secretInSink",
      data: { name: node.name, sink: contextLabel },
    });
    return true;
  }
  return false;
};

const checkObjectExpression = (context, objectNode, contextLabel) => {
  for (const prop of objectNode.properties) {
    if (prop.type === "SpreadElement") {
      // Spread of an Identifier with a secret-suggestive name (`...apiKey`
      // is unusual but possible; `...token` is not). Recurse on the
      // argument to catch nested ObjectExpression spreads.
      checkExpression(context, prop.argument, contextLabel);
      continue;
    }
    if (prop.type !== "Property") {
      continue;
    }

    const keyName = getPropertyName(prop.key);
    if (keyName !== null && SECRET_NAMES.has(keyName)) {
      context.report({
        node: prop,
        messageId: "secretInSink",
        data: { name: keyName, sink: contextLabel },
      });
      continue;
    }

    // Non-secret key but a secret-named identifier as value:
    // `JSON.stringify({ providerKey: apiKey })`.
    checkExpression(context, prop.value, contextLabel);
  }
};

const checkExpression = (context, node, contextLabel) => {
  if (!node) {
    return;
  }

  if (reportIfSecretIdentifier(context, node, contextLabel)) {
    return;
  }

  switch (node.type) {
    case "ObjectExpression":
      checkObjectExpression(context, node, contextLabel);
      break;
    case "TemplateLiteral":
      for (const expr of node.expressions) {
        checkExpression(context, expr, contextLabel);
      }
      break;
    case "BinaryExpression":
    case "LogicalExpression":
      checkExpression(context, node.left, contextLabel);
      checkExpression(context, node.right, contextLabel);
      break;
    case "ConditionalExpression":
      checkExpression(context, node.consequent, contextLabel);
      checkExpression(context, node.alternate, contextLabel);
      break;
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ChainExpression":
      checkExpression(context, node.expression, contextLabel);
      break;
    case "MemberExpression": {
      // `creds.clientSecret`, `session["refreshToken"]` — the accessed
      // property name is visible in the AST even when the value's type
      // is not. Mirrors the ObjectExpression key check. Member access
      // is the dominant real-world leak path, so it must be covered.
      const propertyName = getPropertyName(node.property);
      if (propertyName !== null && SECRET_NAMES.has(propertyName)) {
        context.report({
          node,
          messageId: "secretInSink",
          data: { name: propertyName, sink: contextLabel },
        });
        break;
      }
      // Non-secret leaf: keep walking the object chain so a secret read
      // deeper in the access (`getCreds().clientSecret`) is still caught.
      checkExpression(context, node.object, contextLabel);
      break;
    }
    case "AwaitExpression":
      checkExpression(context, node.argument, contextLabel);
      break;
    case "AssignmentExpression":
      checkExpression(context, node.right, contextLabel);
      break;
    case "ArrayExpression":
      for (const element of node.elements) {
        checkExpression(context, element, contextLabel);
      }
      break;
    default:
      break;
  }
};

export default {
  meta: { name: "no-secret-in-log-sink" },
  rules: {
    "no-secret-in-log-sink": {
      meta: {
        type: "problem",
        messages: {
          secretInSink:
            "Do not pass '{{name}}' to {{sink}}. Sinks (JSON.stringify, analytics, Sentry, Error constructors) may serialize the value into logs, telemetry, or response bodies. Strip the field, mask it (maskApiKey), or use a structural error tag.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isSinkCall(node)) {
              return;
            }
            const sinkLabel = getCalleeName(node.callee) ?? "sink";
            for (const arg of node.arguments) {
              checkExpression(context, arg, sinkLabel);
            }
          },
          NewExpression(node) {
            if (!isErrorConstructor(node)) {
              return;
            }
            const sinkLabel = `new ${getCalleeName(node.callee) ?? "Error"}`;
            for (const arg of node.arguments) {
              checkExpression(context, arg, sinkLabel);
            }
          },
        };
      },
    },
  },
};
