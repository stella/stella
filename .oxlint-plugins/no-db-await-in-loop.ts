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
//     `tx.query.foo.findMany()`, `db.transaction(async (tx) => ...)`,
//     `rootDb.select()...`), OR a call whose callee resolves to a runner
//     handle (`safeDb`, `scopedDb`, `ingestionDb`, `backfillDb`) — bare
//     (`safeDb(cb)`, common in `createSafeHandler` generators; `scopedDb(cb)`
//     destructured from a handler context) or as a property access
//     (`ctx.safeDb(cb)`, `context.scopedDb(cb)`).
//   - A HANDLE await is an `AwaitExpression` whose argument is any other call
//     that receives a database handle (`db`, `tx`, `safeDb`, `scopedDb`,
//     `rootDb`, `ingestionDb`, `backfillDb`) as an argument: a bare identifier
//     (`upsertRow(tx, row)`), a member access landing on or rooted at one
//     (`upsertRow(ctx.tx, row)`), or an object-literal property carrying one
//     by key, shorthand, or value (`helper({ tx, id })`,
//     `helper({ database: tx })`), including through nested object literals.
//     The query lives behind the helper, so no chain is rooted at the handle
//     here — the handle in the argument list is the evidence. Function
//     arguments are deliberately not scanned: a handle used inside a callback
//     body runs wherever that callback runs, so
//     `for (const r of rows) enqueue(() => save(tx, r))` enqueues rather than
//     queries. The two shapes report distinct messages. Inside a
//     `Promise.all(...)` / `Promise.allSettled(...)` fan-out the handle shape
//     yields to the fan-out check below whenever that check already reports
//     the same call, so one fan-out never costs two reports.
//   - Safe handlers express the same operation as
//     `yield* Result.await(safeDb(...))`; delegated `YieldExpression` nodes
//     with that shape are treated as DB awaits too.
//   - "Inside a loop" is found by walking up `parent` links from the
//     await/yield node. The walk stops as soon as it reaches either:
//       1. A `for` / `for-of` / `for-in` / `while` / `do-while` node in a
//          position that re-runs every iteration — its `body`, a `while` /
//          `do` test, or a `for` test or update -> flag. The one-time
//          positions (a `for` initializer, a `for-of` / `for-in` right-hand
//          side) are not per-iteration work.
//       2. A function boundary (function declaration/expression/arrow) ->
//          flag only if that function is the direct callback argument of a
//          `.map` / `.forEach` / `.flatMap` call which is itself an argument
//          to `Promise.all(...)` / `Promise.allSettled(...)` (the standard
//          "fan out" shape); otherwise stop without flagging. A DB await
//          inside any other nested function (a helper defined inside a loop
//          but invoked elsewhere, an unrelated callback) is out of scope —
//          flag the call site instead, if that call site is itself in a
//          loop or a fan-out (see below). A `Result.tryPromise` callback is
//          not a boundary: it runs where it stands, so the walk continues
//          through it into the enclosing loop.
//
//   - A second, independent check runs on every `AwaitExpression` whose
//     argument does *not* match the rule above: is it `Promise.all(...)` /
//     `Promise.allSettled(...)` wrapping a single `.map()` / `.forEach()` /
//     `.flatMap()` call? If so, resolve that call's callback and look for a
//     database call *inside* it -- a DB-rooted chain, or a helper carrying a
//     handle -- without requiring an explicit `await` on it (a
//     `Promise.all([...]).then` or bare-return callback still issues one
//     query per item, and `items.map((item) => upsertRow(tx, item))` has no
//     inner await for the walk-up path to find at all). The fan-out reports
//     whichever of the two messages matched. A literal array argument
//     (`Promise.all([saveA(tx), saveB(tx)])`) is not matched: its length is
//     fixed at author time, which is the bounded case the escape hatch is
//     for.
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
//   await Promise.all(items.map((item) => upsertRow(tx, item)));        // handle behind a helper
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

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifier,
  isPerIterationLoopPosition,
  isResultTryPromiseCallback,
  LOOP_NODE_TYPES,
  resolveChainRootName,
  unwrapExpression,
} from "./utils.ts";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

// Every identifier the codebase uses for a database handle, keyed by how a
// query reaches it. A chain root is written on directly (`db.select()...`,
// `tx.query...`, `rootDb.transaction(...)`); a runner takes a callback and
// never roots a chain (`scopedDb((tx) => ...)`), so it is matched as a callee
// and as an argument instead. One map, so a handle cannot be listed without
// a kind, and the three name sets below cannot drift apart.
const DB_HANDLE_KIND = {
  db: "chain-root",
  tx: "chain-root",
  rootDb: "chain-root",
  safeDb: "runner",
  scopedDb: "runner",
  ingestionDb: "runner",
  backfillDb: "runner",
} as const;

type DbHandleKind = (typeof DB_HANDLE_KIND)[keyof typeof DB_HANDLE_KIND];

const DB_HANDLE_NAME_SET: ReadonlySet<string> = new Set(
  Object.keys(DB_HANDLE_KIND),
);

const dbHandleNamesOfKind = (kind: DbHandleKind): ReadonlySet<string> =>
  new Set(
    Object.entries(DB_HANDLE_KIND)
      .filter(([, handleKind]) => handleKind === kind)
      .map(([name]) => name),
  );

const DB_CHAIN_ROOT_NAME_SET = dbHandleNamesOfKind("chain-root");

const DB_RUNNER_NAME_SET = dbHandleNamesOfKind("runner");

const MAP_LIKE_METHOD_NAMES = new Set(["map", "forEach", "flatMap"]);

const PROMISE_FAN_OUT_METHOD_NAMES = new Set(["all", "allSettled"]);

const AWAIT_UNWRAP_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "ChainExpression",
]);

const getType = (node: unknown): string | null =>
  isAstNode(node) ? node.type : null;

const getField = (node: unknown, field: string): unknown => {
  if (typeof node !== "object" || node === null || !(field in node)) {
    return null;
  }
  return Reflect.get(node, field);
};

const isComputed = (node: unknown): boolean =>
  getField(node, "computed") === true;

const isFunctionNode = (node: unknown): boolean => {
  const type = getType(node);
  return type !== null && FUNCTION_TYPES.has(type);
};

// A runner handle invoked with its callback: `safeDb(cb)` / `scopedDb(cb)`
// (bare, destructured from a handler or job context) or `ctx.safeDb(cb)` /
// `context.scopedDb(cb)` / `actor.safeDb(cb)` (property access on whatever
// the caller named the context). The callback runs one transaction per
// invocation, so the invocation is the query.
const isDbRunnerCallee = (callee: unknown): boolean => {
  if (isIdentifier(callee) && DB_RUNNER_NAME_SET.has(callee.name)) {
    return true;
  }
  if (getType(callee) !== "MemberExpression" || isComputed(callee)) {
    return false;
  }
  const property = getField(callee, "property");
  return isIdentifier(property) && DB_RUNNER_NAME_SET.has(property.name);
};

const isDbAwaitCall = (node: unknown): boolean => {
  if (getType(node) !== "CallExpression") {
    return false;
  }
  if (isDbRunnerCallee(getField(node, "callee"))) {
    return true;
  }
  const root = resolveChainRootName(node);
  return root !== null && DB_CHAIN_ROOT_NAME_SET.has(root);
};

// The database handle an argument carries, or null. Identifiers, member
// accesses, and object literals are followed; functions are not (see the
// header for why a handle inside a callback body is the call site's question,
// not this one's).
const findDbHandleInValue = (node: unknown): string | null => {
  const value = unwrapExpression(node);
  if (value === null) {
    return null;
  }
  if (isIdentifier(value)) {
    return DB_HANDLE_NAME_SET.has(value.name) ? value.name : null;
  }
  if (value.type === "MemberExpression") {
    const propertyName = getPropertyName(getField(value, "property"));
    if (propertyName !== null && DB_HANDLE_NAME_SET.has(propertyName)) {
      return propertyName;
    }
    return findDbHandleInValue(getField(value, "object"));
  }
  if (value.type !== "ObjectExpression") {
    return null;
  }
  const properties = getField(value, "properties");
  if (!Array.isArray(properties)) {
    return null;
  }
  for (const property of properties) {
    if (getType(property) !== "Property") {
      continue;
    }
    const keyName = isComputed(property)
      ? null
      : getPropertyName(getField(property, "key"));
    if (keyName !== null && DB_HANDLE_NAME_SET.has(keyName)) {
      return keyName;
    }
    const fromValue = findDbHandleInValue(getField(property, "value"));
    if (fromValue !== null) {
      return fromValue;
    }
  }
  return null;
};

// The database handle a call receives, or null when it receives none.
const findDbHandleArgument = (node: unknown): string | null => {
  if (getType(node) !== "CallExpression") {
    return null;
  }
  const args = getField(node, "arguments");
  if (!Array.isArray(args)) {
    return null;
  }
  for (const argument of args) {
    const handle = findDbHandleInValue(argument);
    if (handle !== null) {
      return handle;
    }
  }
  return null;
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

// Which shape a database call inside a fan-out callback matched. A boolean
// would lose the handle name the handle message reports, and the two shapes
// are exactly the two messages this rule emits.
type DatabaseCallMatch =
  | { readonly kind: "chain" }
  | { readonly kind: "handle"; readonly handle: string };

const CHAIN_MATCH: DatabaseCallMatch = { kind: "chain" };

// Recursively scan `node` for a database call: a DB-rooted call chain, or a
// call carrying a database handle in its arguments. `canResolveFurther`
// allows exactly one more hop through a bare function-call callee that
// resolves to a same-file local definition (see `resolveLocalFunctionByName`
// above); the hop is spent immediately so nested calls found through it
// cannot chain into further hops. `viaResolution` marks that `node` was
// already reached through such a hop (or is a resolved named `.map()`
// callback's own body): once true, a database call counts whether or not
// it is awaited, since no other check in this rule could have already
// flagged it. When false (still scanning an inline callback's own body),
// only a *bare* (non-awaited) call counts, so the existing
// `AwaitExpression`-walk-up path keeps sole ownership of directly awaited
// calls and the same fan-out isn't reported twice. `items.map((item) =>
// upsertRow(tx, item))` has no inner await at all, so the fan-out scan is
// the only thing that can see it.
const findDatabaseCall = (
  node: unknown,
  canResolveFurther: boolean,
  viaResolution: boolean,
): DatabaseCallMatch | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findDatabaseCall(child, canResolveFurther, viaResolution);
      if (match !== null) {
        return match;
      }
    }
    return null;
  }
  if (typeof node !== "object" || node === null) {
    return null;
  }
  const type = getType(node);
  if (type === null) {
    return null;
  }

  if (type === "CallExpression" && isChainRoot(node)) {
    const isChainCall = isDbAwaitCall(node);
    const handle = isChainCall ? null : findDbHandleArgument(node);
    // A direct `await dbCall()` / `await helper(tx, row)` at the unresolved
    // level belongs to the `AwaitExpression` visitor -- skipping it here is
    // what keeps one fan-out from being reported twice.
    if (
      (isChainCall || handle !== null) &&
      (viaResolution || !isAwaitArgument(node))
    ) {
      return handle === null ? CHAIN_MATCH : { kind: "handle", handle };
    }
  }
  if (type === "CallExpression" && canResolveFurther) {
    const callee = getField(node, "callee");
    if (isIdentifier(callee)) {
      const resolved = resolveLocalFunctionByName(node, callee.name);
      const match =
        resolved === null
          ? null
          : findDatabaseCall(getField(resolved, "body"), false, true);
      if (match !== null) {
        return match;
      }
    }
  }

  for (const key of Object.keys(node)) {
    if (key === "parent") {
      continue;
    }
    const match = findDatabaseCall(
      Reflect.get(node, key),
      canResolveFurther,
      viaResolution,
    );
    if (match !== null) {
      return match;
    }
  }
  return null;
};

// Is `node` a `Promise.all(...)` / `Promise.allSettled(...)` call wrapping
// a single `.map()` / `.forEach()` / `.flatMap()` call whose callback
// (inline, or a same-file named function resolved by identifier) reaches a
// database call -- a DB-rooted chain, or a helper carrying a handle? Returns
// the shape that matched, so the fan-out reports the same message the loop
// path would.
//
// A literal array (`Promise.all([saveA(tx), saveB(tx)])`) is deliberately not
// matched: its length is fixed at author time, which is the bounded case this
// rule's escape hatch exists for.
const findPromiseAllMapFanOutDatabaseCall = (
  node: unknown,
): DatabaseCallMatch | null => {
  if (!isPromiseAllLikeCall(node)) {
    return null;
  }
  const args = getField(node, "arguments");
  if (!Array.isArray(args) || args.length !== 1) {
    return null;
  }
  const mapCall = unwrapExpression(args[0]);
  if (!isMapLikeCall(mapCall)) {
    return null;
  }

  const mapArgs = getField(mapCall, "arguments");
  if (!Array.isArray(mapArgs) || mapArgs.length === 0) {
    return null;
  }
  const callback = unwrapExpression(mapArgs.at(-1));

  if (isFunctionNode(callback)) {
    return findDatabaseCall(getField(callback, "body"), true, false);
  }

  if (isIdentifier(callback)) {
    const resolved = resolveLocalFunctionByName(mapCall, callback.name);
    return resolved === null
      ? null
      : findDatabaseCall(getField(resolved, "body"), true, true);
  }

  return null;
};

// The `Promise.all(...)` / `Promise.allSettled(...)` call whose `.map()`
// callback lexically encloses `node`, or null when no such callback does. Used
// to hand a fan-out back to the check that owns it.
const enclosingFanOutCall = (node: unknown): unknown => {
  let current = getField(node, "parent");
  while (current !== null && current !== undefined) {
    const type = getType(current);
    if (type !== null && FUNCTION_TYPES.has(type)) {
      return isPromiseAllMapCallback(current)
        ? getField(getField(current, "parent"), "parent")
        : null;
    }
    current = getField(current, "parent");
  }
  return null;
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

    if (type !== null && LOOP_NODE_TYPES.has(type)) {
      if (isPerIterationLoopPosition(current, child)) {
        return "loop";
      }
      // Await sits in a position the loop evaluates once (a `for`
      // initializer, a `for-of` right-hand side) — keep climbing past this
      // loop node as an ordinary ancestor.
    } else if (
      type !== null &&
      FUNCTION_TYPES.has(type) &&
      !isResultTryPromiseCallback(current)
    ) {
      return isPromiseAllMapCallback(current) ? "promise-all-map" : null;
    }

    child = current;
    current = getField(current, "parent");
  }

  return null;
};

export default eslintCompatPlugin({
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
          noDbHandleAwaitInLoop:
            "Awaited call receives the database handle `{{handle}}` inside a " +
            "loop, so the query behind it runs once per iteration (N+1). " +
            "Hand the whole set (ids, rows) to a batched helper that issues " +
            "one statement, or await once outside the loop. If the iteration " +
            "is inherently sequential (a cursor walk, a page loop, an ordered " +
            "write), disable with a `-- <reason>` note saying why.",
        },
      },
      createOnce(context) {
        const reportAwaitedExpression = (
          node: ESTree.AwaitExpression | ESTree.YieldExpression,
          argument: unknown,
        ): void => {
          if (isDbAwaitCall(argument)) {
            if (findLoopOrMapContext(node) !== null) {
              context.report({ node, messageId: "noDbAwaitInLoop" });
            }
            return;
          }
          const fanOut = findPromiseAllMapFanOutDatabaseCall(argument);
          if (fanOut !== null) {
            context.report(
              fanOut.kind === "handle"
                ? {
                    node,
                    messageId: "noDbHandleAwaitInLoop",
                    data: { handle: fanOut.handle },
                  }
                : { node, messageId: "noDbAwaitInLoop" },
            );
            return;
          }
          const handle = findDbHandleArgument(argument);
          if (handle === null) {
            return;
          }
          const loopContext = findLoopOrMapContext(node);
          if (loopContext === null) {
            return;
          }
          if (
            loopContext === "promise-all-map" &&
            findPromiseAllMapFanOutDatabaseCall(enclosingFanOutCall(node)) !==
              null
          ) {
            // The fan-out check above already reports this `Promise.all(...)`
            // on its own await. Reporting here too would name one fan-out
            // twice and cost it two suppressions.
            return;
          }
          context.report({
            node,
            messageId: "noDbHandleAwaitInLoop",
            data: { handle },
          });
        };

        return {
          AwaitExpression(node) {
            const argument = unwrapExpression(getField(node, "argument"));
            reportAwaitedExpression(node, argument);
          },
          YieldExpression(node) {
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
});
