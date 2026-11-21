// Native encoding preferences apply only to explicitly verified Bun files.
// Receivers need visible native constructor/producer provenance through stable
// bindings. Unknown parameters, custom methods and shadowed globals stay valid.
// Optional or computed calls are reported without an automatic replacement.
// Headers records stay report-only because toJSON retains set-cookie as an array.

import {
  type Context,
  eslintCompatPlugin,
  type Variable,
} from "@oxlint/plugins";

import {
  type AstNode,
  isAstNode,
  isIdentifierReference,
  isUnshadowedGlobalIdentifier,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

const NATIVE_ENCODING = {
  hex: "toHex()",
  base64: "toBase64()",
  base64url: 'toBase64({ alphabet: "base64url", omitPadding: true })',
} as const;

const isNativeEncoding = (
  value: string | null,
): value is keyof typeof NATIVE_ENCODING =>
  value !== null && Object.hasOwn(NATIVE_ENCODING, value);

type NativeBinding =
  "Buffer" | "Headers" | "Request" | "Response" | "Object" | "fetch";

type ReceiverBindingOptions = {
  context: Context;
  variable: Variable;
  seen?: Set<Variable>;
};

const memberIsWritten = (value: AstNode): boolean => {
  let member = value;
  while (
    isAstNode(member.parent) &&
    member.parent.type === "MemberExpression" &&
    member.parent.object === member
  ) {
    member = member.parent;
  }
  const consumer = member.parent;
  return (
    isAstNode(consumer) &&
    ((consumer.type === "AssignmentExpression" && consumer.left === member) ||
      consumer.type === "UpdateExpression" ||
      (consumer.type === "UnaryExpression" && consumer.operator === "delete"))
  );
};

const hasReceiverMutation = ({
  context,
  variable,
  seen = new Set(),
}: ReceiverBindingOptions): boolean => {
  if (seen.has(variable)) {
    return false;
  }
  seen.add(variable);
  return variable.references.some((reference) => {
    if (reference.init) {
      return false;
    }
    const identifier = reference.identifier;
    if (!isAstNode(identifier) || !isAstNode(identifier.parent)) {
      return true;
    }
    const parent = identifier.parent;
    if (parent.type === "MemberExpression" && parent.object === identifier) {
      return memberIsWritten(parent);
    }
    if (
      parent.type === "VariableDeclarator" &&
      parent.init === identifier &&
      isIdentifierReference(parent.id)
    ) {
      const alias = resolveVariable(context, parent.id);
      return (
        alias === null ||
        stableInitializer(alias) === null ||
        hasReceiverMutation({ context, variable: alias, seen })
      );
    }
    if (
      (parent.type === "CallExpression" || parent.type === "NewExpression") &&
      parent.callee === identifier
    ) {
      return false;
    }
    if (
      parent.type === "CallExpression" &&
      Array.isArray(parent.arguments) &&
      parent.arguments.length === 1 &&
      parent.arguments[0] === identifier
    ) {
      const callee = unwrapExpression(parent.callee);
      return !(
        isAstNode(callee) &&
        callee.type === "MemberExpression" &&
        memberPropertyName(callee) === "fromEntries" &&
        hasNativeBinding({ context, value: callee.object, name: "Object" })
      );
    }
    // An escaped object can acquire custom methods outside the visible scope.
    return ![
      "BinaryExpression",
      "UnaryExpression",
      "ExpressionStatement",
    ].includes(parent.type);
  });
};

const receiverInitializer = ({ context, variable }: ReceiverBindingOptions) =>
  hasReceiverMutation({ context, variable })
    ? null
    : stableInitializer(variable);

type NativeBindingOptions = {
  context: Context;
  value: unknown;
  name: NativeBinding;
  seen?: Set<unknown>;
};

const hasNativeBinding = ({
  context,
  value,
  name,
  seen = new Set(),
}: NativeBindingOptions): boolean => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (name === "Buffer") {
    const imported = resolveImportedExpressionForEnforcement(context, node);
    if (
      imported?.imported === "Buffer" &&
      (imported.source === "node:buffer" || imported.source === "buffer")
    ) {
      return true;
    }
  }
  if (isIdentifierReference(node)) {
    if (node.name === name && isUnshadowedGlobalIdentifier(context, node)) {
      return true;
    }
    const variable = resolveVariable(context, node);
    const initializer =
      variable === null ? null : receiverInitializer({ context, variable });
    return (
      initializer !== null &&
      hasNativeBinding({ context, value: initializer, name, seen })
    );
  }
  return (
    node.type === "MemberExpression" &&
    memberPropertyName(node) === name &&
    isIdentifierReference(node.object) &&
    node.object.name === "globalThis" &&
    isUnshadowedGlobalIdentifier(context, node.object)
  );
};

type ReceiverKind =
  "buffer" | "headers" | "request" | "response" | "pending-response";

type ReceiverOptions = {
  context: Context;
  value: unknown;
  seen?: Set<unknown>;
};

const BUFFER_FACTORIES = new Set([
  "from",
  "alloc",
  "allocUnsafe",
  "allocUnsafeSlow",
  "concat",
]);

type ReceiverCallOptions = {
  context: Context;
  node: AstNode;
  seen: Set<unknown>;
};

const callReceiverKind = ({
  context,
  node,
  seen,
}: ReceiverCallOptions): ReceiverKind | null => {
  const callee = unwrapExpression(node.callee);
  const imported = resolveImportedExpressionForEnforcement(context, callee);
  if (
    imported?.imported === "randomBytes" &&
    (imported.source === "node:crypto" || imported.source === "crypto") &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 1
  ) {
    return "buffer";
  }
  if (hasNativeBinding({ context, value: callee, name: "fetch" })) {
    return "pending-response";
  }
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return null;
  }
  const method = memberPropertyName(callee);
  if (
    method !== null &&
    BUFFER_FACTORIES.has(method) &&
    hasNativeBinding({ context, value: callee.object, name: "Buffer" })
  ) {
    return "buffer";
  }
  const kind = receiverKind({ context, value: callee.object, seen });
  if (kind === "buffer" && (method === "subarray" || method === "slice")) {
    return kind;
  }
  return method === "clone" &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 0 &&
    (kind === "request" || kind === "response")
    ? kind
    : null;
};

const receiverKind = ({
  context,
  value,
  seen = new Set(),
}: ReceiverOptions): ReceiverKind | null => {
  const node = unwrapExpression(value);
  if (!isAstNode(node) || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    const initializer =
      variable === null ? null : receiverInitializer({ context, variable });
    return initializer === null
      ? null
      : receiverKind({ context, value: initializer, seen });
  }
  if (node.type === "AwaitExpression") {
    const kind = receiverKind({ context, value: node.argument, seen });
    return kind === "pending-response" ? "response" : kind;
  }
  if (node.type === "NewExpression") {
    for (const [name, kind] of [
      ["Headers", "headers"],
      ["Request", "request"],
      ["Response", "response"],
    ] as const) {
      if (hasNativeBinding({ context, value: node.callee, name })) {
        return kind;
      }
    }
    return null;
  }
  if (node.type === "MemberExpression") {
    if (memberPropertyName(node) !== "headers") {
      return null;
    }
    const kind = receiverKind({ context, value: node.object, seen });
    return kind === "request" || kind === "response" ? "headers" : null;
  }
  if (node.type !== "CallExpression") {
    return null;
  }
  return callReceiverKind({ context, node, seen });
};

const isHeadersSource = ({ context, value }: ReceiverOptions): boolean => {
  if (receiverKind({ context, value }) === "headers") {
    return true;
  }
  const node = unwrapExpression(value);
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    memberPropertyName(callee) === "entries" &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 0 &&
    receiverKind({ context, value: callee.object }) === "headers"
  );
};

const hasOptionalCall = (value: unknown): boolean => {
  if (!isAstNode(value)) {
    return false;
  }
  if (value.optional === true || value.type === "ChainExpression") {
    return true;
  }
  return (
    hasOptionalCall(value.callee) ||
    hasOptionalCall(value.object) ||
    hasOptionalCall(value.expression)
  );
};

const encodingCall = (value: unknown): AstNode | null => {
  const node = unwrapExpression(value);
  if (
    !isAstNode(node) ||
    node.type !== "MemberExpression" ||
    memberPropertyName(node) !== "toString"
  ) {
    return null;
  }
  return node;
};

export default eslintCompatPlugin({
  meta: { name: "prefer-bun-native" },
  rules: {
    "no-buffer-string-encoding": {
      meta: {
        type: "suggestion",
        fixable: "code",
        messages: {
          encode:
            'Encode bytes with `{{native}}` instead of `.toString("{{encoding}}")`; a string converts once with `Buffer.from(text)` first.',
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = encodingCall(node.callee);
            if (
              callee === null ||
              node.arguments.length !== 1 ||
              receiverKind({ context, value: callee.object }) !== "buffer"
            ) {
              return;
            }
            const encoding = staticStringValue(node.arguments[0]);
            if (!isNativeEncoding(encoding)) {
              return;
            }
            const native = NATIVE_ENCODING[encoding];
            const report = {
              node,
              messageId: "encode",
              data: { native: `.${native}`, encoding },
            } as const;
            if (callee.computed === true || hasOptionalCall(node)) {
              context.report(report);
              return;
            }
            const property = callee.property;
            if (!isAstNode(property)) {
              return;
            }
            context.report({
              ...report,
              fix: (fixer) =>
                fixer.replaceTextRange(
                  [property.range[0], node.range[1]],
                  native,
                ),
            });
          },
        };
      },
    },
    "no-headers-from-entries": {
      meta: {
        type: "suggestion",
        messages: {
          toJson:
            "Read a `Headers` as a record with `headers.toJSON()`; it is built natively. Note it keeps `set-cookie` as a list.",
        },
      },
      createOnce(context) {
        return {
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !hasNativeBinding({
                context,
                value: callee.object,
                name: "Object",
              }) ||
              memberPropertyName(callee) !== "fromEntries" ||
              node.arguments.length !== 1 ||
              !isHeadersSource({ context, value: node.arguments[0] })
            ) {
              return;
            }
            context.report({ node, messageId: "toJson" });
          },
        };
      },
    },
  },
});
