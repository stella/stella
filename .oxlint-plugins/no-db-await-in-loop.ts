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
//   - Safe handlers express the same operation as
//     `yield* Result.await(safeDb(...))`; delegated `YieldExpression` nodes
//     with that shape are treated as DB awaits too.
//   - "Inside a loop" is found by walking up `parent` links from the
//     await/yield node. The walk stops as soon as it reaches either:
//       1. A `for` / `for-of` / `for-in` / `while` / `do-while` node whose
//          `body` is (an ancestor of) the await -> flag.
//       2. A function boundary (function declaration/expression/arrow) ->
//          flag only if that function is the direct callback argument of a
//          `.map` / `.forEach` / `.flatMap` call which is itself an argument
//          to `Promise.all(...)` / `Promise.allSettled(...)` (the standard
//          "fan out" shape); otherwise stop without flagging. A DB await
//          inside any other nested function (a helper defined inside a loop
//          but invoked elsewhere, an unrelated callback) is out of scope —
//          flag the call site instead, if that call site is itself in a
//          loop or a fan-out (see below).
//
//   - A second, independent check runs on every `AwaitExpression` whose
//     argument does *not* match the rule above: is it `Promise.all(...)` /
//     `Promise.allSettled(...)` wrapping a single `.map()` / `.forEach()` /
//     `.flatMap()` call? If so, resolve that call's callback and look for a
//     DB-rooted call chain *inside* it, without requiring an explicit
//     `await` on it (a `Promise.all([...]).then` or bare-return callback
//     still issues one query per item):
//       - Inline callback (`items.map((item) => tx.insert(...))`): scan its
//         body for a DB-rooted call that is *not* already the direct
//         argument of an `await` — that shape is already caught by rule #1
//         above on the inner `AwaitExpression` itself, so it is excluded
//         here to avoid reporting the same fan-out twice.
//       - Named callback (`chunk.map(indexRow)`): resolve `indexRow` to its
//         local definition — the nearest enclosing lexical scope's
//         `const indexRow = ...` / `function indexRow(...)`, searched
//         outward up to module scope — and scan its body the same way,
//         *including* awaited calls (nothing else could have already
//         flagged them, since `indexRow` is never itself the direct
//         `.map()` argument node).
//     Either scan additionally follows *one* more hop through a bare
//     function-call callee found inside the resolved body (e.g. `indexRow`
//     calling a same-file `indexDecision` helper that performs the actual
//     DB call), so a thin per-row wrapper doesn't hide the query from the
//     rule. This is a bounded, same-file, lexical name lookup — not real
//     scope/binding or cross-module analysis — chosen because the oxlint
//     plugin API exposes only `parent` links and raw AST shape, not a
//     scope/binding graph. Once matched, the fan-out is flagged
//     unconditionally, mirroring the inline case: `Promise.all(x.map(...))`
//     is itself the "loop", regardless of whether it also sits inside an
//     outer `for`/`while`.
//
// Flags:
//   for (const item of items) { await tx.insert(t).values(item); }
//   while (i < n) { await safeDb((tx) => tx.insert(t).values(x)); }
//   await Promise.all(items.map(async (item) => { await tx.select()...; }));
//   await Promise.allSettled(items.map(async (item) => { await tx...; }));
//   await Promise.all(items.map((item) => tx.insert(t).values(item))); // no await in the callback
//   const indexRow = async (row) => { await tx.insert(t).values(row); };
//   await Promise.all(chunk.map(indexRow));                             // named callback
//
// Allows:
//   await db.select().from(t).where(inArray(t.id, ids)); // batched, no loop
//   for (const x of items) { doInMemoryWork(x); }         // no DB await
//   items.map((item) => item.id);                          // no DB call at all
//   for (...) { const f = async () => { await tx...; }; }  // defined, not
//     // called per-iteration in a shape this rule tracks; flag the call site
//   Named-callback and call-hop resolution is same-file and lexical only: it
//   does not follow reassignment, destructuring, class methods, imports, or
//   more than one function-call hop past the `.map()` / `.forEach()` /
//   `.flatMap()` callback itself. A DB call reached through a longer helper
//   chain, or defined in another module, is not detected. The resolved
//   body's inline nested closures (e.g. a callback passed to `scopedDb(...)`
//   inside the resolved function) are scanned too, which can over-approximate
//   for a closure that is merely defined but never actually invoked per
//   iteration — accepted, since a missed N+1 is costlier than an occasional
//   over-flag with a documented escape hatch.
//
// Escape hatch (genuinely bounded, e.g. a loop over a small compile-time
// constant list):
//   // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop
//   // SAFETY: <reason the loop cannot scale with tenant/input data>

import { getPropertyName, isIdentifier, unwrapExpression } from "./utils.ts";

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

const MAP_LIKE_METHOD_NAMES = new Set(["map", "forEach", "flatMap"]);

const PROMISE_FAN_OUT_METHOD_NAMES = new Set(["all", "allSettled"]);

const AWAIT_UNWRAP_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "ChainExpression",
]);

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

const isFunctionNode = (node: unknown): boolean => {
  const type = getType(node);
  return type !== null && FUNCTION_TYPES.has(type);
};

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

const getResultAwaitArgument = (node: unknown): unknown => {
  if (getType(node) !== "CallExpression") {
    return null;
  }
  const callee = getField(node, "callee");
  if (
    getType(callee) !== "MemberExpression" ||
    isComputed(callee) ||
    !isIdentifier(getField(callee, "object"), "Result") ||
    getPropertyName(getField(callee, "property")) !== "await"
  ) {
    return null;
  }
  const args = getField(node, "arguments");
  return Array.isArray(args) && args.length === 1
    ? unwrapExpression(args[0])
    : null;
};

// `<expr>.map(...)` / `.forEach(...)` / `.flatMap(...)`.
const isMapLikeCall = (node: unknown): boolean => {
  if (getType(node) !== "CallExpression") {
    return false;
  }
  const callee = getField(node, "callee");
  if (getType(callee) !== "MemberExpression" || isComputed(callee)) {
    return false;
  }
  const methodName = getPropertyName(getField(callee, "property"));
  return methodName !== null && MAP_LIKE_METHOD_NAMES.has(methodName);
};

// `Promise.all(...)` / `Promise.allSettled(...)`.
const isPromiseAllLikeCall = (node: unknown): boolean => {
  if (getType(node) !== "CallExpression") {
    return false;
  }
  const callee = getField(node, "callee");
  if (getType(callee) !== "MemberExpression" || isComputed(callee)) {
    return false;
  }
  if (!isIdentifier(getField(callee, "object"), "Promise")) {
    return false;
  }
  const methodName = getPropertyName(getField(callee, "property"));
  return methodName !== null && PROMISE_FAN_OUT_METHOD_NAMES.has(methodName);
};

// Is `fnNode` (a function boundary) the callback argument of a
// `.map` / `.forEach` / `.flatMap` call that is itself an argument to
// `Promise.all(...)` / `Promise.allSettled(...)`?
const isPromiseAllMapCallback = (fnNode: unknown): boolean => {
  const mapCall = getField(fnNode, "parent");
  if (!isMapLikeCall(mapCall)) {
    return false;
  }
  const mapArgs = getField(mapCall, "arguments");
  if (!Array.isArray(mapArgs) || !mapArgs.includes(fnNode)) {
    return false;
  }

  const promiseAllCall = getField(mapCall, "parent");
  if (!isPromiseAllLikeCall(promiseAllCall)) {
    return false;
  }
  const promiseAllArgs = getField(promiseAllCall, "arguments");
  return Array.isArray(promiseAllArgs) && promiseAllArgs.includes(mapCall);
};

// Is `node` the outermost call/member of its chain (i.e. not the `object`
// of a further `.foo` access)? Used to avoid matching an inner link of a
// chain (`tx.select().from(t)`) in addition to its outer link
// (`tx.select().from(t).where(c)`) when both resolve to the same DB root.
const isChainRoot = (node: unknown): boolean => {
  const parent = getField(node, "parent");
  return !(
    getType(parent) === "MemberExpression" &&
    !isComputed(parent) &&
    getField(parent, "object") === node
  );
};

// Is `node` (after peeling TS-only wrappers) the direct argument of an
// `AwaitExpression`?
const isAwaitArgument = (node: unknown): boolean => {
  let current = node;
  let parent = getField(current, "parent");
  while (
    parent !== null &&
    AWAIT_UNWRAP_TYPES.has(getType(parent) ?? "") &&
    getField(parent, "expression") === current
  ) {
    current = parent;
    parent = getField(current, "parent");
  }
  return (
    getType(parent) === "AwaitExpression" &&
    getField(parent, "argument") === current
  );
};

const matchLocalDeclaration = (stmt: unknown, name: string): unknown => {
  const stmtType = getType(stmt);
  if (stmtType === "ExportNamedDeclaration") {
    return matchLocalDeclaration(getField(stmt, "declaration"), name);
  }
  if (stmtType === "FunctionDeclaration") {
    return isIdentifier(getField(stmt, "id"), name) ? stmt : null;
  }
  if (stmtType === "VariableDeclaration") {
    const declarations = getField(stmt, "declarations");
    if (!Array.isArray(declarations)) {
      return null;
    }
    for (const declarator of declarations) {
      const id = getField(declarator, "id");
      const init = getField(declarator, "init");
      if (isIdentifier(id, name) && isFunctionNode(init)) {
        return init;
      }
    }
  }
  return null;
};

// Resolve `name` to a same-file `const name = <function>` / `function
// name(...) {}`, searching outward from `fromNode`'s nearest enclosing
// block scope up to module scope. This is a lexical, same-file lookup, not
// real scope/binding resolution -- see the "Allows" note in the header for
// the residual limit (no reassignment, destructuring, class methods, or
// cross-module resolution).
const resolveLocalFunctionByName = (
  fromNode: unknown,
  name: string,
): unknown => {
  let scope = getField(fromNode, "parent");
  while (scope !== null && scope !== undefined) {
    const scopeType = getType(scope);
    if (scopeType === "BlockStatement" || scopeType === "Program") {
      const statements = getField(scope, "body");
      if (Array.isArray(statements)) {
        for (const stmt of statements) {
          const match = matchLocalDeclaration(stmt, name);
          if (match !== null) {
            return match;
          }
        }
      }
    }
    scope = getField(scope, "parent");
  }
  return null;
};

// Recursively scan `node` for a DB-rooted call chain. `canResolveFurther`
// allows exactly one more hop through a bare function-call callee that
// resolves to a same-file local definition (see `resolveLocalFunctionByName`
// above); the hop is spent immediately so nested calls found through it
// cannot chain into further hops. `viaResolution` marks that `node` was
// already reached through such a hop (or is a resolved named `.map()`
// callback's own body): once true, a DB-rooted call counts whether or not
// it is awaited, since no other check in this rule could have already
// flagged it. When false (still scanning an inline callback's own body),
// only a *bare* (non-awaited) DB-rooted call counts, so the existing
// `AwaitExpression`-walk-up path keeps sole ownership of directly awaited
// calls and the same fan-out isn't reported twice.
const containsDbRootedCall = (
  node: unknown,
  canResolveFurther: boolean,
  viaResolution: boolean,
): boolean => {
  if (Array.isArray(node)) {
    return node.some((child) =>
      containsDbRootedCall(child, canResolveFurther, viaResolution),
    );
  }
  if (typeof node !== "object" || node === null) {
    return false;
  }
  const type = getType(node);
  if (type === null) {
    return false;
  }

  if (type === "CallExpression") {
    if (isDbAwaitCall(node) && isChainRoot(node)) {
      if (viaResolution || !isAwaitArgument(node)) {
        return true;
      }
      // A direct `await dbCall()` at the unresolved level belongs to the
      // `AwaitExpression` visitor's own `isDbAwaitCall` check -- skip it
      // here rather than reporting the same fan-out twice.
    } else if (canResolveFurther) {
      const callee = getField(node, "callee");
      if (isIdentifier(callee)) {
        const resolved = resolveLocalFunctionByName(node, callee.name);
        if (
          resolved !== null &&
          containsDbRootedCall(getField(resolved, "body"), false, true)
        ) {
          return true;
        }
      }
    }
  }

  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (key === "parent") {
      continue;
    }
    if (
      containsDbRootedCall(
        (node as Record<string, unknown>)[key],
        canResolveFurther,
        viaResolution,
      )
    ) {
      return true;
    }
  }
  return false;
};

// Is `node` a `Promise.all(...)` / `Promise.allSettled(...)` call wrapping
// a single `.map()` / `.forEach()` / `.flatMap()` call whose callback
// (inline, or a same-file named function resolved by identifier) reaches a
// DB-rooted call chain?
const isPromiseAllMapFanOutWithDbCallback = (node: unknown): boolean => {
  if (!isPromiseAllLikeCall(node)) {
    return false;
  }
  const args = getField(node, "arguments");
  if (!Array.isArray(args) || args.length !== 1) {
    return false;
  }
  const mapCall = unwrapExpression(args[0]);
  if (!isMapLikeCall(mapCall)) {
    return false;
  }

  const mapArgs = getField(mapCall, "arguments");
  if (!Array.isArray(mapArgs) || mapArgs.length === 0) {
    return false;
  }
  const callback = unwrapExpression(mapArgs.at(-1));

  if (isFunctionNode(callback)) {
    return containsDbRootedCall(getField(callback, "body"), true, false);
  }

  if (isIdentifier(callback)) {
    const resolved = resolveLocalFunctionByName(mapCall, callback.name);
    if (resolved === null) {
      return false;
    }
    return containsDbRootedCall(getField(resolved, "body"), true, true);
  }

  return false;
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
        const reportAwaitedExpression = (
          node: unknown,
          argument: unknown,
        ): void => {
          if (isDbAwaitCall(argument)) {
            if (findLoopOrMapContext(node) !== null) {
              context.report({ node, messageId: "noDbAwaitInLoop" });
            }
            return;
          }
          if (isPromiseAllMapFanOutWithDbCallback(argument)) {
            context.report({ node, messageId: "noDbAwaitInLoop" });
          }
        };

        return {
          AwaitExpression(node: unknown) {
            const argument = unwrapExpression(getField(node, "argument"));
            reportAwaitedExpression(node, argument);
          },
          YieldExpression(node: unknown) {
            if (getField(node, "delegate") !== true) {
              return;
            }
            const resultAwaitArgument = getResultAwaitArgument(
              unwrapExpression(getField(node, "argument")),
            );
            if (resultAwaitArgument !== null) {
              reportAwaitedExpression(node, resultAwaitArgument);
            }
          },
        };
      },
    },
  },
};
