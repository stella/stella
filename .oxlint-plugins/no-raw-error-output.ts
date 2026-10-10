import { eslintCompatPlugin, type Variable } from "@oxlint/plugins";

import {
  filenameForContext,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  isStringLiteral as isStringValueLiteral,
  resolveVariable,
  resolveImport,
  stableInitializer,
  unwrapExpression,
  type ImportedFromOptions,
  type AstNode,
} from "./utils.ts";

const ERRORS_PACKAGE = "@stll/errors";
const BETTER_AUTH_PACKAGE = "better-auth";
const API_ERROR_FORMATTERS = new Set([
  "connectionErrorFields",
  "errorFingerprint",
  "errorTag",
  "errorSystemFields",
  "serializeDevError",
  "safeErrorTelemetryFields",
  "unredactedErrorFields",
]);
const API_ERROR_TAG_FORMATTERS = new Set(["errorClassName", "errorTag"]);
const API_PG_FORMATTERS = new Set(["pgErrorFields"]);
const API_FAILURE_FORMATTERS = new Set([
  "errorFields",
  "failureFields",
  "identityFields",
  "pgIdentityFields",
  "shadowGradeFields",
  "systemFields",
]);
const SAFE_TRANSFORMS = new Set([
  "sanitizeErrorForOutput",
  "sanitizeErrorAttributesForOutput",
  "sanitizeQueryErrorText",
  "printError",
  "logErrorOutput",
]);
const SAFE_FORMATTER = "formatBetterAuthScriptFailure";
const ERROR_NAMES = new Set(["error", "err", "cause"]);
const OUTPUT_METHODS = new Set([
  "debug",
  "error",
  "info",
  "log",
  "request",
  "warn",
  "write",
]);
const CONSOLE_INSPECTION_METHODS = new Set([
  "assert",
  "clear",
  "count",
  "countReset",
  "dir",
  "dirxml",
  "group",
  "groupCollapsed",
  "table",
  "timeLog",
  "trace",
]);
type RuleContext = ImportedFromOptions["context"];

// Tracks caught errors and stable local aliases at console, logger, and process
// stream sinks. It does not model arbitrary helper calls or dynamic dispatch;
// use the shared output boundary for those paths.

const isGlobalIdentifier = (
  context: RuleContext,
  node: unknown,
  name: string,
): boolean =>
  isIdentifierReference(node) &&
  isIdentifier(node, name) &&
  (() => {
    const variable = resolveVariable(context, node);
    return variable === null || variable.defs.length === 0;
  })();

const isGlobalMemberAccess = (
  context: RuleContext,
  node: unknown,
  object: string,
  property: string,
): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  propertyName(node) === property &&
  isGlobalIdentifier(context, node.object, object);

const propertyName = (node: AstNode): string | null => {
  if (isIdentifier(node.property)) {
    return node.property.name;
  }
  if (
    node.computed &&
    isAstNode(node.property) &&
    node.property.type === "Literal"
  ) {
    return typeof node.property.value === "string" ? node.property.value : null;
  }
  return null;
};

const isStringLiteralExpression = (node: AstNode): boolean =>
  isStringValueLiteral(node) ||
  (node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0);

const isStringAnnotated = (variable: Variable): boolean => {
  const definition = variable.defs.at(0);
  if (!isAstNode(definition?.node)) {
    return false;
  }
  const binding =
    definition.node.type === "VariableDeclarator"
      ? definition.node.id
      : definition.name;
  if (!isAstNode(binding) || !isAstNode(binding.typeAnnotation)) {
    return false;
  }
  const annotation = binding.typeAnnotation.typeAnnotation;
  return isAstNode(annotation) && annotation.type === "TSStringKeyword";
};

const isSafeTransform = (context: RuleContext, node: AstNode): boolean => {
  if (node.type !== "CallExpression" || !isAstNode(node.callee)) {
    return false;
  }
  const callee = node.callee;
  return (
    isImportedFrom({
      context,
      node: callee,
      modules: [ERRORS_PACKAGE],
      names: SAFE_TRANSFORMS,
    }) ||
    isImportedFrom({
      context,
      node: callee,
      modules: [
        (moduleId) => moduleId.endsWith("apps/api/src/lib/errors/utils"),
      ],
      names: API_ERROR_FORMATTERS,
    }) ||
    isOwnedSafeProjection(
      context,
      callee,
      "apps/api/src/lib/errors/error-tag",
      API_ERROR_TAG_FORMATTERS,
    ) ||
    isOwnedSafeProjection(
      context,
      callee,
      "apps/api/src/lib/pg-error",
      API_PG_FORMATTERS,
    ) ||
    isOwnedSafeProjection(
      context,
      callee,
      "apps/api/src/lib/observability/failure",
      API_FAILURE_FORMATTERS,
    ) ||
    isImportedFrom({
      context,
      node: callee,
      modules: [
        (moduleId) =>
          moduleId.endsWith("apps/api/src/scripts/better-auth-script-failure"),
      ],
      names: new Set([SAFE_FORMATTER]),
    })
  );
};

const isOwnedSafeProjection = (
  context: RuleContext,
  node: AstNode,
  modulePath: string,
  names: Set<string>,
): boolean => {
  if (
    isImportedFrom({
      context,
      node,
      modules: [(moduleId) => moduleId.endsWith(modulePath)],
      names,
    })
  ) {
    return true;
  }
  if (
    filenameForContext(context).endsWith(`${modulePath}.ts`) &&
    isIdentifierReference(node) &&
    isIdentifier(node) &&
    names.has(node.name)
  ) {
    const variable = resolveVariable(context, node);
    return variable !== null && variable.defs.length > 0;
  }
  return false;
};

const isSafePrinter = (context: RuleContext, node: AstNode): boolean =>
  isImportedFrom({
    context,
    node,
    modules: [ERRORS_PACKAGE],
    names: new Set(["printError", "logErrorOutput"]),
  });

const hasSharedBetterAuthLogger = (
  context: RuleContext,
  node: AstNode,
): boolean => {
  if (!Array.isArray(node.arguments)) {
    return false;
  }
  const options = node.arguments.at(0);
  if (!isAstNode(options) || options.type !== "ObjectExpression") {
    return false;
  }
  if (!Array.isArray(options.properties)) {
    return false;
  }
  let effectiveLoggerIsSafe = false;
  for (const property of options.properties) {
    if (!isAstNode(property)) {
      continue;
    }
    if (property.type === "SpreadElement") {
      effectiveLoggerIsSafe = false;
      continue;
    }
    if (property.type !== "Property") {
      continue;
    }
    const key = property.computed
      ? isStringValueLiteral(property.key)
        ? property.key.value
        : null
      : getPropertyName(property.key);
    if (property.computed && key === null) {
      effectiveLoggerIsSafe = false;
      continue;
    }
    if (key === "logger") {
      effectiveLoggerIsSafe =
        isAstNode(property.value) &&
        isImportedFrom({
          context,
          node: property.value,
          modules: [ERRORS_PACKAGE],
          names: new Set(["errorOutputLogger"]),
        });
      continue;
    }
  }
  return effectiveLoggerIsSafe;
};

const isBetterAuthFactory = (context: RuleContext, node: AstNode): boolean =>
  isImportedFrom({
    context,
    node,
    modules: [BETTER_AUTH_PACKAGE],
    names: new Set(["betterAuth"]),
  });

const isBunWriteCallee = (
  context: RuleContext,
  node: AstNode,
  seen = new Set<object>(),
): boolean => {
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isGlobalMemberAccess(context, node, "Bun", "write")) {
    return true;
  }
  if (node.type !== "Identifier" || !isIdentifierReference(node)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  const initializer = variable === null ? null : stableInitializer(variable);
  return initializer !== null && isBunWriteCallee(context, initializer, seen);
};

const isOutputSink = (
  context: RuleContext,
  node: AstNode,
  seen = new Set<object>(),
): boolean => {
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (
    isIdentifier(node) &&
    new Set(["printError", "logErrorOutput"]).has(node.name)
  ) {
    return isImportedFrom({
      context,
      node,
      modules: [ERRORS_PACKAGE],
      names: new Set(["printError", "logErrorOutput"]),
    });
  }
  if (node.type === "Identifier" && isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    const initializer = variable === null ? null : stableInitializer(variable);
    return initializer !== null && isOutputSink(context, initializer, seen);
  }
  if (node.type !== "MemberExpression") {
    return false;
  }
  const key = propertyName(node);
  const object = node.object;
  if (key === null || !isAstNode(object)) {
    return false;
  }
  if (
    isGlobalIdentifier(context, object, "console") &&
    (OUTPUT_METHODS.has(key) || CONSOLE_INSPECTION_METHODS.has(key)) &&
    key !== "write"
  ) {
    return true;
  }
  if (
    isIdentifier(object, "logger") &&
    OUTPUT_METHODS.has(key) &&
    key !== "write"
  ) {
    return true;
  }
  if (
    isGlobalIdentifier(context, object, "process") &&
    (key === "stdout" || key === "stderr")
  ) {
    return false;
  }
  if (
    object.type === "MemberExpression" &&
    (isGlobalMemberAccess(context, object, "process", "stdout") ||
      isGlobalMemberAccess(context, object, "process", "stderr")) &&
    key === "write"
  ) {
    return true;
  }
  if (
    isGlobalMemberAccess(context, object, "Bun", "stdout") ||
    isGlobalMemberAccess(context, object, "Bun", "stderr")
  ) {
    return false;
  }
  return false;
};

type RawErrorOptions = {
  context: RuleContext;
  caughtVariables: WeakSet<Variable>;
  seen: Set<object>;
};

const isRawErrorIdentifier = (
  options: RawErrorOptions,
  node: AstNode,
): boolean => {
  if (node.type !== "Identifier" || !isIdentifierReference(node)) {
    return false;
  }
  const variable = resolveVariable(options.context, node);
  if (variable !== null && options.caughtVariables.has(variable)) {
    return true;
  }
  if (variable === null) {
    return ERROR_NAMES.has(node.name);
  }
  const initializer = stableInitializer(variable);
  if (initializer === null) {
    return !isStringAnnotated(variable) && ERROR_NAMES.has(node.name);
  }
  if (
    isStringLiteralExpression(initializer) ||
    isSafeTransform(options.context, initializer)
  ) {
    return false;
  }
  return isRawError(options, initializer);
};

const isRawErrorMember = (options: RawErrorOptions, node: AstNode): boolean => {
  if (node.type !== "MemberExpression") {
    return false;
  }
  if (propertyName(node) === "error") {
    return true;
  }
  return isAstNode(node.object) && isRawError(options, node.object);
};

const isRawErrorCall = (options: RawErrorOptions, node: AstNode): boolean => {
  if (node.type !== "NewExpression" && node.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee;
  const constructorName = isIdentifier(callee)
    ? (resolveImport(options.context, callee)?.imported ?? callee.name)
    : "";
  if (/Error\d*$/u.test(constructorName)) {
    return true;
  }
  if (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    isAstNode(callee.object) &&
    isRawError(options, callee.object)
  ) {
    return true;
  }
  return (
    Array.isArray(node.arguments) &&
    node.arguments.some(
      (argument) => isAstNode(argument) && isRawError(options, argument),
    )
  );
};

const isRawErrorCollection = (
  options: RawErrorOptions,
  node: AstNode,
): boolean => {
  if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
    return node.properties.some((property) => {
      if (!isAstNode(property)) {
        return false;
      }
      const value =
        property.type === "SpreadElement" ? property.argument : property.value;
      return isAstNode(value) && isRawError(options, value);
    });
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements.some(
      (element) => isAstNode(element) && isRawError(options, element),
    );
  }
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions)) {
    return node.expressions.some(
      (expression) => isAstNode(expression) && isRawError(options, expression),
    );
  }
  return false;
};

const isRawError = (options: RawErrorOptions, node: AstNode): boolean => {
  const expression = unwrapExpression(node);
  if (expression === null) {
    return false;
  }
  if (expression !== node) {
    return isRawError(options, expression);
  }
  const { context, seen } = options;
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  if (isSafeTransform(context, node)) {
    return false;
  }
  if (node.type === "Identifier") {
    return isRawErrorIdentifier(options, node);
  }
  if (node.type === "MemberExpression") {
    return isRawErrorMember(options, node);
  }
  if (node.type === "NewExpression" || node.type === "CallExpression") {
    return isRawErrorCall(options, node);
  }
  if (
    node.type === "ObjectExpression" ||
    node.type === "ArrayExpression" ||
    node.type === "TemplateLiteral"
  ) {
    return isRawErrorCollection(options, node);
  }
  if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
    return (
      (isAstNode(node.left) && isRawError(options, node.left)) ||
      (isAstNode(node.right) && isRawError(options, node.right))
    );
  }
  if (node.type === "ConditionalExpression") {
    return (
      (isAstNode(node.consequent) && isRawError(options, node.consequent)) ||
      (isAstNode(node.alternate) && isRawError(options, node.alternate))
    );
  }
  if (node.type === "ChainExpression" || node.type === "TSAsExpression") {
    return isAstNode(node.expression) && isRawError(options, node.expression);
  }
  return false;
};

export default eslintCompatPlugin({
  meta: { name: "no-raw-error-output" },
  rules: {
    "no-raw-error-output": {
      meta: {
        type: "problem",
        messages: {
          rawErrorOutput:
            "Do not print a raw error or its message. Use printError(error) from @stll/errors or runScriptWithErrorOutput(...) from @stll/errors/script-error.",
          missingBetterAuthLogger:
            "Configure betterAuth with errorOutputLogger from @stll/errors to keep SDK errors on the shared output boundary.",
        },
      },
      createOnce(context) {
        const caughtVariables = new WeakSet<Variable>();
        const markCaught = (parameter: unknown): void => {
          if (!isIdentifierReference(parameter)) {
            return;
          }
          const variable = resolveVariable(context, parameter);
          if (variable !== null) {
            caughtVariables.add(variable);
          }
        };
        return {
          CallExpression(node) {
            if (!isAstNode(node) || !isAstNode(node.callee)) {
              return;
            }
            if (
              isBetterAuthFactory(context, node.callee) &&
              !hasSharedBetterAuthLogger(context, node)
            ) {
              context.report({ node, messageId: "missingBetterAuthLogger" });
            }
            if (
              node.callee.type === "MemberExpression" &&
              propertyName(node.callee) === "catch"
            ) {
              const callback = node.arguments.at(0);
              if (
                isAstNode(callback) &&
                (callback.type === "ArrowFunctionExpression" ||
                  callback.type === "FunctionExpression") &&
                Array.isArray(callback.params)
              ) {
                markCaught(callback.params.at(0));
              }
            }
            if (isSafePrinter(context, node.callee)) {
              return;
            }
            const isBunWrite = isBunWriteCallee(context, node.callee);
            if (!isOutputSink(context, node.callee) && !isBunWrite) {
              return;
            }
            if (!Array.isArray(node.arguments)) {
              return;
            }
            const args = isBunWrite ? node.arguments.slice(1) : node.arguments;
            const target = isBunWrite ? node.arguments.at(0) : undefined;
            const writesProcessStream =
              isAstNode(target) &&
              (isGlobalMemberAccess(context, target, "Bun", "stdout") ||
                isGlobalMemberAccess(context, target, "Bun", "stderr"));
            if (isBunWrite && !writesProcessStream) {
              return;
            }
            const rawErrorOptions = {
              context,
              caughtVariables,
              seen: new Set<object>(),
            } satisfies RawErrorOptions;
            if (
              args.some(
                (argument) =>
                  isAstNode(argument) && isRawError(rawErrorOptions, argument),
              )
            ) {
              context.report({ node, messageId: "rawErrorOutput" });
            }
          },
          CatchClause(node) {
            markCaught(node.param);
          },
        };
      },
    },
  },
});
