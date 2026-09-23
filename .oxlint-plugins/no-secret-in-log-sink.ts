// Disallow secret-looking values inside log, telemetry and serialization sinks.
//
// The TypeScript ecosystem cannot prove a string isn't a secret. Stella handles
// privileged legal data; an accidental `logger.warn(`probe failed: ${apiKey}`)`,
// `JSON.stringify({ refreshToken })`, `span.setAttribute("auth", header)` or
// `Error(`bad key ${key}`)` drops the secret into logs, traces, Sentry or a
// response body.
//
// Strategy: name driven, with binding resolution where a name alone is weak.
// A value is secret-looking when its identifier, member property or object key
// names a credential (case-insensitive words: token, secret, password,
// passwd, api key, private key, signing key, authorization, cookie,
// credential, bearer, jwt), when it reads `process.env` / `Bun.env` under a
// name containing KEY, SECRET, TOKEN or PASSWORD, or when it is a stable local
// alias of such a value. Qualified names that describe a secret without
// holding it pass: `tokenCount`, `inputTokens`, `cookieName`, `hasApiKey`,
// `accessTokenExpiresAt`.
//
// Sinks: `JSON.stringify`; Error constructors with or without `new`
// (`new HandlerError(...)`, `TypeError(...)`); console methods, including
// destructured and computed ones; logger methods; Sentry
// (`captureException`, `captureMessage`, `setContext`, `setExtra(s)`,
// `setTag(s)`, `addBreadcrumb`); span attributes and events
// (`setAttribute(s)`, `addEvent`, `recordException`); analytics `capture`.
// The walk descends through call wrappers (`String(apiKey)`), skipping only
// masking helpers resolved to the module that owns them.
//
// Safe patterns:
//   createOpenRouter({ apiKey: key })          // SDK init, not a sink
//   logger.info("usage", { inputTokens })      // a count, not a credential
//   { apiKey: maskApiKey(raw) }                // masked by its owning module
//
// Flagged:
//   JSON.stringify({ apiKey })
//   logger.error(`refresh failed: ${session.refreshToken}`)
//   const { warn } = console; warn(process.env.STRIPE_SECRET_KEY)
//   Error(`bad key ${credentials.clientSecret}`)

import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  getPropertyName,
  invokedCallee,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isStringLiteral,
  memberPropertyName,
  patternKeyFor,
  resolveImport,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
  type AstNode,
} from "./utils.ts";

// Words that name a credential on their own.
const SECRET_WORDS: ReadonlySet<string> = new Set([
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "jwt",
  "passwd",
  "password",
  "passwords",
  "privatekey",
  "secret",
  "secrets",
]);

// `<qualifier> key` names key material: `apiKey`, `signing_key`.
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  "api",
  "encryption",
  "hmac",
  "master",
  "private",
  "signing",
]);

// Words before `token` that make it a unit of text, not a credential: a
// model token count or a parser token.
const TOKEN_COUNT_QUALIFIERS: ReadonlySet<string> = new Set([
  "cache",
  "cached",
  "completion",
  "estimated",
  "input",
  "max",
  "min",
  "num",
  "output",
  "per",
  "prompt",
  "reasoning",
  "remaining",
  "total",
  "unexpected",
  "unrecognized",
  "used",
]);

// Words before plural `tokens` that keep it a collection of credentials.
const CREDENTIAL_TOKEN_QUALIFIERS: ReadonlySet<string> = new Set([
  "access",
  "api",
  "auth",
  "bearer",
  "id",
  "refresh",
  "session",
]);

// A final word that describes a secret without holding it: `tokenCount`,
// `cookieName`, `secretArn`, `accessTokenExpiresAt`.
const DESCRIPTIVE_SUFFIXES: ReadonlySet<string> = new Set([
  "age",
  "arn",
  "at",
  "budget",
  "configured",
  "count",
  "counts",
  "domain",
  "enabled",
  "endpoint",
  "env",
  "estimate",
  "expiration",
  "expires",
  "expiry",
  "field",
  "fingerprint",
  "format",
  "hash",
  "id",
  "ids",
  "index",
  "kind",
  "label",
  "length",
  "limit",
  "limits",
  "metadata",
  "method",
  "methods",
  "mode",
  "name",
  "names",
  "path",
  "paths",
  "policy",
  "prefix",
  "present",
  "provider",
  "required",
  "schema",
  "schemas",
  "server",
  "source",
  "status",
  "ttl",
  "type",
  "types",
  "uri",
  "url",
  "usage",
  "version",
]);

// A first word that turns the name into a predicate: `hasApiKey`.
const PREDICATE_PREFIXES: ReadonlySet<string> = new Set([
  "can",
  "has",
  "is",
  "missing",
  "needs",
  "no",
  "requires",
  "should",
  "with",
  "without",
]);

const nameWords = (name: string): string[] =>
  name
    .replaceAll(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replaceAll(/([A-Z])(?=[A-Z][a-z])/gu, "$1 ")
    .split(/[\s_\-$]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

const isSecretName = (name: string): boolean => {
  const words = nameWords(name);
  if (words.length === 0) {
    return false;
  }
  if (
    words.length > 1 &&
    (DESCRIPTIVE_SUFFIXES.has(words.at(-1) ?? "") ||
      PREDICATE_PREFIXES.has(words[0] ?? ""))
  ) {
    return false;
  }
  return words.some((word, index) => {
    const previous = index > 0 ? (words[index - 1] ?? "") : "";
    if (SECRET_WORDS.has(word)) {
      return true;
    }
    if (word === "key" || word === "keys") {
      return KEY_QUALIFIERS.has(previous);
    }
    if (word === "token") {
      return !TOKEN_COUNT_QUALIFIERS.has(previous);
    }
    if (word === "tokens") {
      return CREDENTIAL_TOKEN_QUALIFIERS.has(previous);
    }
    return false;
  });
};

// Environment variables that hold key material by naming convention.
const SECRET_ENV_NAME = /KEY|SECRET|TOKEN|PASSWORD/iu;

// Masking helpers keyed by export name, each with the module that owns it.
// A call resolved to one of these renders its argument safe to serialize.
const MASKING_HELPERS: ReadonlyMap<string, string> = new Map([
  ["maskApiKey", "apps/api/src/lib/ai-config-crypto"],
  ["maskDeepLKey", "apps/api/src/lib/deepl/client"],
  ["maskWebSearchKey", "apps/api/src/lib/web-search/keys"],
]);

const CONSOLE_METHODS: ReadonlySet<string> = new Set([
  "debug",
  "dir",
  "error",
  "info",
  "log",
  "table",
  "trace",
  "warn",
]);

const LOGGER_METHODS: ReadonlySet<string> = new Set([
  "debug",
  "error",
  "fatal",
  "info",
  "log",
  "request",
  "trace",
  "warn",
]);

const LOGGER_NAME = /^(?:log|logger|\w+Logger)$/u;

// Telemetry methods that serialize their arguments whatever object they are
// called on: Sentry and its scopes, OpenTelemetry spans, analytics clients.
const TELEMETRY_METHODS: ReadonlySet<string> = new Set([
  "addBreadcrumb",
  "addEvent",
  "capture",
  "captureError",
  "captureEvent",
  "captureException",
  "captureMessage",
  "captureRequestError",
  "recordException",
  "setAttribute",
  "setAttributes",
  "setContext",
  "setExtra",
  "setExtras",
  "setTag",
  "setTags",
]);

// The same telemetry entry points imported or declared as bare functions.
const TELEMETRY_FUNCTIONS: ReadonlySet<string> = new Set([
  "addBreadcrumb",
  "captureError",
  "captureEvent",
  "captureException",
  "captureMessage",
  "captureRequestError",
  "setContext",
  "setExtra",
  "setExtras",
  "setTag",
  "setTags",
]);

// Properties whose value says nothing about the secret it is read from.
const OPAQUE_PROPERTIES: ReadonlySet<string> = new Set(["length", "size"]);

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
  "!=",
  "!==",
  "<",
  "<=",
  "==",
  "===",
  ">",
  ">=",
  "in",
  "instanceof",
]);

const ERROR_CONSTRUCTOR_NAME = /^(?:[A-Z]\w*)?Error$/u;

// Initializers whose value a local alias passes on unchanged or composed.
const ALIAS_INITIALIZER_TYPES: ReadonlySet<string> = new Set([
  "BinaryExpression",
  "CallExpression",
  "ConditionalExpression",
  "Identifier",
  "LogicalExpression",
  "MemberExpression",
  "TemplateLiteral",
]);

type SecretHit = { node: AstNode; name: string };

export default eslintCompatPlugin({
  meta: { name: "no-secret-in-log-sink" },
  rules: {
    "no-secret-in-log-sink": {
      meta: {
        type: "problem",
        messages: {
          secretInSink:
            "Do not pass '{{name}}' to {{sink}}. Logs, telemetry, Error messages and JSON.stringify output may carry the value into logs, traces, or response bodies. Strip the field, mask it (maskApiKey), or use a structural error tag.",
        },
      },
      createOnce(context) {
        // A global binding: unresolved, or a built-in the scope manager
        // declares without a definition.
        const isGlobal = (node: unknown, name: string): boolean => {
          const expression = unwrapExpression(node);
          if (!isIdentifierReference(expression) || expression.name !== name) {
            return false;
          }
          const variable = resolveVariable(context, expression);
          return variable === null || variable.defs.length === 0;
        };

        const isMaskingCall = (call: AstNode): boolean => {
          const resolved = resolveImport(context, invokedCallee(call));
          return (
            resolved !== null &&
            MASKING_HELPERS.get(resolved.imported) === resolved.moduleId
          );
        };

        // `process.env` or `Bun.env`.
        const isEnvironmentObject = (node: unknown): boolean => {
          const expression = unwrapExpression(node);
          return (
            expression?.type === "MemberExpression" &&
            memberPropertyName(expression) === "env" &&
            (isGlobal(expression.object, "process") ||
              isGlobal(expression.object, "Bun"))
          );
        };

        const findIdentifierSecret = (
          expression: AstNode,
          hits: SecretHit[],
          seen: Set<Variable>,
        ): void => {
          if (!isIdentifierReference(expression)) {
            return;
          }
          if (isSecretName(expression.name)) {
            hits.push({ node: expression, name: expression.name });
            return;
          }
          // A stable local alias carries the value it was given. A call
          // result is followed only as a method of a value
          // (`apiKey.trim()`): a request made with a secret returns a
          // response, not the secret.
          const variable = resolveVariable(context, expression);
          const initializer =
            variable === null || seen.has(variable)
              ? null
              : stableInitializer(variable);
          if (
            variable === null ||
            initializer === null ||
            !ALIAS_INITIALIZER_TYPES.has(initializer.type)
          ) {
            return;
          }
          const aliasedValue =
            initializer.type === "CallExpression"
              ? unwrapExpression(initializer.callee)
              : initializer;
          if (
            initializer.type === "CallExpression" &&
            aliasedValue?.type !== "MemberExpression"
          ) {
            return;
          }
          const aliased: SecretHit[] = [];
          findSecrets(aliasedValue, aliased, new Set([...seen, variable]));
          const first = aliased.at(0);
          if (first !== undefined) {
            hits.push({ node: expression, name: first.name });
          }
        };

        const findMemberSecret = (
          expression: AstNode,
          hits: SecretHit[],
          seen: Set<Variable>,
        ): void => {
          const property = memberPropertyName(expression);
          if (
            property !== null &&
            (isSecretName(property) ||
              (isEnvironmentObject(expression.object) &&
                SECRET_ENV_NAME.test(property)))
          ) {
            hits.push({ node: expression, name: property });
            return;
          }
          // A method of a secret still returns it (`apiKey.trim()`), so a
          // callee walks its receiver. A field read returns only that
          // field: `tokenResult.error` is the error, not the token.
          const parent = expression.parent;
          if (
            isAstNode(parent) &&
            parent.type === "CallExpression" &&
            unwrapExpression(parent.callee) === expression &&
            !(property !== null && OPAQUE_PROPERTIES.has(property))
          ) {
            findSecrets(expression.object, hits, seen);
          }
        };

        const findObjectSecrets = (
          expression: AstNode,
          hits: SecretHit[],
          seen: Set<Variable>,
        ): void => {
          if (!Array.isArray(expression.properties)) {
            return;
          }
          for (const property of expression.properties) {
            if (!isAstNode(property)) {
              continue;
            }
            if (property.type === "SpreadElement") {
              findSecrets(property.argument, hits, seen);
              continue;
            }
            if (property.computed === true && !isStringLiteral(property.key)) {
              findSecrets(property.key, hits, seen);
              findSecrets(property.value, hits, seen);
              continue;
            }
            const key = getPropertyName(property.key);
            const value = unwrapExpression(property.value);
            if (key !== null && isSecretName(key)) {
              if (!(value?.type === "CallExpression" && isMaskingCall(value))) {
                hits.push({ node: property, name: key });
              }
              continue;
            }
            findSecrets(property.value, hits, seen);
          }
        };

        // Every secret-looking value in `node`, in source order.
        const findSecrets = (
          node: unknown,
          hits: SecretHit[],
          seen: Set<Variable>,
        ): void => {
          const expression = unwrapExpression(node);
          if (!isAstNode(expression)) {
            return;
          }
          switch (expression.type) {
            case "Identifier":
              findIdentifierSecret(expression, hits, seen);
              return;
            case "MemberExpression":
              findMemberSecret(expression, hits, seen);
              return;
            case "ObjectExpression":
              findObjectSecrets(expression, hits, seen);
              return;
            case "TemplateLiteral":
              if (Array.isArray(expression.expressions)) {
                for (const part of expression.expressions) {
                  findSecrets(part, hits, seen);
                }
              }
              return;
            case "BinaryExpression":
              // A comparison yields a boolean, not the value.
              if (
                typeof expression.operator === "string" &&
                COMPARISON_OPERATORS.has(expression.operator)
              ) {
                return;
              }
              findSecrets(expression.left, hits, seen);
              findSecrets(expression.right, hits, seen);
              return;
            case "LogicalExpression":
              findSecrets(expression.left, hits, seen);
              findSecrets(expression.right, hits, seen);
              return;
            case "ConditionalExpression":
              findSecrets(expression.consequent, hits, seen);
              findSecrets(expression.alternate, hits, seen);
              return;
            case "AwaitExpression":
            case "SpreadElement":
              findSecrets(expression.argument, hits, seen);
              return;
            case "AssignmentExpression":
              findSecrets(expression.right, hits, seen);
              return;
            case "ArrayExpression":
              if (Array.isArray(expression.elements)) {
                for (const element of expression.elements) {
                  findSecrets(element, hits, seen);
                }
              }
              return;
            case "CallExpression":
            case "NewExpression": {
              // A call wrapping a secret still hands it to the sink
              // (`String(apiKey)`, `apiKey.trim()`), except a masking helper
              // or `Boolean(x)`, whose result does not carry the value.
              if (
                isMaskingCall(expression) ||
                isGlobal(expression.callee, "Boolean")
              ) {
                return;
              }
              const callee = unwrapExpression(expression.callee);
              if (callee?.type === "MemberExpression") {
                findSecrets(callee, hits, seen);
              }
              if (Array.isArray(expression.arguments)) {
                for (const argument of expression.arguments) {
                  findSecrets(argument, hits, seen);
                }
              }
              return;
            }
            default:
              return;
          }
        };

        // The console method a bare identifier is bound to:
        // `const { warn } = console`, `const log = console.log`.
        const consoleMethodOf = (identifier: AstNode): string | null => {
          if (!isIdentifierReference(identifier)) {
            return null;
          }
          const variable = resolveVariable(context, identifier);
          const definition = variable?.defs.at(0);
          const declarator = definition?.node;
          if (
            variable === null ||
            definition?.type !== "Variable" ||
            !isAstNode(declarator) ||
            declarator.type !== "VariableDeclarator"
          ) {
            return null;
          }
          if (
            isAstNode(declarator.id) &&
            declarator.id.type === "ObjectPattern" &&
            isGlobal(declarator.init, "console")
          ) {
            return patternKeyFor(declarator.id, definition.name);
          }
          const initializer = stableInitializer(variable);
          return initializer?.type === "MemberExpression" &&
            isGlobal(initializer.object, "console")
            ? memberPropertyName(initializer)
            : null;
        };

        const isLoggerReceiver = (node: unknown): boolean => {
          const receiver = unwrapExpression(node);
          if (isIdentifier(receiver) && LOGGER_NAME.test(receiver.name)) {
            return true;
          }
          const resolved = resolveImport(context, receiver);
          return resolved !== null && LOGGER_NAME.test(resolved.imported);
        };

        // The label of the sink a call writes to, or null when it is none.
        const sinkLabel = (call: AstNode): string | null => {
          const callee = invokedCallee(call);
          if (!isAstNode(callee)) {
            return null;
          }
          if (callee.type === "MemberExpression") {
            const method = memberPropertyName(callee);
            if (method === null) {
              return null;
            }
            if (method === "stringify" && isGlobal(callee.object, "JSON")) {
              return "JSON.stringify";
            }
            if (isGlobal(callee.object, "console")) {
              return CONSOLE_METHODS.has(method) ? `console.${method}` : null;
            }
            if (LOGGER_METHODS.has(method) && isLoggerReceiver(callee.object)) {
              return `logger.${method}`;
            }
            if (TELEMETRY_METHODS.has(method)) {
              return method;
            }
            return ERROR_CONSTRUCTOR_NAME.test(method)
              ? `${method} constructor`
              : null;
          }
          if (!isIdentifierReference(callee)) {
            return null;
          }
          if (ERROR_CONSTRUCTOR_NAME.test(callee.name)) {
            return `${callee.name} constructor`;
          }
          const consoleMethod = consoleMethodOf(callee);
          if (consoleMethod !== null && CONSOLE_METHODS.has(consoleMethod)) {
            return `console.${consoleMethod}`;
          }
          const imported = resolveImport(context, callee)?.imported;
          if (
            TELEMETRY_FUNCTIONS.has(callee.name) ||
            (imported !== undefined && TELEMETRY_FUNCTIONS.has(imported))
          ) {
            return callee.name;
          }
          return null;
        };

        const checkCall = (call: unknown): void => {
          if (!isAstNode(call)) {
            return;
          }
          const sink = sinkLabel(call);
          if (sink === null || !Array.isArray(call.arguments)) {
            return;
          }
          // `f.call(thisArg, ...)` shifts the arguments by one.
          const callee = unwrapExpression(call.callee);
          const invocation =
            callee?.type === "MemberExpression"
              ? memberPropertyName(callee)
              : null;
          const argumentsToCheck =
            invocation === "call" && invokedCallee(call) !== callee
              ? call.arguments.slice(1)
              : call.arguments;
          for (const argument of argumentsToCheck) {
            const hits: SecretHit[] = [];
            findSecrets(argument, hits, new Set());
            for (const hit of hits) {
              context.report({
                node: hit.node,
                messageId: "secretInSink",
                data: { name: hit.name, sink },
              });
            }
          }
        };

        return {
          CallExpression(node) {
            checkCall(node);
          },
          NewExpression(node) {
            checkCall(node);
          },
        };
      },
    },
  },
});
