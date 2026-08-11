// Require error capture wherever an error toast is raised from a catch.
//
// "All errors must be surfaced to the user (toast) or propagated to the
// caller. Capture errors before throwing." A `catch { stellaToast.error(...) }`
// meets the first half and structurally forecloses the second: with no bound
// parameter there is no error value left to hand to telemetry, so the failure
// exists only as a string the user reads and no one else ever sees. A bound
// parameter that is never captured is the same hole with a variable name.
//
// This rule keys on the three shapes that own a failure value: a `catch`
// clause, the callback of a promise `.catch(...)`, and the `isErr()` branch of
// a `better-result` Result. When the handler body raises an error-variant
// toast (`stellaToast.error(...)`, or `stellaToast.add`/`stellaToast.update`
// with `type: "error"`), the handler must pass the error to `captureError` —
// `analytics.captureError` from `useAnalytics()`, or
// `getAnalytics().captureError` outside React.
//
// Safe:
//   catch (error) {
//     analytics.captureError(error);
//     stellaToast.error(t("common.error"));
//   }
//   promise.catch((error: unknown) => {
//     getAnalytics().captureError(toAPIError(error));
//     stellaToast.error(message);
//   });
//   if (result.isErr()) {
//     analytics.captureError(result.error);
//     stellaToast.error(message);
//   }
//   catch { stellaToast.info(...) }        // not an error toast
//   catch (error) { logSomething(error); } // no toast raised
//
// Flagged:
//   catch { stellaToast.error(t("common.error")); }
//   catch (error) { stellaToast.error(getMessage(error)); }
//   promise.catch(() => { stellaToast.error(message); });
//   if (result.isErr()) { stellaToast.error(message); }
//
// Nested handlers own their own toasts: the walk stops at an inner `catch`
// clause, inner `.catch(...)` callback, or inner `isErr()` branch, so an
// outer handler is never reported for a toast it does not raise.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  getCalleeName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
  type AstNode,
} from "./utils.ts";

const TOAST_RECEIVER = "stellaToast";
const ERROR_TOAST_CALLEE = `${TOAST_RECEIVER}.error`;
const TYPED_TOAST_CALLEES = new Set([
  `${TOAST_RECEIVER}.add`,
  `${TOAST_RECEIVER}.update`,
]);
const CAPTURE_METHOD = "captureError";

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// `{ type: "error" }` anywhere in the argument list of a toast call that takes
// a type in its options (`add`, `update`).
const hasErrorTypeOption = (node: AstNode): boolean => {
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  for (const argument of args) {
    if (!isAstNode(argument) || argument.type !== "ObjectExpression") {
      continue;
    }
    const properties = Array.isArray(argument.properties)
      ? argument.properties
      : [];
    for (const property of properties) {
      if (!isAstNode(property) || property.type !== "Property") {
        continue;
      }
      if (
        getPropertyName(property.key) === "type" &&
        isStringLiteral(property.value) &&
        property.value.value === "error"
      ) {
        return true;
      }
    }
  }
  return false;
};

const isErrorToastCall = (node: AstNode): boolean => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const calleeName = getCalleeName(node.callee);
  if (calleeName === null) {
    return false;
  }
  if (calleeName === ERROR_TOAST_CALLEE) {
    return true;
  }
  return TYPED_TOAST_CALLEES.has(calleeName) && hasErrorTypeOption(node);
};

// `captureError(...)` on any receiver: `analytics.captureError`,
// `getAnalytics().captureError`, or a bare re-exported `captureError`.
const isCaptureCall = (node: AstNode): boolean => {
  if (node.type !== "CallExpression") {
    return false;
  }
  const calleeName = getCalleeName(node.callee);
  return calleeName !== null && calleeName.split(".").at(-1) === CAPTURE_METHOD;
};

// The callback argument of a promise `.catch(handler)`, or null when the node
// is not such a call (or hands `.catch` something other than a function).
const promiseCatchCallback = (node: unknown): AstNode | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const callee = isAstNode(node.callee) ? node.callee : null;
  if (
    callee === null ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false ||
    !isIdentifier(callee.property, "catch")
  ) {
    return null;
  }
  const [handler] = Array.isArray(node.arguments) ? node.arguments : [];
  if (!isAstNode(handler) || !FUNCTION_NODE_TYPES.has(handler.type)) {
    return null;
  }
  return handler;
};

// `result.isErr()` as an `if` test: the Result equivalent of a catch clause.
// Returns the Result binding's name, or null when the test is another shape.
const errResultBindingName = (node: unknown): string | null => {
  if (!isAstNode(node) || node.type !== "IfStatement") {
    return null;
  }
  const test = isAstNode(node.test) ? node.test : null;
  if (test === null || test.type !== "CallExpression") {
    return null;
  }
  const callee = isAstNode(test.callee) ? test.callee : null;
  if (
    callee === null ||
    callee.type !== "MemberExpression" ||
    callee.computed !== false ||
    !isIdentifier(callee.property, "isErr") ||
    !isIdentifier(callee.object)
  ) {
    return null;
  }
  return callee.object.name;
};

type HandlerFacts = {
  capturedNames: Set<string>;
  raisesErrorToast: boolean;
};

// Walk the handler body, recording whether it raises an error toast and which
// identifiers it hands to `captureError`. Nested handlers are skipped: their
// toasts and captures belong to them, not to the enclosing handler.
const collectHandlerFacts = (root: AstNode): HandlerFacts => {
  const facts: HandlerFacts = {
    capturedNames: new Set<string>(),
    raisesErrorToast: false,
  };
  const visited = new Set<unknown>();

  const collectReferencedNames = (value: unknown, into: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const element of value) {
        collectReferencedNames(element, into);
      }
      return;
    }
    if (!isAstNode(value)) {
      return;
    }
    if (isIdentifier(value)) {
      into.add(value.name);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent") {
        collectReferencedNames(child, into);
      }
    }
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) {
        visit(element);
      }
      return;
    }
    if (!isAstNode(value) || visited.has(value)) {
      return;
    }
    visited.add(value);

    if (value !== root && value.type === "CatchClause") {
      return;
    }

    if (value !== root && errResultBindingName(value) !== null) {
      return;
    }

    const nestedCallback = promiseCatchCallback(value);
    if (nestedCallback !== null && nestedCallback !== root) {
      // Keep walking the receiver chain, but leave the nested callback to its
      // own report.
      visit(value.callee);
      return;
    }

    if (isErrorToastCall(value)) {
      facts.raisesErrorToast = true;
    }
    if (isCaptureCall(value)) {
      collectReferencedNames(value.arguments, facts.capturedNames);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent") {
        visit(child);
      }
    }
  };

  visit(root);
  return facts;
};

const collectBoundNames = (pattern: unknown): Set<string> => {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) {
        visit(element);
      }
      return;
    }
    if (!isAstNode(value)) {
      return;
    }
    if (isIdentifier(value)) {
      names.add(value.name);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "parent") {
        visit(child);
      }
    }
  };
  visit(pattern);
  return names;
};

export default eslintCompatPlugin({
  meta: { name: "require-toast-error-capture" },
  rules: {
    "require-toast-error-capture": {
      meta: {
        type: "problem",
        messages: {
          missingErrorBinding:
            "This handler shows an error toast without binding the caught error, so the failure can never reach telemetry. Bind it (`catch (error)` / `.catch((error: unknown) => ...)`) and pass it to `captureError(error)` alongside the toast.",
          missingErrorCapture:
            "This handler shows an error toast but never passes the caught error to `captureError`. Call `analytics.captureError(error)` (from `useAnalytics()`) or `getAnalytics().captureError(error)` before the toast; the user-facing message stays as it is.",
          missingResultCapture:
            "This `isErr()` branch shows an error toast and drops the typed error. Pass `{{name}}.error` to `captureError` before the toast; the user-facing message stays as it is.",
        },
      },
      createOnce(context) {
        // Visitor arguments arrive as oxlint's typed nodes, which do not
        // satisfy the loose record shape the helpers in this folder walk, so
        // they are narrowed here rather than at every call site.
        const check = (
          handlerNode: unknown,
          param: unknown,
          bodyRoot: unknown,
        ): void => {
          if (!isAstNode(handlerNode) || !isAstNode(bodyRoot)) {
            return;
          }
          const facts = collectHandlerFacts(bodyRoot);
          if (!facts.raisesErrorToast) {
            return;
          }

          if (!isAstNode(param)) {
            context.report({
              node: handlerNode,
              messageId: "missingErrorBinding",
            });
            return;
          }

          const boundNames = collectBoundNames(param);
          const captured = [...boundNames].some((name) =>
            facts.capturedNames.has(name),
          );
          if (!captured) {
            context.report({
              node: handlerNode,
              messageId: "missingErrorCapture",
            });
          }
        };

        return {
          CatchClause(node) {
            check(node, node.param, node);
          },
          CallExpression(node) {
            const handler = promiseCatchCallback(node);
            if (handler === null) {
              return;
            }
            const [param] = Array.isArray(handler.params)
              ? handler.params
              : [null];
            check(handler, param, handler);
          },
          IfStatement(node) {
            const name = errResultBindingName(node);
            if (name === null || !isAstNode(node.consequent)) {
              return;
            }
            const facts = collectHandlerFacts(node.consequent);
            if (!facts.raisesErrorToast || facts.capturedNames.has(name)) {
              return;
            }
            context.report({
              node: node.consequent,
              messageId: "missingResultCapture",
              data: { name },
            });
          },
        };
      },
    },
  },
});
