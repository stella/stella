// Forbid `.catch(() => <literal>)` — the sanctioned way to drop a rejection.
//
// `no-detached-void` bans the `void` operator so a fire-and-forget promise has
// to go through `detached(promise, context)` and reach the error-capture
// channel. A same-line `.catch(() => null)` satisfies every floating-promise
// check while doing exactly what the `void` ban exists to prevent: the
// rejection is discarded, and a transient failure becomes indistinguishable
// from a legitimate empty result. The two guards belong together.
//
// Flagged: a `.catch(...)` callback whose whole body is a literal-ish value
// (`undefined`, `null`, a boolean/string/number, an empty object/array, an
// empty template) or an empty block.
//
//   promise.catch(() => null);
//   promise.catch(() => undefined);
//   promise.catch(() => {});
//   promise.catch(() => { /* fire-and-forget */ });
//   promise.catch(() => "");
//
// Allowed receivers (`ALLOWED_RECEIVER_METHODS`) — two classes where the
// fallback is the whole point of the call and the rejection carries no
// information the caller does not already have:
//
//   - Response body consumption (`json`, `text`, `arrayBuffer`, `blob`,
//     `bytes`, `formData`). The caller is reading a body it already knows may
//     be absent or malformed, usually to enrich an error it is about to
//     report; the fallback IS the handling.
//   - Resource teardown (`cancel`, `close`, `abort`). Cancelling a stream
//     reader or closing a handle during unwind cannot be retried or reported
//     usefully, and letting it reject would mask the original failure.
//
//   await reader.cancel().catch(() => undefined);
//   const detail = await response.text().catch(() => "");
//
// `Bun.file(path).text()` is excluded from the allowlist even though it ends
// in an allowlisted method: the path is configured, so a failed read means the
// file is missing or unreadable, which is information, not an empty body. The
// exclusion follows a `const file = Bun.file(path)` binding too, so extracting
// the handle does not buy back the allowlisted verdict.
//
// Everything else must either handle the rejection (capture it, surface it,
// propagate it) or route the promise through `detached(promise, context)`,
// which captures for you. A `.catch` callback with a real body — logging,
// capture, a toast, state reset — is untouched by this rule.
//
// `require-rejection-parameter` is the companion rule exported by this module.
// It requires inline and locally resolvable `.catch` callbacks, plus `.then`
// rejection callbacks, to bind the rejection reason. It deliberately does
// not claim that binding a parameter proves the error was handled; the rule
// above owns that narrower constant-swallowing invariant. Both rules share the
// receiver allowlist, including the stricter Bun.file exclusion.
// Both guards recognize Promise-like method syntax without type information;
// unrelated APIs named `catch` or `then` need a narrow explained suppression.

import { eslintCompatPlugin, type SourceCode } from "@oxlint/plugins";

import { isAstNode, isIdentifier, type AstNode } from "./utils.ts";

const ALLOWED_RECEIVER_METHODS = new Set([
  // Response body consumption.
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
  // Resource teardown.
  "abort",
  "cancel",
  "close",
]);

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

const unwrap = (node: unknown): AstNode | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (
    node.type === "ChainExpression" ||
    node.type === "ParenthesizedExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return unwrap(node.expression);
  }
  return node;
};

// Resolve a member name only when the syntax itself fixes it. Dynamic
// computed calls stay out of scope: `promise[method](handler)` may be an
// unrelated API, while `promise["catch"](handler)` is the same Promise shape
// as dot notation.
const memberPropertyName = (node: unknown): string | null => {
  const member = unwrap(node);
  if (member?.type !== "MemberExpression") {
    return null;
  }
  if (!member.computed && isIdentifier(member.property)) {
    return member.property.name;
  }
  if (
    member.computed &&
    isAstNode(member.property) &&
    member.property.type === "Literal" &&
    typeof member.property.value === "string"
  ) {
    return member.property.value;
  }
  return null;
};

// A value carrying no information about the failure it stands in for.
const isLiteralValue = (node: unknown): boolean => {
  const value = unwrap(node);
  if (value === null) {
    return false;
  }
  switch (value.type) {
    case "Literal":
      return true;
    case "Identifier":
      return isIdentifier(value, "undefined");
    case "ObjectExpression":
      return Array.isArray(value.properties) && value.properties.length === 0;
    case "ArrayExpression":
      return Array.isArray(value.elements) && value.elements.length === 0;
    case "TemplateLiteral":
      return Array.isArray(value.expressions) && value.expressions.length === 0;
    case "UnaryExpression":
      // `-1`, `+0`: still a bare constant.
      return isLiteralValue(value.argument);
    default:
      return false;
  }
};

// True when the callback does nothing but yield a constant.
const swallowsRejection = (handler: AstNode): boolean => {
  const body = unwrap(handler.body);
  if (body === null) {
    return false;
  }
  if (body.type !== "BlockStatement") {
    return isLiteralValue(body);
  }
  const statements = Array.isArray(body.body) ? body.body : [];
  if (statements.length === 0) {
    return true;
  }
  if (statements.length > 1) {
    return false;
  }
  const [only] = statements;
  if (!isAstNode(only) || only.type !== "ReturnStatement") {
    return false;
  }
  return only.argument === null || isLiteralValue(only.argument);
};

const isBunFileCall = (node: AstNode | null): boolean =>
  node?.type === "CallExpression" &&
  (() => {
    const callee = unwrap(node.callee);
    return (
      callee?.type === "MemberExpression" &&
      memberPropertyName(callee) === "file" &&
      isIdentifier(callee.object, "Bun")
    );
  })();

// The initializer of a `const <name> = ...` declared in an enclosing block or
// program body. Walked over the parent chain rather than resolved through
// scopes because the rest of this rule works on the loose node shape and a
// declaration this rule cares about is always a statement in one of these
// bodies.
const enclosingConstInitializer = (
  identifier: AstNode & { name: string },
): AstNode | null => {
  let current = isAstNode(identifier.parent) ? identifier.parent : null;
  while (current !== null) {
    const body = Array.isArray(current.body) ? current.body : [];
    for (const statement of body) {
      if (
        !isAstNode(statement) ||
        statement.type !== "VariableDeclaration" ||
        statement.kind !== "const"
      ) {
        continue;
      }
      const declarations = Array.isArray(statement.declarations)
        ? statement.declarations
        : [];
      for (const declarator of declarations) {
        if (
          isAstNode(declarator) &&
          isIdentifier(declarator.id, identifier.name)
        ) {
          return unwrap(declarator.init);
        }
      }
    }
    current = isAstNode(current.parent) ? current.parent : null;
  }
  return null;
};

// `Bun.file(path)` written inline, or held by a `const` the receiver names.
// Extracting the handle into a variable is the same read, so it must reach the
// same verdict.
const isBunFileReceiver = (node: unknown): boolean => {
  const source = unwrap(node);
  if (source === null) {
    return false;
  }
  if (isBunFileCall(source)) {
    return true;
  }
  return (
    isIdentifier(source) && isBunFileCall(enclosingConstInitializer(source))
  );
};

// The method whose result the `.catch` is attached to, e.g. `cancel` for
// `reader.cancel().catch(...)`. Null when the receiver is not a method call.
const receiverMethodName = (calleeObject: unknown): string | null => {
  const receiver = unwrap(calleeObject);
  if (receiver?.type !== "CallExpression") {
    return null;
  }
  const callee = unwrap(receiver.callee);
  if (callee?.type !== "MemberExpression") {
    return null;
  }
  // A filesystem read at a configured path is not an optional body read.
  if (isBunFileReceiver(callee.object)) {
    return null;
  }
  return memberPropertyName(callee);
};

const hasRuntimeParameter = (handler: AstNode): boolean => {
  const params = Array.isArray(handler.params) ? handler.params : [];
  return params.some((parameter) => !isIdentifier(parameter, "this"));
};

type ScopeIdentifier = Parameters<SourceCode["getScope"]>[0] & {
  type: "Identifier";
  name: string;
};

const isScopeIdentifier = (node: unknown): node is ScopeIdentifier =>
  isIdentifier(node);

const createHandlerResolver = (sourceCode: SourceCode) => {
  const resolveVariable = (identifier: ScopeIdentifier) => {
    let scope: ReturnType<typeof sourceCode.getScope> | null =
      sourceCode.getScope(identifier);
    while (scope) {
      const variable = scope.set.get(identifier.name);
      if (variable !== undefined) {
        return variable;
      }
      scope = scope.upper;
    }
    return null;
  };

  const resolveHandler = (
    expression: unknown,
    seen = new Set<unknown>(),
  ): AstNode | null => {
    const current = unwrap(expression);
    if (current === null) {
      return null;
    }
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      return current;
    }
    if (!isScopeIdentifier(current)) {
      return null;
    }

    const variable = resolveVariable(current);
    if (variable === null || seen.has(variable) || variable.defs.length !== 1) {
      return null;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(variable);
    const definition = variable.defs.at(0);
    if (definition === undefined) {
      return null;
    }
    if (
      definition.type === "FunctionName" &&
      isAstNode(definition.node) &&
      definition.node.type === "FunctionDeclaration"
    ) {
      return definition.node;
    }
    if (
      definition.type !== "Variable" ||
      !isAstNode(definition.node) ||
      definition.node.type !== "VariableDeclarator" ||
      !isAstNode(definition.parent) ||
      definition.parent.type !== "VariableDeclaration" ||
      definition.parent.kind !== "const"
    ) {
      return null;
    }
    return resolveHandler(definition.node.init, nextSeen);
  };

  return { resolveHandler, resolveVariable };
};

const rejectionHandlerArgument = (node: unknown): AstNode | null => {
  if (!isAstNode(node)) {
    return null;
  }
  const callee = unwrap(node.callee);
  if (callee?.type !== "MemberExpression") {
    return null;
  }
  const method = memberPropertyName(callee);
  const argumentIndex = method === "catch" ? 0 : method === "then" ? 1 : -1;
  if (argumentIndex < 0) {
    return null;
  }
  const argumentsList = Array.isArray(node.arguments) ? node.arguments : [];
  for (let index = 0; index <= argumentIndex; index += 1) {
    const argument = argumentsList[index];
    if (!isAstNode(argument) || argument.type === "SpreadElement") {
      return null;
    }
    if (index === argumentIndex) {
      return argument;
    }
  }
  return null;
};

export default eslintCompatPlugin({
  meta: { name: "no-swallowed-rejection" },
  rules: {
    "no-swallowed-rejection": {
      meta: {
        type: "problem",
        messages: {
          swallowedRejection:
            "This `.catch` discards the rejection and returns a constant, so a transient failure is indistinguishable from a real result. Capture the error (`captureError`/`logger`) and return the fallback, surface it to the caller, or hand the promise to `detached(promise, context)` if it is genuinely fire-and-forget.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrap(node.callee);
            if (
              callee?.type !== "MemberExpression" ||
              memberPropertyName(callee) !== "catch"
            ) {
              return;
            }

            const [handler] = Array.isArray(node.arguments)
              ? node.arguments
              : [];
            if (
              !isAstNode(handler) ||
              !FUNCTION_NODE_TYPES.has(handler.type) ||
              !swallowsRejection(handler)
            ) {
              return;
            }

            const method = receiverMethodName(callee.object);
            if (method !== null && ALLOWED_RECEIVER_METHODS.has(method)) {
              return;
            }

            context.report({ node: handler, messageId: "swallowedRejection" });
          },
        };
      },
    },
    "require-rejection-parameter": {
      meta: {
        type: "problem",
        messages: {
          missingRejectionParameter:
            "Promise rejection callbacks must declare the rejection reason; add a parameter and handle it, or use a narrow explained suppression when ignoring it is intentional.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const handler = rejectionHandlerArgument(node);
            if (handler === null) {
              return;
            }

            const { resolveHandler, resolveVariable } = createHandlerResolver(
              context.sourceCode,
            );
            const resolved = resolveHandler(handler);
            if (resolved === null || hasRuntimeParameter(resolved)) {
              return;
            }

            const callee = unwrap(node.callee);
            if (callee?.type !== "MemberExpression") {
              return;
            }
            // Passing the same continuation on either outcome explicitly
            // models sequencing or queue cleanup, not rejection recovery.
            if (memberPropertyName(callee) === "then") {
              const body = unwrap(resolved.body);
              const statements =
                body?.type === "BlockStatement" && Array.isArray(body.body)
                  ? body.body
                  : [];
              const last = statements.at(-1);
              const returned =
                isAstNode(last) &&
                last.type === "ReturnStatement" &&
                statements
                  .slice(0, -1)
                  .every(
                    (statement) =>
                      isAstNode(statement) &&
                      statement.type === "ExpressionStatement",
                  )
                  ? unwrap(last.argument)
                  : body;
              const forwarded =
                returned?.type === "AwaitExpression"
                  ? unwrap(returned.argument)
                  : returned;
              if (
                isScopeIdentifier(forwarded) &&
                isScopeIdentifier(callee.object)
              ) {
                const receiver = resolveVariable(callee.object);
                if (
                  receiver !== null &&
                  resolveVariable(forwarded) === receiver &&
                  receiver.defs.some(
                    (definition) =>
                      definition.type === "Variable" &&
                      definition.parent?.type === "VariableDeclaration" &&
                      definition.parent.kind === "const",
                  )
                ) {
                  return;
                }
              }
              const success = node.arguments.at(0);
              const resolvedSuccess = resolveHandler(success);
              if (
                resolvedSuccess === resolved ||
                (isAstNode(success) &&
                  FUNCTION_NODE_TYPES.has(success.type) &&
                  FUNCTION_NODE_TYPES.has(handler.type) &&
                  context.sourceCode.getText(success) ===
                    context.sourceCode.getText(handler))
              ) {
                return;
              }
            }
            const method = receiverMethodName(callee.object);
            if (method !== null && ALLOWED_RECEIVER_METHODS.has(method)) {
              return;
            }

            context.report({
              node: handler,
              messageId: "missingRejectionParameter",
            });
          },
        };
      },
    },
  },
});
