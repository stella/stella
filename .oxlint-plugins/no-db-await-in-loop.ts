// Ban an `await` of a DB call lexically inside a loop body (N+1 query
// antipattern).
//
// The per-route network baseline (apps/web/e2e/network-baseline.json) catches
// N+1 regressions only on routes the route-smoke e2e suite exercises. An
// `await db...` / `await tx...` / `await safeDb(...)` inside a loop scales
// the query count with the input size on every route, measured or not. The
// fix is batching: `inArray(...)`, a join, or a single aggregated query.
//
// Detection is intentionally simple and lexical:
//   - A DB await is an `AwaitExpression` whose argument is a call chain
//     rooted at the identifier `db` or `tx` (e.g. `db.insert(...).values(...)`,
//     `tx.query.foo.findMany()`, `db.transaction(async (tx) => ...)`), OR a
//     call whose callee resolves to `safeDb` — bare (`safeDb(cb)`, common in
//     `createSafeHandler` generators) or as a property access
//     (`ctx.safeDb(cb)`, `context.safeDb(cb)`).
//   - "Inside a loop" is found by walking up `parent` links from the
//     `AwaitExpression`. The walk stops as soon as it reaches either:
//       1. A `for` / `for-of` / `for-in` / `while` / `do-while` node whose
//          `body` is (an ancestor of) the await -> flag.
//       2. A function boundary (function declaration/expression/arrow) ->
//          flag only if that function is the direct callback argument of a
//          `.map` / `.forEach` / `.flatMap` call which is itself an argument
//          to `Promise.all(...)` (the standard "fan out with Promise.all"
//          shape); otherwise stop without flagging. A DB await inside any
//          other nested function (a helper defined inside a loop but invoked
//          elsewhere, an unrelated callback) is out of scope — flag the call
//          site instead, if that call site is itself in a loop.
//
// Flags:
//   for (const item of items) { await tx.insert(t).values(item); }
//   while (i < n) { await safeDb((tx) => tx.insert(t).values(x)); }
//   await Promise.all(items.map(async (item) => { await tx.select()...; }));
//
// Allows:
//   await db.select().from(t).where(inArray(t.id, ids)); // batched, no loop
//   for (const x of items) { doInMemoryWork(x); }         // no DB await
//   items.map((item) => item.id);                          // no await at all
//   for (...) { const f = async () => { await tx...; }; }  // defined, not
//     // called per-iteration in a shape this rule tracks; flag the call site
//
// Escape hatch (genuinely bounded, e.g. a loop over a small compile-time
// constant list):
//   // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop
//   // SAFETY: <reason the loop cannot scale with tenant/input data>

import { isIdentifier, unwrapExpression } from "./utils.ts";

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const DB_ROOT_NAMES = new Set(["db", "tx"]);

const getType = (node: unknown): string | null => {
  if (typeof node !== "object" || node === null || !("type" in node)) {
    return null;
  }
  const { type } = node as { type: unknown };
  return typeof type === "string" ? type : null;
};

const getField = (node: unknown, field: string): unknown => {
  if (typeof node !== "object" || node === null || !(field in node)) {
    return null;
  }
  return (node as Record<string, unknown>)[field];
};

const isComputed = (node: unknown): boolean =>
  getField(node, "computed") === true;

// Resolve the leftmost identifier of a member/call chain, descending
// through both `CallExpression.callee` and `MemberExpression.object` so
// `db.insert(t).values(v)` and `tx.query.foo.findMany()` both resolve to
// their root (`db` / `tx`), not the last method name.
const getChainRootName = (node: unknown): string | null => {
  const current = unwrapExpression(node);
  const type = getType(current);
  if (type === "CallExpression") {
    return getChainRootName(getField(current, "callee"));
  }
  if (type === "MemberExpression" && !isComputed(current)) {
    return getChainRootName(getField(current, "object"));
  }
  if (isIdentifier(current)) {
    return current.name;
  }
  return null;
};

// `safeDb(cb)` (bare, destructured from handler context) or `ctx.safeDb(cb)`
// / `context.safeDb(cb)` / `actor.safeDb(cb)` (property access on whatever
// the caller named the handler context).
const isSafeDbCallee = (callee: unknown): boolean => {
  if (isIdentifier(callee, "safeDb")) {
    return true;
  }
  return (
    getType(callee) === "MemberExpression" &&
    !isComputed(callee) &&
    isIdentifier(getField(callee, "property"), "safeDb")
  );
};

const isDbAwaitCall = (node: unknown): boolean => {
  if (getType(node) !== "CallExpression") {
    return false;
  }
  if (isSafeDbCallee(getField(node, "callee"))) {
    return true;
  }
  const root = getChainRootName(node);
  return root !== null && DB_ROOT_NAMES.has(root);
};

// Is `fnNode` (a function boundary) the callback argument of a
// `.map` / `.forEach` / `.flatMap` call that is itself an argument to
// `Promise.all(...)`?
const isPromiseAllMapCallback = (fnNode: unknown): boolean => {
  const mapCall = getField(fnNode, "parent");
  if (getType(mapCall) !== "CallExpression") {
    return false;
  }
  const mapCallee = getField(mapCall, "callee");
  if (getType(mapCallee) !== "MemberExpression" || isComputed(mapCallee)) {
    return false;
  }
  const methodName = getField(mapCallee, "property");
  if (
    !isIdentifier(methodName, "map") &&
    !isIdentifier(methodName, "forEach") &&
    !isIdentifier(methodName, "flatMap")
  ) {
    return false;
  }
  const mapArgs = getField(mapCall, "arguments");
  if (!Array.isArray(mapArgs) || !mapArgs.includes(fnNode)) {
    return false;
  }

  const promiseAllCall = getField(mapCall, "parent");
  if (getType(promiseAllCall) !== "CallExpression") {
    return false;
  }
  const promiseAllCallee = getField(promiseAllCall, "callee");
  if (
    getType(promiseAllCallee) !== "MemberExpression" ||
    isComputed(promiseAllCallee)
  ) {
    return false;
  }
  if (
    !isIdentifier(getField(promiseAllCallee, "object"), "Promise") ||
    !isIdentifier(getField(promiseAllCallee, "property"), "all")
  ) {
    return false;
  }
  const promiseAllArgs = getField(promiseAllCall, "arguments");
  return Array.isArray(promiseAllArgs) && promiseAllArgs.includes(mapCall);
};

// Walk up from an `AwaitExpression`, stopping at the first loop body or
// function boundary. Returns why the await is disallowed, or `null` when
// it is not lexically inside a flagged loop/fan-out shape.
const findLoopOrMapContext = (
  awaitNode: unknown,
): "loop" | "promise-all-map" | null => {
  let child = awaitNode;
  let current = getField(awaitNode, "parent");

  while (current !== null && current !== undefined) {
    const type = getType(current);

    if (type !== null && LOOP_TYPES.has(type)) {
      if (getField(current, "body") === child) {
        return "loop";
      }
      // Await sits in the loop's init/test/update, not its body — keep
      // climbing past this loop node as an ordinary ancestor.
    } else if (type !== null && FUNCTION_TYPES.has(type)) {
      return isPromiseAllMapCallback(current) ? "promise-all-map" : null;
    }

    child = current;
    current = getField(current, "parent");
  }

  return null;
};

export default {
  meta: { name: "no-db-await-in-loop" },
  rules: {
    "no-db-await-in-loop": {
      meta: {
        type: "problem",
        messages: {
          noDbAwaitInLoop:
            "Database call awaited inside a loop scales the query count " +
            "with the input size (N+1). Batch with `inArray(...)`, a join, " +
            "or a single aggregated query, or restructure to await once " +
            "outside the loop. If the loop is genuinely bounded (a small " +
            "compile-time constant list), disable with a `// SAFETY:` note " +
            "explaining the bound.",
        },
      },
      create(context) {
        return {
          AwaitExpression(node: unknown) {
            const argument = unwrapExpression(getField(node, "argument"));
            if (!isDbAwaitCall(argument)) {
              return;
            }
            if (findLoopOrMapContext(node) !== null) {
              context.report({ node, messageId: "noDbAwaitInLoop" });
            }
          },
        };
      },
    },
  },
};
