// Disallow ownership-ID parameters typed as bare `string`.
//
// Companion to `no-body-ownership-ids`. That rule blocks the
// SOURCE of unbranded IDs (request body / query). This rule
// blocks the SINK: function parameters that accept ownership
// IDs must declare a branded type (SafeId<"...">,
// ValidatedOrgUserId, etc.) so the boundary is structural,
// not a matter of discipline.
//
// What it catches:
//   const f = (userId: string) => …
//   const f = ({ workspaceId }) => …
//   const f = ({ workspaceId }: { workspaceId: string }) => …
//   function g(organizationId: string) {}
//
// What it does NOT catch (out of scope for a syntactic rule):
//   - Type aliases used in the parameter position
//     (`(args: Props)` where `type Props = { userId: string }`)
//     — surface those by inspecting the alias separately or
//     letting the type checker complain at the call site once
//     the helper signature is tightened.
//   - Object types declared in standalone interfaces / types
//     consumed by other code paths.
//
// Skipped names: configurable via the rule's `names` option
// (defaults below). Skipped contexts: test files / fixtures,
// configured via oxlint.config.ts overrides.

const DEFAULT_NAMES = new Set(["workspaceId", "organizationId", "userId"]);

const SAFE_HANDLER_FACTORIES = new Set([
  "createSafeHandler",
  "createSafeRootHandler",
]);

const CONTEXT_TYPED_PROPERTY_NAMES = new Set(["execute"]);

const getIdentifierName = (node) => {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
};

const containsBareString = (typeNode) => {
  if (!typeNode) return false;
  if (typeNode.type === "TSStringKeyword") return true;
  if (
    typeNode.type === "TSUnionType" ||
    typeNode.type === "TSIntersectionType"
  ) {
    return typeNode.types.some(containsBareString);
  }
  return false;
};

const isBareStringAnnotation = (typeAnnotation) => {
  const inner = typeAnnotation?.typeAnnotation;
  // Sensitive ownership ID params need explicit annotations. Otherwise
  // default values and other inference contexts can still infer `string`
  // and bypass the sink-side brand check.
  if (!inner) return true;
  // Any bare `string` in the type — including `SafeId<X> | string` —
  // is a loophole: a caller can still pass an unvalidated string and
  // satisfy the union. The brand is only structural if `string` is
  // absent everywhere in the type.
  return containsBareString(inner);
};

const getCalleeName = (callee) => {
  if (!callee) return null;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return getIdentifierName(callee.property);
  }
  return null;
};

const isKnownValidatedContextParam = (functionNode) => {
  const parent = functionNode.parent;
  if (!parent) return false;

  if (
    parent.type === "CallExpression" &&
    SAFE_HANDLER_FACTORIES.has(getCalleeName(parent.callee))
  ) {
    return true;
  }

  if (
    parent.type === "Property" &&
    CONTEXT_TYPED_PROPERTY_NAMES.has(getIdentifierName(parent.key))
  ) {
    return true;
  }

  return false;
};

const checkUnannotatedObjectPattern = (
  context,
  objectPattern,
  triggerNames,
  options,
) => {
  if (options.allowContextualObjectPattern) {
    return;
  }

  for (const property of objectPattern.properties ?? []) {
    if (property.type !== "Property") continue;
    const keyName = getIdentifierName(property.key);
    if (!keyName || !triggerNames.has(keyName)) continue;
    context.report({
      node: property,
      messageId: "unbrandedParam",
      data: { name: keyName },
    });
  }
};

const checkObjectPattern = (context, objectPattern, triggerNames, options) => {
  const typeAnnotation = objectPattern.typeAnnotation?.typeAnnotation;
  if (!typeAnnotation) {
    checkUnannotatedObjectPattern(
      context,
      objectPattern,
      triggerNames,
      options,
    );
    return;
  }
  if (typeAnnotation.type !== "TSTypeLiteral") {
    return;
  }
  for (const member of typeAnnotation.members) {
    if (member.type !== "TSPropertySignature") continue;
    const keyName = getIdentifierName(member.key);
    if (!keyName || !triggerNames.has(keyName)) continue;
    if (!isBareStringAnnotation(member.typeAnnotation)) continue;
    context.report({
      node: member,
      messageId: "unbrandedParam",
      data: { name: keyName },
    });
  }
};

const checkParam = (context, param, triggerNames) => {
  if (param.type === "Identifier") {
    if (!triggerNames.has(param.name)) return;
    if (!isBareStringAnnotation(param.typeAnnotation)) return;
    context.report({
      node: param,
      messageId: "unbrandedParam",
      data: { name: param.name },
    });
    return;
  }
  if (param.type === "ObjectPattern") {
    checkObjectPattern(context, param, triggerNames, {
      allowContextualObjectPattern: false,
    });
    return;
  }
  // AssignmentPattern wraps a default value: `userId: string = "x"`
  if (param.type === "AssignmentPattern" && param.left) {
    checkParam(context, param.left, triggerNames);
  }
};

export default {
  meta: { name: "no-unbranded-ownership-id-param" },
  rules: {
    "no-unbranded-ownership-id-param": {
      meta: {
        type: "problem",
        messages: {
          unbrandedParam:
            "Ownership ID parameter '{{name}}' must use a branded " +
            'type (SafeId<"..."> or ValidatedOrgUserId), not bare ' +
            "'string'. Brand at the boundary so the type system " +
            "carries proof of validation.",
        },
        schema: [
          {
            type: "object",
            properties: {
              names: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const options = context.options?.[0] ?? {};
        const triggerNames =
          Array.isArray(options.names) && options.names.length > 0
            ? new Set(options.names)
            : DEFAULT_NAMES;

        const visitFunctionLike = (node) => {
          if (!Array.isArray(node.params)) return;
          const allowContextualObjectPattern =
            isKnownValidatedContextParam(node);
          for (const param of node.params) {
            if (param.type === "ObjectPattern") {
              checkObjectPattern(context, param, triggerNames, {
                allowContextualObjectPattern,
              });
              continue;
            }
            checkParam(context, param, triggerNames);
          }
        };

        return {
          FunctionDeclaration: visitFunctionLike,
          FunctionExpression: visitFunctionLike,
          ArrowFunctionExpression: visitFunctionLike,
          TSFunctionType: visitFunctionLike,
          TSMethodSignature: visitFunctionLike,
          TSDeclareFunction: visitFunctionLike,
        };
      },
    },
  },
};
