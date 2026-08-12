// Returning a failure value from a transaction callback commits the
// transaction, so a business rejection found mid-transaction answers an error
// while persisting everything the callback has already written.
//
// A rejection must abort instead: `throw new HandlerError({ status, message })`
// inside the callback, recovered at the call site with `transactionAbortError`
// (apps/api/src/db/safe-db.ts), which hands back the same error the handler
// would have built, so the response is unchanged.
//
// Scope: apps/api/src, non-test.
//
// Flags a `return` that satisfies all three of:
//   - its own enclosing function is the transaction callback,
//   - a write (`tx.insert` / `tx.update` / `tx.delete`, or an audit recorder)
//     appears earlier in that callback, so the return has something to commit,
//   - its argument is failure-shaped: an object literal with `ok: false` or
//     `success: false` (`false as const` included), `Result.err(...)` /
//     `err(...)`, or `new <Something>Error(...)`.
//
// A `return` inside a nested closure is not flagged: only the callback's own
// return value decides whether the transaction commits, so an unrelated inner
// function returning `{ ok: false }` is a different statement about a different
// call.
//
// Transaction callbacks are the function argument of:
//   - `safeDb(fn)` and its scoped variants: a callee identifier that is `tx`,
//     `db`, or camel-cased ending in `Tx` / `Db`, the receiver spelling
//     require-audit-on-mutation already recognizes,
//   - `<anything>.transaction(fn)`,
//   - `abortableTx(handle, fn)` and `withScopedTx(handle, fn)`, whose callback
//     is the second argument.
//
// Known limits, both deliberate, both to keep false positives out. A callback
// that reports failure through a bespoke string discriminator
// (`{ status: "conflict" }`) is not failure-shaped here. A callback whose only
// prior write happens inside a helper it handed `tx` to has no write the rule
// can see; recognizing every such helper as a write would flag the many
// rejections that follow a read-only lock helper.
//
// The commit-and-report exceptions are named in COMMIT_ON_FAILURE_OWNERS, one
// entry per file with the reason that file must commit.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getCalleeName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  unwrapExpression,
} from "./utils.ts";

// Session openers that hand back a durable handle: the row they write names the
// storage the caller has already provisioned, so a rejection has to commit that
// row and let the handler's post-transaction cleanup release the storage.
// Aborting would erase the only record of what to release.
const COMMIT_ON_FAILURE_OWNERS: Readonly<Record<string, string>> = {
  "apps/api/src/handlers/entities/open-folio-collab-session.ts":
    "the committed session row names the storage the caller releases after the transaction",
  "apps/api/src/handlers/entities/open-desktop-edit-session.ts":
    "the committed checkpoint row names the storage the caller releases after the transaction",
};

const FAILURE_FLAG_KEYS = new Set(["ok", "success"]);

// Openers that take the database handle first and the callback second.
const CALLBACK_AFTER_HANDLE = new Set(["abortableTx", "withScopedTx"]);

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

type Range = [number, number];

const asRange = (value: unknown): Range | null => {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const [start, end] = value;
  if (typeof start !== "number" || typeof end !== "number") {
    return null;
  }
  return [start, end];
};

const isFalseLiteral = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    expression !== null &&
    expression.type === "Literal" &&
    expression.value === false
  );
};

const isFailureObject = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "ObjectExpression") {
    return false;
  }
  if (!Array.isArray(node.properties)) {
    return false;
  }
  return node.properties.some((property) => {
    if (!isAstNode(property) || property.type !== "Property") {
      return false;
    }
    const key = getPropertyName(property.key);
    return (
      key !== null &&
      FAILURE_FLAG_KEYS.has(key) &&
      isFalseLiteral(property.value)
    );
  });
};

const calleeTail = (callee: unknown): string | null =>
  getCalleeName(callee)?.split(".").at(-1) ?? null;

const isFailureConstructor = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "NewExpression" &&
  (calleeTail(node.callee)?.endsWith("Error") ?? false);

const isResultErrCall = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "CallExpression" &&
  calleeTail(node.callee) === "err";

const isFailureValue = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  return (
    isFailureObject(expression) ||
    isFailureConstructor(expression) ||
    isResultErrCall(expression)
  );
};

// `safeDb`, `scopedSafeDb`, `innerTx`, `db`, `tx`: the receiver spellings
// require-audit-on-mutation already treats as transaction handles.
const isTransactionReceiver = (name: string): boolean =>
  name === "tx" || name === "db" || /[a-z](?:Tx|Db)$/u.test(name);

// The argument index holding the transaction callback, or null when the call
// opens no transaction.
const callbackArgumentIndex = (node: unknown): number | null => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (isIdentifier(callee)) {
    if (CALLBACK_AFTER_HANDLE.has(callee.name)) {
      return 1;
    }
    return isTransactionReceiver(callee.name) ? 0 : null;
  }
  if (
    callee !== null &&
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    getPropertyName(callee.property) === "transaction"
  ) {
    return 0;
  }
  return null;
};

const MUTATION_METHODS = new Set(["insert", "update", "delete"]);

// Same recorder spellings require-audit-on-mutation accepts: an audit row is a
// row, so a rejection after one still commits it.
const AUDIT_CALLEE_PATTERN =
  /^(?:record[A-Z][A-Za-z0-9]*?AuditEvents?|recordAuditEvent|auditedPresignDownload)$/u;

// A call that writes rows through the open transaction: `tx.insert`,
// `tx.update`, `tx.delete`, or an audit recorder (an audit row is a row, so a
// rejection after one still commits it). Reads through the handle
// (`tx.select`, `tx.query.*`, `tx.$count`) write nothing.
const isWriteCall = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (
    callee !== null &&
    callee.type === "MemberExpression" &&
    callee.computed === false &&
    isIdentifier(callee.object) &&
    isTransactionReceiver(callee.object.name)
  ) {
    const method = getPropertyName(callee.property);
    return method !== null && MUTATION_METHODS.has(method);
  }
  const tail = calleeTail(callee);
  return tail !== null && AUDIT_CALLEE_PATTERN.test(tail);
};

const transactionCallbackRange = (node: unknown): Range | null => {
  const index = callbackArgumentIndex(node);
  if (index === null || !isAstNode(node) || !Array.isArray(node.arguments)) {
    return null;
  }
  const callback = unwrapExpression(node.arguments.at(index));
  if (callback === null || !FUNCTION_TYPES.has(callback.type)) {
    return null;
  }
  return asRange(callback.range);
};

export default eslintCompatPlugin({
  meta: { name: "require-transaction-abort" },
  rules: {
    "require-transaction-abort": {
      meta: {
        type: "problem",
        messages: {
          returnedFailure:
            "Returning a failure value from a transaction callback commits " +
            "everything the callback has already written. Throw " +
            "`new HandlerError({ status, message })` to abort the " +
            "transaction instead, and recover it at the call site with " +
            "`transactionAbortError`.",
        },
      },
      createOnce(context) {
        // Callback ranges are collected as their opening call is visited, so a
        // function node is a transaction callback when its own range matches
        // one of them.
        const callbackRanges: Range[] = [];
        // One frame per transaction callback currently open, innermost last:
        // the function depth it was entered at, and whether a write has been
        // visited inside it yet. Nodes arrive in source order, so the flag is
        // exactly "a write precedes this point".
        const openCallbacks: { depth: number; hasWrite: boolean }[] = [];
        let functionDepth = 0;

        const enterFunction = (node: unknown) => {
          functionDepth += 1;
          const range = isAstNode(node) ? asRange(node.range) : null;
          if (range === null) {
            return;
          }
          const isCallback = callbackRanges.some(
            ([start, end]) => start === range[0] && end === range[1],
          );
          if (isCallback) {
            openCallbacks.push({ depth: functionDepth, hasWrite: false });
          }
        };

        const exitFunction = () => {
          const frame = openCallbacks.at(-1);
          if (frame?.depth === functionDepth) {
            openCallbacks.pop();
            // A nested transaction is a savepoint: its writes are released
            // into the enclosing transaction, so they commit when the outer
            // callback returns. Carrying the flag outward is what makes a
            // failure returned after a nested write reportable; dropping the
            // frame's state here would hide exactly that case.
            const enclosing = openCallbacks.at(-1);
            if (enclosing && frame.hasWrite) {
              enclosing.hasWrite = true;
            }
          }
          functionDepth -= 1;
        };

        return {
          before() {
            callbackRanges.length = 0;
            openCallbacks.length = 0;
            functionDepth = 0;
            const filename = filenameForContext(context);
            return !Object.keys(COMMIT_ON_FAILURE_OWNERS).some((owner) =>
              filename.endsWith(owner),
            );
          },
          CallExpression(node) {
            const range = transactionCallbackRange(node);
            if (range !== null) {
              callbackRanges.push(range);
            }
            const frame = openCallbacks.at(-1);
            if (frame && isWriteCall(node)) {
              frame.hasWrite = true;
            }
          },
          FunctionDeclaration(node) {
            enterFunction(node);
          },
          "FunctionDeclaration:exit"() {
            exitFunction();
          },
          FunctionExpression(node) {
            enterFunction(node);
          },
          "FunctionExpression:exit"() {
            exitFunction();
          },
          ArrowFunctionExpression(node) {
            enterFunction(node);
          },
          "ArrowFunctionExpression:exit"() {
            exitFunction();
          },
          ReturnStatement(node) {
            const frame = openCallbacks.at(-1);
            if (frame?.depth !== functionDepth || !frame.hasWrite) {
              return;
            }
            if (isFailureValue(node.argument)) {
              context.report({ node, messageId: "returnedFailure" });
            }
          },
        };
      },
    },
  },
});
