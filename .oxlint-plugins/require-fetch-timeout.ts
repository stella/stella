// Require an AbortSignal on every fetch() call so upstream hangs don't
// hang the request/worker indefinitely.
//
// CLAUDE.md mandates `fetch(url, { signal: AbortSignal.timeout(...) })`
// (or a propagated controller/upstream signal). Without a signal, a
// slow third-party endpoint stalls the entire handler — invisible in
// dev, paging on-call in prod.
//
// Flags:
//   fetch(url)                       // no options at all
//   fetch(url, {})                   // empty options
//   fetch(url, { method: "POST" })   // options without `signal`
//   globalThis.fetch(url, { ... })   // same, via global access
//   window.fetch(url, { ... })
//
// Allows:
//   fetch(url, { signal: AbortSignal.timeout(10_000) })
//   fetch(url, { signal: controller.signal })
//   fetch(url, { signal: req.signal, method: "POST" })
//   fetch(url, opts)                 // opaque variable — can't inspect
//   fetch(url, { ...rest })          // spread may carry signal
//   fetch(request)                   // Request-typed variable may carry signal
//   fetch(request, { method: "POST" }) // Request's signal remains in effect
//
// Escape hatch: `// eslint-disable-next-line require-fetch-timeout/require-fetch-timeout`
// with a `// SAFETY:` comment explaining why the call cannot hang
// (e.g. local file: URL, in-process Bun.serve handler).

import { getPropertyName, isIdentifier } from "./utils.ts";

const getNodeType = (node: unknown): string | null => {
  if (typeof node !== "object" || node === null || !("type" in node)) {
    return null;
  }
  return typeof node.type === "string" ? node.type : null;
};

const getNodeArguments = (node: unknown): unknown[] | null => {
  if (
    typeof node !== "object" ||
    node === null ||
    !("arguments" in node) ||
    !Array.isArray(node.arguments)
  ) {
    return null;
  }
  return node.arguments.map((value: unknown) => value);
};

const unwrapExpression = (node: unknown): unknown => {
  let current = node;
  while (
    getNodeType(current) === "TSAsExpression" ||
    getNodeType(current) === "TSSatisfiesExpression" ||
    getNodeType(current) === "TSNonNullExpression" ||
    getNodeType(current) === "TypeCastExpression"
  ) {
    if (
      typeof current !== "object" ||
      current === null ||
      !("expression" in current)
    ) {
      return current;
    }
    current = current.expression;
  }
  return current;
};

const getObjectExpressionProperties = (node: unknown): unknown[] | null => {
  const unwrapped = unwrapExpression(node);
  if (
    getNodeType(unwrapped) !== "ObjectExpression" ||
    typeof unwrapped !== "object" ||
    unwrapped === null ||
    !("properties" in unwrapped) ||
    !Array.isArray(unwrapped.properties)
  ) {
    return null;
  }
  return unwrapped.properties.map((value: unknown) => value);
};

const getPropertyKey = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null || !("key" in node)) {
    return null;
  }
  return node.key;
};

const getIdentifierName = (node: unknown): string | null => {
  const unwrapped = unwrapExpression(node);
  if (
    typeof unwrapped !== "object" ||
    unwrapped === null ||
    getNodeType(unwrapped) !== "Identifier" ||
    !("name" in unwrapped) ||
    typeof unwrapped.name !== "string"
  ) {
    return null;
  }
  return unwrapped.name;
};

const getNodeInit = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null || !("init" in node)) {
    return null;
  }
  return node.init;
};

const getNodeId = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null || !("id" in node)) {
    return null;
  }
  return node.id;
};

const getNodeLeft = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null || !("left" in node)) {
    return null;
  }
  return node.left;
};

const isFetchCallee = (callee: unknown): boolean => {
  if (isIdentifier(callee, "fetch")) {
    return true;
  }
  if (
    typeof callee !== "object" ||
    callee === null ||
    (callee as { type?: unknown }).type !== "MemberExpression"
  ) {
    return false;
  }
  const member = callee as {
    computed?: unknown;
    object?: unknown;
    property?: unknown;
  };
  if (member.computed !== false) {
    return false;
  }
  if (!isIdentifier(member.property, "fetch")) {
    return false;
  }
  return (
    isIdentifier(member.object, "globalThis") ||
    isIdentifier(member.object, "window") ||
    isIdentifier(member.object, "self") ||
    isIdentifier(member.object, "global")
  );
};

type RequestConstructorSignalState = "yes" | "no" | "opaque";

// `fetch(new Request(url, { signal }))` carries the signal on the
// Request object. Inspect object-literal init args when we can; keep
// non-literal init args opaque because a variable may carry `signal`.
const requestConstructorHasSignal = (
  node: unknown,
): RequestConstructorSignalState => {
  const unwrapped = unwrapExpression(node);
  if (getNodeType(unwrapped) !== "NewExpression") {
    return "no";
  }
  if (
    typeof unwrapped !== "object" ||
    unwrapped === null ||
    !("callee" in unwrapped) ||
    !isIdentifier(unwrapped.callee, "Request")
  ) {
    return "no";
  }
  const requestArguments = getNodeArguments(unwrapped);
  if (requestArguments === null) {
    return "no";
  }
  const init = requestArguments.at(1);
  if (init === undefined) {
    return "no";
  }
  if (getNodeType(init) !== "ObjectExpression") {
    return "opaque";
  }
  return optionsObjectHasSignal(init);
};

const isRequestTypeAnnotation = (node: unknown): boolean => {
  if (
    typeof node !== "object" ||
    node === null ||
    !("typeAnnotation" in node) ||
    typeof node.typeAnnotation !== "object" ||
    node.typeAnnotation === null ||
    !("typeAnnotation" in node.typeAnnotation)
  ) {
    return false;
  }
  const annotation = node.typeAnnotation.typeAnnotation;
  if (
    typeof annotation !== "object" ||
    annotation === null ||
    getNodeType(annotation) !== "TSTypeReference" ||
    !("typeName" in annotation)
  ) {
    return false;
  }
  return isIdentifier(annotation.typeName, "Request");
};

const optionsObjectHasSignal = (options: unknown): "yes" | "no" | "opaque" => {
  const properties = getObjectExpressionProperties(options);
  if (properties === null) {
    return "opaque";
  }
  for (const prop of properties) {
    const propType = getNodeType(prop);
    if (propType === "SpreadElement") {
      return "opaque";
    }
    if (propType !== "Property") {
      continue;
    }
    if (getPropertyName(getPropertyKey(prop)) === "signal") {
      return "yes";
    }
  }
  return "no";
};

export default {
  meta: { name: "require-fetch-timeout" },
  rules: {
    "require-fetch-timeout": {
      meta: {
        type: "problem",
        messages: {
          missingSignal:
            "fetch() must pass `signal` (e.g. " +
            "`{ signal: AbortSignal.timeout(10_000) }`) so upstream " +
            "hangs cannot stall the handler.",
        },
      },
      create(context) {
        const requestSignals = new Map<string, RequestConstructorSignalState>();
        const getFetchInputSignalState = (
          input: unknown,
        ): RequestConstructorSignalState => {
          const constructorSignal = requestConstructorHasSignal(input);
          if (constructorSignal !== "no") {
            return constructorSignal;
          }
          const identifierName = getIdentifierName(input);
          if (identifierName === null) {
            return "no";
          }
          return requestSignals.get(identifierName) ?? "no";
        };

        return {
          VariableDeclarator(node) {
            const id = getNodeId(node);
            const identifierName = getIdentifierName(id);
            if (identifierName === null) {
              return;
            }
            const initSignal = requestConstructorHasSignal(getNodeInit(node));
            if (initSignal !== "no") {
              requestSignals.set(identifierName, initSignal);
              return;
            }
            if (isRequestTypeAnnotation(id)) {
              requestSignals.set(identifierName, "opaque");
              return;
            }
            requestSignals.delete(identifierName);
          },
          AssignmentExpression(node) {
            const identifierName = getIdentifierName(getNodeLeft(node));
            if (identifierName !== null) {
              requestSignals.delete(identifierName);
            }
          },
          CallExpression(node) {
            if (!isFetchCallee(node.callee)) {
              return;
            }

            const [firstArg, options] = node.arguments;

            if (options === undefined) {
              if (getFetchInputSignalState(firstArg) !== "no") {
                return;
              }
              context.report({ node, messageId: "missingSignal" });
              return;
            }

            const unwrappedOptions = unwrapExpression(options);
            if (getNodeType(unwrappedOptions) !== "ObjectExpression") {
              return;
            }

            if (
              optionsObjectHasSignal(unwrappedOptions) === "no" &&
              getFetchInputSignalState(firstArg) === "no"
            ) {
              context.report({ node, messageId: "missingSignal" });
            }
          },
        };
      },
    },
  },
};
