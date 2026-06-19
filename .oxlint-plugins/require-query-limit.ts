// Require an explicit bound on Drizzle list reads so a query cannot
// silently return an unbounded result set as a table grows.
//
// CLAUDE.md / conventions-db + conventions-scale mandate: "Every list
// query MUST take a limit; never an unbounded findMany/select." An
// unbounded read is invisible in dev (small tables) and turns into a
// memory / latency cliff at Magic Circle scale.
//
// This rule covers the three Drizzle read shapes that are unbounded by
// default, using high-signal triggers to avoid false positives on
// single-row reads, counts, and aggregations:
//
//   1. Relational API — `db.query.x.findMany({...})` with no `limit`
//      key in the options object literal (or called with no options).
//      `findFirst` is inherently bounded and is never flagged.
//
//   2. SQL builder — a `.select()....orderBy(...)` chain with no
//      `.limit(...)` anywhere in the chain. A query that bothers to
//      ORDER BY is returning a meaningful ordered list, so it must be
//      bounded. Unordered `.select().from().where()` reads (counts,
//      `exists`, single-row lookups, joins) are intentionally NOT
//      flagged here to keep the rule false-positive-free.
//
//   3. Eager-loaded relations — a `with: { rel: { orderBy: ... } }`
//      relation config (on either `findMany` or `findFirst`) with no
//      `limit` key. A relation that bothers to ORDER BY is a to-many
//      list, so a bounded parent row can still pull an unbounded child
//      list (e.g. every message in a chat thread). Scanned recursively
//      through nested `with`. A `true` / variable relation config is a
//      to-one or opaque relation and is left alone.
//
// Flags:
//   tx.query.foo.findMany()                          // no options
//   tx.query.foo.findMany({ where: ... })            // options w/o limit
//   tx.select({...}).from(foo).where(...).orderBy(x) // ordered, no limit
//   tx.query.foo.findFirst({ with: { bars: { orderBy: x } } }) // ordered relation, no limit
//
// Allows:
//   tx.query.foo.findMany({ where: ..., limit: LIMITS.x })
//   tx.query.foo.findFirst({ where: ... })
//   tx.select({...}).from(foo).where(...).orderBy(x).limit(n)
//   tx.select({...}).from(foo).where(...)            // unordered: not flagged
//   tx.query.foo.findMany(opts)                       // opaque options: skip
//   tx.query.foo.findFirst({ with: { bars: { orderBy: x, limit: LIMITS.y } } })
//   tx.query.foo.findFirst({ with: { bar: true } })  // to-one / opaque: skip
//
// Escape hatch (genuinely bounded, e.g. a full per-org config set that
// is already capped on the write path, or a deliberate aggregation):
//   // eslint-disable-next-line require-query-limit/require-query-limit
//   // SAFETY: writes are capped at LIMITS.fooPerOrg, so this cannot grow unbounded.

import { getPropertyName } from "./utils.ts";

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

// Name of the method invoked by a `CallExpression` whose callee is a
// non-computed `MemberExpression` (e.g. `foo.bar()` -> "bar"). Null otherwise.
const calleeMethodName = (callExpression: unknown): string | null => {
  if (getType(callExpression) !== "CallExpression") {
    return null;
  }
  const callee = getField(callExpression, "callee");
  if (getType(callee) !== "MemberExpression" || isComputed(callee)) {
    return null;
  }
  return getPropertyName(getField(callee, "property"));
};

// Collect every method name invoked across the whole fluent chain that
// `node` (a method-call `CallExpression`) participates in. Walks down
// through `callee.object` (earlier links) and up through `parent`
// (later links) so the order of `node` in the chain does not matter.
const collectChainMethodNames = (node: unknown): Set<string> => {
  const names = new Set<string>();

  let current: unknown = node;
  while (
    getType(current) === "CallExpression" &&
    getType(getField(current, "callee")) === "MemberExpression"
  ) {
    const callee = getField(current, "callee");
    const name = getPropertyName(getField(callee, "property"));
    if (name !== null) {
      names.add(name);
    }
    current = getField(callee, "object");
  }

  let child: unknown = node;
  let parent: unknown = getField(node, "parent");
  while (parent !== null) {
    if (
      getType(parent) !== "MemberExpression" ||
      isComputed(parent) ||
      getField(parent, "object") !== child
    ) {
      break;
    }
    const grandparent = getField(parent, "parent");
    if (
      getType(grandparent) !== "CallExpression" ||
      getField(grandparent, "callee") !== parent
    ) {
      break;
    }
    const name = getPropertyName(getField(parent, "property"));
    if (name !== null) {
      names.add(name);
    }
    child = grandparent;
    parent = getField(grandparent, "parent");
  }

  return names;
};

// A findMany options arg satisfies the rule only when it is an object
// literal carrying a `limit` key. A non-object (variable / spread) arg
// is opaque and skipped; a missing arg is unbounded and flagged.
type FindManyState = "missing" | "present" | "opaque";

const findManyLimitState = (callExpression: unknown): FindManyState => {
  const args = getField(callExpression, "arguments");
  if (!Array.isArray(args) || args.length === 0) {
    return "missing";
  }
  const options = args[0];
  if (getType(options) !== "ObjectExpression") {
    return "opaque";
  }
  const properties = getField(options, "properties");
  if (!Array.isArray(properties)) {
    return "opaque";
  }
  for (const property of properties) {
    if (getType(property) === "SpreadElement") {
      return "opaque";
    }
    if (getType(property) !== "Property") {
      continue;
    }
    if (getPropertyName(getField(property, "key")) === "limit") {
      return "present";
    }
  }
  return "missing";
};

// Recursively flag eager-loaded relations that ORDER BY without a LIMIT.
// `withObject` is the value of a `with:` property — an object whose keys
// are relation names and whose values are either a config object literal
// or `true` (to-one / load-all, left alone). A relation config that has
// an `orderBy` but no `limit` is an unbounded ordered list read, the same
// signal the SQL-builder branch uses. Nested `with` is walked too.
const scanWithObject = (context: unknown, withObject: unknown): void => {
  if (getType(withObject) !== "ObjectExpression") {
    return;
  }
  const relations = getField(withObject, "properties");
  if (!Array.isArray(relations)) {
    return;
  }
  for (const relation of relations) {
    if (getType(relation) !== "Property") {
      continue;
    }
    const config = getField(relation, "value");
    if (getType(config) !== "ObjectExpression") {
      continue;
    }
    const configProperties = getField(config, "properties");
    if (!Array.isArray(configProperties)) {
      continue;
    }
    let orderByKey: unknown = null;
    let hasLimit = false;
    let nestedWith: unknown = null;
    for (const property of configProperties) {
      if (getType(property) !== "Property") {
        continue;
      }
      const name = getPropertyName(getField(property, "key"));
      if (name === "orderBy") {
        orderByKey = getField(property, "key");
      } else if (name === "limit") {
        hasLimit = true;
      } else if (name === "with") {
        nestedWith = getField(property, "value");
      }
    }
    if (orderByKey !== null && !hasLimit) {
      // Report on the `orderBy` key so the diagnostic — and any
      // disable-next-line — lands on the `orderBy:` line.
      (context as { report: (descriptor: unknown) => void }).report({
        node: orderByKey,
        messageId: "withRelationNoLimit",
      });
    }
    if (nestedWith !== null) {
      scanWithObject(context, nestedWith);
    }
  }
};

// Scan the `with` property of a relational-query options object literal
// for unbounded eager-loaded relations. Applies to both `findMany` and
// `findFirst` (a bounded parent row can still eager-load an unbounded
// child list).
const scanRelationalWith = (
  context: unknown,
  callExpression: unknown,
): void => {
  const args = getField(callExpression, "arguments");
  if (!Array.isArray(args) || args.length === 0) {
    return;
  }
  const options = args[0];
  if (getType(options) !== "ObjectExpression") {
    return;
  }
  const properties = getField(options, "properties");
  if (!Array.isArray(properties)) {
    return;
  }
  for (const property of properties) {
    if (getType(property) !== "Property") {
      continue;
    }
    if (getPropertyName(getField(property, "key")) === "with") {
      scanWithObject(context, getField(property, "value"));
    }
  }
};

export default {
  meta: { name: "require-query-limit" },
  rules: {
    "require-query-limit": {
      meta: {
        type: "problem",
        messages: {
          findManyNoLimit:
            "Drizzle `findMany` must pass a `limit` so the result set " +
            "stays bounded. Add `limit: LIMITS.x` (see apps/api/src/lib/" +
            "limits.ts) or paginate. If the set is already capped on the " +
            "write path, disable with a `// SAFETY:` note citing the cap.",
          orderByNoLimit:
            "A sorted Drizzle query (`.orderBy(...)`) must also " +
            "`.limit(...)` so it cannot return an unbounded ordered list. " +
            "Add `.limit(LIMITS.x)` / cursor pagination, or disable with a " +
            "`// SAFETY:` note when the set is provably bounded.",
          withRelationNoLimit:
            "An eager-loaded Drizzle relation (`with: { rel: { orderBy: " +
            "... } }`) must also set a `limit` so a bounded parent row " +
            "cannot pull an unbounded ordered child list. Add `limit: " +
            "LIMITS.x` / paginate, or disable with a `// SAFETY:` note " +
            "when the relation is provably bounded.",
        },
      },
      create(context) {
        return {
          CallExpression(node: unknown) {
            const method = calleeMethodName(node);
            if (method === null) {
              return;
            }

            // Both relational reads can eager-load an unbounded ordered
            // relation via `with`; only `findMany` is itself unbounded.
            if (method === "findMany" || method === "findFirst") {
              if (
                method === "findMany" &&
                findManyLimitState(node) === "missing"
              ) {
                context.report({ node, messageId: "findManyNoLimit" });
              }
              scanRelationalWith(context, node);
              return;
            }

            if (method !== "orderBy") {
              return;
            }
            const chain = collectChainMethodNames(node);
            // Only a select-builder chain (has `.from`) that is ordered
            // but not limited is unbounded. Guarding on `from` keeps
            // non-Drizzle `.orderBy` calls out of scope.
            if (chain.has("from") && !chain.has("limit")) {
              // Report on the `orderBy` member identifier, not the whole
              // chain CallExpression (which starts at the chain root, often
              // several lines up), so the diagnostic — and any
              // disable-next-line — lands on the `.orderBy(` line.
              const callee = getField(node, "callee");
              const reportNode = getField(callee, "property") ?? node;
              context.report({ node: reportNode, messageId: "orderByNoLimit" });
            }
          },
        };
      },
    },
  },
};
