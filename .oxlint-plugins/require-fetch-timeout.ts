// Require an AbortSignal on every fetch() call so upstream hangs don't
// hang the request/worker indefinitely.
//
// CLAUDE.md mandates `fetch(url, { signal: AbortSignal.timeout(...) })`
// (or a propagated controller/upstream signal). Without a signal, a
// slow third-party endpoint stalls the entire handler — invisible in
// dev, paging on-call in prod.
//
// Under `apps/web/src` and `apps/api/src` (except each app's own
// `fetchWithTimeout` wrapper module and test files) the rule is
// stricter still: ANY direct `fetch()`/`globalThis.fetch()`/
// `window.fetch()` call is flagged, signal or not, because both apps
// have a wrapper — `fetchWithTimeout` from `@/lib/fetch` (web) or
// `@/api/lib/fetch` (api) — that makes the timeout mandatory and
// non-optional at the type level. Elsewhere (packages/*) the looser
// "must have a signal" check below still applies.
//
// Flags (packages/*):
//   fetch(url)                       // no options at all
//   fetch(url, {})                   // empty options
//   fetch(url, { method: "POST" })   // options without `signal`
//   globalThis.fetch(url, { ... })   // same, via global access
//   window.fetch(url, { ... })
//
// Allows (packages/*):
//   fetch(url, { signal: AbortSignal.timeout(10_000) })
//   fetch(url, { signal: controller.signal })
//   fetch(url, { signal: req.signal, method: "POST" })
//   fetch(url, opts)                 // opaque variable — can't inspect
//   fetch(url, { ...rest })          // spread may carry signal
//   fetch(request)                   // Request-typed variable may carry signal
//   fetch(request, { method: "POST" }) // Request's signal remains in effect
//
// Flags (apps/web/src, apps/api/src, unconditionally):
//   fetch(url, { signal: AbortSignal.timeout(10_000) }) // use fetchWithTimeout instead
//
// Allows (apps/web/src, apps/api/src):
//   fetchWithTimeout(url, { timeoutMs: 10_000 })
//   raw fetch() inside the app's own lib/fetch.ts wrapper module or in *.test.* files
//
// Escape hatch: `// eslint-disable-next-line require-fetch-timeout/require-fetch-timeout`
// with a `// SAFETY:` comment explaining why the call cannot hang
// (e.g. local file:/data: URL, object URL, in-process Bun.serve handler,
// or a call site that manages its own independent abort/timeout
// lifecycle that fetchWithTimeout's single-timeoutMs shape can't express).

import { getPropertyName, isIdentifier } from "./utils.ts";

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

// apps/web/src and apps/api/src each have a `fetchWithTimeout` wrapper
// that makes the timeout mandatory at the type level, so raw fetch() is
// disallowed there outright — except inside the wrapper module itself
// (which has to call the real fetch()) and test files (already exempted
// by the "**/*.test.{ts,tsx}" override in oxlint.config.ts; re-checked
// here too so this branch stays correct if that scoping ever changes).
const STRICT_FETCH_SCOPES = [
  {
    srcPattern: /(?:^|\/)apps\/web\/src\//u,
    wrapperSuffix: "apps/web/src/lib/fetch.ts",
  },
  {
    srcPattern: /(?:^|\/)apps\/api\/src\//u,
    wrapperSuffix: "apps/api/src/lib/fetch.ts",
  },
];

const normalizePath = (filename: string): string =>
  filename.replaceAll("\\", "/");

const filenameForContext = (context: {
  filename?: string;
  getFilename?: () => string;
}): string => context.filename ?? context.getFilename?.() ?? "";

const isStrictFetchWrapperFile = (context: {
  filename?: string;
  getFilename?: () => string;
}): boolean => {
  const normalized = normalizePath(filenameForContext(context));
  const scope = STRICT_FETCH_SCOPES.find((candidate) =>
    candidate.srcPattern.test(normalized),
  );
  if (!scope) {
    return false;
  }
  if (normalized.endsWith(scope.wrapperSuffix)) {
    return false;
  }
  return !TEST_FILE_PATTERN.test(normalized);
};

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

const getBindingIdentifierNames = (node: unknown): string[] => {
  const unwrapped = unwrapExpression(node);
  const nodeType = getNodeType(unwrapped);
  if (nodeType === "Identifier") {
    const name = getIdentifierName(unwrapped);
    return name === null ? [] : [name];
  }
  if (
    nodeType === "RestElement" &&
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "argument" in unwrapped
  ) {
    return getBindingIdentifierNames(unwrapped.argument);
  }
  if (
    nodeType === "AssignmentPattern" &&
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "left" in unwrapped
  ) {
    return getBindingIdentifierNames(unwrapped.left);
  }
  if (
    nodeType === "ArrayPattern" &&
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "elements" in unwrapped &&
    Array.isArray(unwrapped.elements)
  ) {
    return unwrapped.elements.flatMap((element: unknown) =>
      getBindingIdentifierNames(element),
    );
  }
  if (
    nodeType !== "ObjectPattern" ||
    typeof unwrapped !== "object" ||
    unwrapped === null ||
    !("properties" in unwrapped) ||
    !Array.isArray(unwrapped.properties)
  ) {
    return [];
  }
  const names: string[] = [];
  for (const property of unwrapped.properties) {
    const propertyType = getNodeType(property);
    if (
      propertyType === "RestElement" &&
      typeof property === "object" &&
      property !== null &&
      "argument" in property
    ) {
      names.push(...getBindingIdentifierNames(property.argument));
      continue;
    }
    if (
      propertyType === "Property" &&
      typeof property === "object" &&
      property !== null &&
      "value" in property
    ) {
      names.push(...getBindingIdentifierNames(property.value));
    }
  }
  return names;
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

const getNodeRight = (node: unknown): unknown => {
  if (typeof node !== "object" || node === null || !("right" in node)) {
    return null;
  }
  return node.right;
};

const getNodeParams = (node: unknown): unknown[] => {
  if (
    typeof node !== "object" ||
    node === null ||
    !("params" in node) ||
    !Array.isArray(node.params)
  ) {
    return [];
  }
  return node.params.map((value: unknown) => value);
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

const isRequestConstructorExpression = (node: unknown): boolean => {
  const unwrapped = unwrapExpression(node);
  return (
    getNodeType(unwrapped) === "NewExpression" &&
    typeof unwrapped === "object" &&
    unwrapped !== null &&
    "callee" in unwrapped &&
    isIdentifier(unwrapped.callee, "Request")
  );
};

// `fetch(new Request(url, { signal }))` carries the signal on the
// Request object. Inspect object-literal init args when we can; keep
// non-literal init args opaque because a variable may carry `signal`.
const requestConstructorSignalState = (
  node: unknown,
): RequestConstructorSignalState | null => {
  const unwrapped = unwrapExpression(node);
  if (!isRequestConstructorExpression(unwrapped)) {
    return null;
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
          useFetchWithTimeout:
            "apps/web/src and apps/api/src must not call fetch() " +
            "directly. Use `fetchWithTimeout(url, { timeoutMs, ...init })` " +
            "from `@/lib/fetch` (web) or `@/api/lib/fetch` (api) so the " +
            "timeout is mandatory, not opt-in.",
        },
      },
      create(context) {
        const strictFetchWrapperFile = isStrictFetchWrapperFile(context);

        type RequestSignalScope = Map<string, RequestConstructorSignalState>;

        const requestSignalScopes: RequestSignalScope[] = [];
        const pushRequestSignalScope = () => {
          requestSignalScopes.push(new Map());
        };
        const popRequestSignalScope = () => {
          requestSignalScopes.pop();
          if (requestSignalScopes.length === 0) {
            pushRequestSignalScope();
          }
        };
        const currentRequestSignalScope = (): RequestSignalScope => {
          const scope = requestSignalScopes.at(-1);
          if (scope) {
            return scope;
          }
          pushRequestSignalScope();
          return currentRequestSignalScope();
        };
        const getRequestSignalState = (
          name: string,
        ): RequestConstructorSignalState => {
          for (
            let index = requestSignalScopes.length - 1;
            index >= 0;
            index -= 1
          ) {
            const scope = requestSignalScopes.at(index);
            const state = scope?.get(name);
            if (state !== undefined) {
              return state;
            }
          }
          return "no";
        };
        const setRequestSignalState = (
          name: string,
          state: RequestConstructorSignalState,
        ) => {
          currentRequestSignalScope().set(name, state);
        };
        const assignRequestSignalState = (
          name: string,
          state: RequestConstructorSignalState,
        ) => {
          for (
            let index = requestSignalScopes.length - 1;
            index >= 0;
            index -= 1
          ) {
            const scope = requestSignalScopes.at(index);
            if (scope?.has(name)) {
              scope.set(name, state);
              return;
            }
          }
          setRequestSignalState(name, state);
        };
        const declareFunctionParameters = (node: unknown) => {
          for (const param of getNodeParams(node)) {
            for (const identifierName of getBindingIdentifierNames(param)) {
              setRequestSignalState(identifierName, "no");
            }
          }
        };
        const getFetchInputSignalState = (
          input: unknown,
        ): RequestConstructorSignalState => {
          const constructorSignal = requestConstructorSignalState(input);
          if (constructorSignal !== null) {
            return constructorSignal;
          }
          const identifierName = getIdentifierName(input);
          if (identifierName === null) {
            return "no";
          }
          return getRequestSignalState(identifierName);
        };

        return {
          Program() {
            requestSignalScopes.length = 0;
            pushRequestSignalScope();
          },
          "Program:exit"() {
            requestSignalScopes.length = 0;
          },
          BlockStatement() {
            pushRequestSignalScope();
          },
          "BlockStatement:exit"() {
            popRequestSignalScope();
          },
          FunctionDeclaration(node) {
            pushRequestSignalScope();
            declareFunctionParameters(node);
          },
          "FunctionDeclaration:exit"() {
            popRequestSignalScope();
          },
          FunctionExpression(node) {
            pushRequestSignalScope();
            declareFunctionParameters(node);
          },
          "FunctionExpression:exit"() {
            popRequestSignalScope();
          },
          ArrowFunctionExpression(node) {
            pushRequestSignalScope();
            declareFunctionParameters(node);
          },
          "ArrowFunctionExpression:exit"() {
            popRequestSignalScope();
          },
          CatchClause(node) {
            pushRequestSignalScope();
            const param =
              typeof node === "object" && node !== null && "param" in node
                ? node.param
                : null;
            for (const identifierName of getBindingIdentifierNames(param)) {
              setRequestSignalState(identifierName, "no");
            }
          },
          "CatchClause:exit"() {
            popRequestSignalScope();
          },
          VariableDeclarator(node) {
            const id = getNodeId(node);
            const identifierName = getIdentifierName(id);
            const bindingNames = getBindingIdentifierNames(id);
            if (bindingNames.length === 0) {
              return;
            }
            const initSignal = requestConstructorSignalState(getNodeInit(node));
            if (identifierName !== null && initSignal !== null) {
              setRequestSignalState(identifierName, initSignal);
              return;
            }
            if (identifierName !== null && isRequestTypeAnnotation(id)) {
              setRequestSignalState(identifierName, "opaque");
              return;
            }
            for (const bindingName of bindingNames) {
              setRequestSignalState(bindingName, "no");
            }
          },
          AssignmentExpression(node) {
            const left = getNodeLeft(node);
            const identifierName = getIdentifierName(left);
            if (identifierName === null) {
              for (const bindingName of getBindingIdentifierNames(left)) {
                assignRequestSignalState(bindingName, "no");
              }
              return;
            }
            const rightSignal = requestConstructorSignalState(
              getNodeRight(node),
            );
            if (rightSignal !== null) {
              assignRequestSignalState(identifierName, rightSignal);
              return;
            }
            const nextState =
              getRequestSignalState(identifierName) === "opaque"
                ? "opaque"
                : "no";
            assignRequestSignalState(identifierName, nextState);
          },
          CallExpression(node) {
            if (!isFetchCallee(node.callee)) {
              return;
            }

            if (strictFetchWrapperFile) {
              context.report({ node, messageId: "useFetchWithTimeout" });
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
