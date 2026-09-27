// Keep a chat turn's run independent of the request that started it.
//
// The send hands its claimed turn to a run (`chat-turn-run.ts`) and returns
// the run's response; the run then owns the turn, whether or not the request
// or its connection still exists. Anything that reaches the run must
// therefore carry nothing that reads the request. In the files this rule is
// enabled for, the request is read in exactly one way: through the send's
// `isClientConnectionAborted` probe, and only while the send itself runs.
//
//   - A read of a variable named `request`, or of a `.request` member, is
//     reported unless it sits in the initializer of the probe's declaration
//     (`const isClientConnectionAborted = () => request.signal.aborted`).
//   - A read of the probe is reported unless it is
//       (a) a call in the function that declares or receives the probe,
//           directly or inside a function handed to `Result.gen(...)` there,
//           which runs before that function returns; or
//       (b) the probe handed on under its own name, as a property of an
//           object literal in an argument of a call to a function declared in
//           this file that binds that name among its parameters, where this
//           rule then checks it again; the call itself must run as (a) does.
//     Anything else (a closure that calls it later, an alias, a store, a
//     return, a hand-off to another module) could outlive the request.
//
// Detection boundary: syntax and same-file scope. A value computed from the
// request inside the probe's initializer is out of reach, which is why that
// initializer is the only place the request may be read.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Context, Scope, Variable } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  getCalleeName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  resolveVariable,
} from "./utils.ts";

const REQUEST = "request";
const PROBE = "isClientConnectionAborted";
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const enclosingFunction = (node: AstNode): AstNode | null => {
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
};

const insideProbeDeclaration = (node: AstNode): boolean => {
  let current: unknown = node.parent;
  while (isAstNode(current)) {
    if (
      current.type === "VariableDeclarator" &&
      isIdentifier(current.id, PROBE)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/** The function whose scope declares `variable`, parameters included. */
const declaringFunction = (variable: Variable): unknown => {
  let scope: Scope | null = variable.scope;
  while (scope !== null && scope.type !== "function") {
    scope = scope.upper;
  }
  return scope?.block ?? null;
};

/** A function handed to `Result.gen(...)` runs before that call settles. */
const isResultGenCallback = (fn: AstNode): boolean => {
  const call = fn.parent;
  return (
    isAstNode(call) &&
    call.type === "CallExpression" &&
    getCalleeName(call.callee) === "Result.gen" &&
    Array.isArray(call.arguments) &&
    call.arguments.at(0) === fn
  );
};

const runsWithin = (node: AstNode, owner: unknown): boolean => {
  let fn = enclosingFunction(node);
  while (fn !== null && fn !== owner && isResultGenCallback(fn)) {
    fn = enclosingFunction(fn);
  }
  return fn !== null && fn === owner;
};

const isCallee = (node: AstNode): boolean => {
  const call = node.parent;
  return (
    isAstNode(call) && call.type === "CallExpression" && call.callee === node
  );
};

/**
 * Whether a parameter pattern binds `name` as a variable: a type annotation or
 * a destructured property's key names nothing the function can read by name.
 */
const bindsName = (pattern: unknown, name: string): boolean => {
  if (!isAstNode(pattern)) {
    return false;
  }
  switch (pattern.type) {
    case "Identifier":
      return pattern.name === name;
    case "ObjectPattern":
      return (
        Array.isArray(pattern.properties) &&
        pattern.properties.some((property) =>
          isAstNode(property) && property.type === "Property"
            ? bindsName(property.value, name)
            : bindsName(property, name),
        )
      );
    case "ArrayPattern":
      return (
        Array.isArray(pattern.elements) &&
        pattern.elements.some((element) => bindsName(element, name))
      );
    case "AssignmentPattern":
      return bindsName(pattern.left, name);
    case "RestElement":
      return bindsName(pattern.argument, name);
    case "TSParameterProperty":
      return bindsName(pattern.parameter, name);
    default:
      return false;
  }
};

/** A same-file function that binds the probe among its parameters. */
const receivesProbe = (context: Context, callee: unknown): boolean => {
  if (!isIdentifierReference(callee)) {
    return false;
  }
  const definition = resolveVariable(context, callee)?.defs.at(0)?.node;
  const fn =
    isAstNode(definition) && definition.type === "VariableDeclarator"
      ? definition.init
      : definition;
  if (!isAstNode(fn) || !FUNCTION_TYPES.has(fn.type)) {
    return false;
  }
  const params = Array.isArray(fn.params) ? fn.params : [];
  return params.some((param) => bindsName(param, PROBE));
};

/** The probe handed on under its own name to a function that receives it,
 *  in a call that runs while `owner` runs. */
const isHandedOn = (
  context: Context,
  node: AstNode,
  owner: unknown,
): boolean => {
  const property = node.parent;
  if (
    !isAstNode(property) ||
    property.type !== "Property" ||
    property.value !== node ||
    getPropertyName(property.key) !== PROBE
  ) {
    return false;
  }
  let current: unknown = property.parent;
  while (
    isAstNode(current) &&
    (current.type === "ObjectExpression" || current.type === "Property")
  ) {
    const parent: unknown = current.parent;
    if (
      current.type === "ObjectExpression" &&
      isAstNode(parent) &&
      parent.type === "CallExpression" &&
      Array.isArray(parent.arguments) &&
      parent.arguments.includes(current)
    ) {
      return runsWithin(parent, owner) && receivesProbe(context, parent.callee);
    }
    current = parent;
  }
  return false;
};

const isRead = (context: Context, node: AstNode): boolean => {
  const scope = context.sourceCode.getScope(node);
  const reference = scope.references.find(
    (candidate) => candidate.identifier === node,
  );
  return reference?.isRead() ?? false;
};

export default eslintCompatPlugin({
  meta: { name: "request-lifetime" },
  rules: {
    "confine-request-reads": {
      meta: {
        type: "problem",
        messages: {
          request:
            "A chat turn's run outlives its request: read the request only " +
            "in `const isClientConnectionAborted = () => ...` (see " +
            "chat-turn-run.ts).",
          probe:
            "`isClientConnectionAborted` reads the request, which ends when " +
            "the send hands its response back: call it only in the function " +
            "that holds it, or hand it on under its own name to a function " +
            "in this file.",
        },
      },
      createOnce(context) {
        return {
          Identifier(node) {
            if (!isAstNode(node) || !isIdentifierReference(node)) {
              return;
            }
            if (node.name === REQUEST) {
              if (
                isRead(context, node) &&
                resolveVariable(context, node) !== null &&
                !insideProbeDeclaration(node)
              ) {
                context.report({ node, messageId: "request" });
              }
              return;
            }
            if (node.name !== PROBE || !isRead(context, node)) {
              return;
            }
            const variable = resolveVariable(context, node);
            if (variable === null) {
              return;
            }
            const owner = declaringFunction(variable);
            if (isCallee(node) && runsWithin(node, owner)) {
              return;
            }
            if (isHandedOn(context, node, owner)) {
              return;
            }
            context.report({ node, messageId: "probe" });
          },
          MemberExpression(node) {
            if (
              !isAstNode(node) ||
              node.computed !== false ||
              !isIdentifier(node.property, REQUEST) ||
              insideProbeDeclaration(node)
            ) {
              return;
            }
            context.report({ node, messageId: "request" });
          },
        };
      },
    },
  },
});
