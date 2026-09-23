// Ban unclassified native errors as a failure value in production code.
//
// Use `panic()` from better-result for invariants and programmer errors, or a
// `TaggedError` subclass for runtime failures that callers should distinguish.
// A native error (`Error`, `TypeError`, `RangeError`, ...) skips structured
// error handling and produces unindexable string-only telemetry, whether it is
// thrown or wrapped in a `Result`.
//
// A native error is the global constructor, with or without `new`, directly or
// off `globalThis`; a local class that shadows the name is not. A failure value
// is the argument of `throw`, of `Result.err(...)`, or of `new Err(...)`, with
// `Result` and `Err` resolved through their better-result import.
//
// Flagged:
//   throw new Error("Something went wrong");
//   throw Error("no new keyword");
//   throw new globalThis.TypeError(`HTTP ${response.status}`);
//   return Result.err(new RangeError("out of range"));
//
// Allowed:
//   throw new FetchBoundaryError({ url, status, message });
//   return Result.err(new FetchBoundaryError({ url, status, message }));
//   panic("invariant violated");
//   throw err; // re-throw

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { ImportedFromOptions } from "./utils.ts";
import {
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isImportedFrom,
  memberPropertyName,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

type RuleContext = ImportedFromOptions["context"];

const NATIVE_ERRORS: ReadonlySet<string> = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);
const GLOBAL_OBJECT = "globalThis";
const BETTER_RESULT = "better-result";
const RESULT_NAMES: ReadonlySet<string> = new Set(["Result"]);
const ERR_NAMES: ReadonlySet<string> = new Set(["Err"]);
const RESULT_ERR = "err";

// An identifier that names the global binding rather than a local one. The
// global scope may list configured globals as variables without definitions.
const isGlobalName = (
  context: RuleContext,
  node: unknown,
  names: ReadonlySet<string>,
): boolean => {
  if (!isIdentifierReference(node) || !names.has(node.name)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  return variable === null || variable.defs.length === 0;
};

// `Error`, `globalThis.Error`, or `globalThis["Error"]` for any native error.
const isNativeErrorConstructor = (
  context: RuleContext,
  node: unknown,
): boolean => {
  const callee = unwrapExpression(node);
  if (callee === null) {
    return false;
  }
  if (isIdentifier(callee)) {
    return isGlobalName(context, callee, NATIVE_ERRORS);
  }
  if (callee.type !== "MemberExpression") {
    return false;
  }
  const property = memberPropertyName(callee);
  return (
    property !== null &&
    NATIVE_ERRORS.has(property) &&
    isGlobalName(
      context,
      unwrapExpression(callee.object),
      new Set([GLOBAL_OBJECT]),
    )
  );
};

const isNativeErrorValue = (context: RuleContext, node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    expression !== null &&
    (expression.type === "NewExpression" ||
      expression.type === "CallExpression") &&
    isNativeErrorConstructor(context, expression.callee)
  );
};

// `Result.err(...)` or `new Err(...)` from better-result.
const isErrWrapper = (context: RuleContext, node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (callee === null) {
    return false;
  }
  if (node.type === "NewExpression") {
    return isImportedFrom({
      context,
      node: callee,
      modules: [BETTER_RESULT],
      names: ERR_NAMES,
    });
  }
  return (
    node.type === "CallExpression" &&
    callee.type === "MemberExpression" &&
    memberPropertyName(callee) === RESULT_ERR &&
    isImportedFrom({
      context,
      node: callee.object,
      modules: [BETTER_RESULT],
      names: RESULT_NAMES,
    })
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-bare-error" },
  rules: {
    "no-bare-error": {
      meta: {
        type: "problem",
        messages: {
          noBareError:
            "Use panic() from better-result for invariants or a " +
            "TaggedError subclass for runtime failures. A native error " +
            "thrown or passed to Result.err skips structured error " +
            "handling.",
        },
      },
      createOnce(context) {
        const reportNativeError = (value: unknown): void => {
          if (!isNativeErrorValue(context, value)) {
            return;
          }
          const node = unwrapExpression(value);
          if (node !== null) {
            context.report({ node, messageId: "noBareError" });
          }
        };

        const reportWrapped = (node: unknown): void => {
          if (!isErrWrapper(context, node) || !isAstNode(node)) {
            return;
          }
          if (Array.isArray(node.arguments)) {
            reportNativeError(node.arguments.at(0));
          }
        };

        return {
          ThrowStatement(node: unknown) {
            if (isAstNode(node)) {
              reportNativeError(node.argument);
            }
          },
          CallExpression: reportWrapped,
          NewExpression: reportWrapped,
        };
      },
    },
  },
});
