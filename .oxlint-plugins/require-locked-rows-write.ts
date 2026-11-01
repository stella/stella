import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  type AstNode,
  everyNode,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  staticStringValue,
} from "./utils.ts";

/**
 * A row lock (`.from(table) ... .for("update" | "no key update")`) decides on
 * the rows it returned. A later `update(table)` / `delete(table)` in the same
 * function whose WHERE re-applies the lock's predicate instead of naming those
 * rows also writes every row that started to match after the lock was taken,
 * and that row was never checked. The write must be derived from the locked
 * rows: lock through `lockRowsForWrite` (apps/api/src/lib/db/aggregate-lock.ts)
 * and write with `.where(locked.where(...))`, which names the locked ids. A
 * `const locked = await lockRowsForWrite({ table: t })` (or another helper in
 * LOCKED_ROWS_HELPERS) is a lock on `t` here too: a later write to `t` in the
 * function must use `locked.where(...)` as its whole WHERE.
 *
 * After a plain `.for(...)` lock, the write's WHERE must have a top-level AND
 * conjunct that pins `table.id` (`eq` / `inArray`) and one of:
 * - the pinned ids come from the lock result (or from rows an earlier write
 *   to the table returned after the lock);
 * - an `UPDATE ... FROM` source built from the lock result, joined by
 *   `eq(table.id, ...)`;
 * - the ids are keys chosen elsewhere, not the id set the lock filtered;
 * - the pin is the lock's own single-row key, `eq(table.id, x)` in both.
 * Or the lock is key-shaped (only `eq(table.column, key)` where a key is a
 * variable, not a literal or an enum member, `inArray(table.column, keys)`,
 * and `and` / `or` of those) and the write keeps every one of its conjuncts:
 * every existing row the key names was locked whatever its state.
 * A value from the lock under `or`, `notInArray` or a non-id column does not
 * count: it can widen the write.
 *
 * A row joins a key only by being inserted, which the key's uniqueness or a
 * parent lock governs; this rule is about rows whose state changes into a
 * lock's filter after the lock.
 *
 * A write that deliberately covers rows the lock did not return (the lock is a
 * serialization fence, or the write sweeps a whole parent) says so with a
 * reasoned `oxlint-disable-next-line` on the write.
 *
 * Flagged:
 *   const rows = await tx.select().from(t).where(open).for("update");
 *   await tx.update(t).set(done).where(open);
 *
 * Accepted:
 *   const rows = await tx.select().from(t).where(open).for("update");
 *   await tx.update(t).set(done).where(inArray(t.id, rows.map((r) => r.id)));
 *
 * Out of scope, because the rule reads one function at a time and only
 * Drizzle builders: raw SQL locks and raw `tx.execute(sql\`UPDATE ...\`)`
 * writes, lock helpers outside LOCKED_ROWS_HELPERS that return rows to a
 * caller, and writes made by a helper function the locking function calls.
 */

const RULE_NAME = "require-locked-rows-write";
// Owner helpers that lock rows and return `{ rows, ids, where }`, with the
// table they lock: null reads it from the `table` option.
const LOCKED_ROWS_HELPERS = new Map<string, string | null>([
  ["lockRowsForWrite", null],
  ["lockUnbillableRateCandidates", "timeEntries"],
]);
const WRITE_LOCKS = new Set(["update", "no key update"]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
// Nodes a lock result passes through on its way to a binding.
const RESULT_CARRIERS = new Set([
  "AwaitExpression",
  "ChainExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ParenthesizedExpression",
]);
// Collection writes that make the receiver carry the argument.
const COLLECTING_METHODS = new Set(["push", "unshift", "add", "set"]);
const ID_PINS = new Set(["eq", "inArray"]);
// Bound on following local declarations, which can refer to each other.
const MAX_EXPANSION_DEPTH = 4;

type LockSite = {
  node: AstNode;
  owner: AstNode;
  table: string;
  where: AstNode | null;
  bindings: Set<string>;
  /** Taken by `lockRowsForWrite`, whose `where(...)` is the only filter. */
  helper: boolean;
};

type WriteSite = {
  node: AstNode;
  /** The outermost call of the builder chain, which carries its result. */
  outer: AstNode;
  method: string;
  table: string;
  /** `UPDATE ... FROM` sources. */
  from: AstNode[];
  where: AstNode | null;
  returning: boolean;
};

const parentOf = (node: AstNode): AstNode | null =>
  isAstNode(node.parent) ? node.parent : null;

const argumentsOf = (node: AstNode): unknown[] =>
  Array.isArray(node.arguments) ? node.arguments : [];

const firstArgument = (node: AstNode) => {
  const argument = argumentsOf(node).at(0);
  return isAstNode(argument) ? argument : null;
};

const calledMethod = (call: AstNode) =>
  isAstNode(call.callee) && call.callee.type === "MemberExpression"
    ? memberPropertyName(call.callee)
    : null;

// The method calls of a builder chain, outermost first: called on the `for`
// call of `tx.select().from(t).where(w).for("update")` this yields for,
// where, from, select.
const chainCalls = (call: AstNode): AstNode[] => {
  const calls: AstNode[] = [];
  let current: unknown = call;
  while (isAstNode(current) && current.type === "CallExpression") {
    calls.push(current);
    const callee = current.callee;
    current =
      isAstNode(callee) && callee.type === "MemberExpression"
        ? callee.object
        : null;
  }
  return calls;
};

const chainArgument = (calls: AstNode[], method: string) => {
  const call = calls.find((candidate) => calledMethod(candidate) === method);
  return call ? firstArgument(call) : null;
};

const programOf = (node: AstNode) => {
  let current: AstNode | null = node;
  while (current && current.type !== "Program") {
    current = parentOf(current);
  }
  return current;
};

// `const t = timeEntries` and `const t = schema.timeEntries` aliases in a file.
const tableAliases = new WeakMap<AstNode, Map<string, AstNode>>();
const aliasesIn = (program: AstNode) => {
  const known = tableAliases.get(program);
  if (known) {
    return known;
  }
  const aliases = new Map<string, AstNode>();
  for (const node of everyNode(program)) {
    if (
      node.type === "VariableDeclarator" &&
      isIdentifier(node.id) &&
      isAstNode(node.init) &&
      (node.init.type === "Identifier" || node.init.type === "MemberExpression")
    ) {
      aliases.set(node.id.name, node.init);
    }
  }
  tableAliases.set(program, aliases);
  return aliases;
};

// The table a handle names, by its schema export: `timeEntries`,
// `schema.timeEntries` and a local alias of either all name `timeEntries`.
const tableName = (node: AstNode | null, depth = 0): string | null => {
  if (!node || depth > MAX_EXPANSION_DEPTH) {
    return null;
  }
  if (node.type === "MemberExpression") {
    return node.computed === true ? null : memberPropertyName(node);
  }
  if (!isIdentifier(node)) {
    return null;
  }
  const program = programOf(node);
  const alias = program ? aliasesIn(program).get(node.name) : undefined;
  return alias ? tableName(alias, depth + 1) : node.name;
};

// `table.column` for a table handle named `table`.
const columnOf = (node: unknown, table: string) =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  isAstNode(node.object) &&
  tableName(node.object) === table
    ? memberPropertyName(node)
    : null;

const enclosingFunction = (node: AstNode): AstNode | null => {
  let current = parentOf(node);
  while (current && !FUNCTION_TYPES.has(current.type)) {
    current = parentOf(current);
  }
  return current;
};

const contains = (outer: AstNode, inner: AstNode) =>
  outer.range[0] <= inner.range[0] && outer.range[1] >= inner.range[1];

// A callback whose whole body is the lock (`(cap) => tx.select()...for(...)`)
// hands the rows to its caller; the decision is made where they are bound.
const returnsOnly = (fn: AstNode, expression: AstNode) => {
  const body = fn.body;
  if (!isAstNode(body)) {
    return false;
  }
  if (body.type !== "BlockStatement") {
    return contains(body, expression);
  }
  const statements = Array.isArray(body.body) ? body.body : [];
  const only = statements.at(0);
  return (
    statements.length === 1 &&
    isAstNode(only) &&
    only.type === "ReturnStatement"
  );
};

// The handle a builder chain starts from: `tx` in `tx.select()...for()`.
const chainRoot = (call: AstNode) => {
  let current: unknown = call;
  while (
    isAstNode(current) &&
    (current.type === "CallExpression" || current.type === "MemberExpression")
  ) {
    current =
      current.type === "CallExpression" ? current.callee : current.object;
  }
  return isIdentifier(current) ? current.name : null;
};

// A callback that receives the transaction (`safeDb((tx) => ...)`) is the
// whole transaction; a write after it runs in another one.
const receivesHandle = (fn: AstNode, handle: string | null) =>
  handle !== null &&
  identifierNames(Array.isArray(fn.params) ? fn.params : []).includes(handle);

// The function that owns the lock result, and the expression whose value
// carries the locked rows inside it.
const lockOwner = (lock: AstNode) => {
  const handle = chainRoot(lock);
  let carrier = lock;
  let owner = enclosingFunction(lock);
  while (
    owner &&
    returnsOnly(owner, carrier) &&
    !receivesHandle(owner, handle)
  ) {
    // Climb out of the callback to the call that receives it
    // (`readBounded({ limit: (cap) => ... })`).
    let receiver = parentOf(owner);
    while (receiver && receiver.type !== "CallExpression") {
      receiver = parentOf(receiver);
    }
    const outer = receiver ? enclosingFunction(receiver) : null;
    if (!receiver || !outer) {
      break;
    }
    carrier = receiver;
    owner = outer;
  }
  return { owner, carrier };
};

// Identifiers that name a value, not a property: `rows` in `rows.id` and in
// `{ ids: rows }`, never `id` or `ids`.
const identifierNames = (roots: unknown) =>
  everyNode(roots).flatMap((node) => {
    if (node.type !== "Identifier" || typeof node.name !== "string") {
      return [];
    }
    const parent = parentOf(node);
    const propertyName =
      (parent?.type === "MemberExpression" &&
        parent.property === node &&
        parent.computed !== true) ||
      (parent?.type === "Property" &&
        parent.key === node &&
        parent.computed !== true &&
        parent.shorthand !== true);
    return propertyName ? [] : [node.name];
  });

const readsAny = (root: unknown, names: ReadonlySet<string>) =>
  identifierNames(root).some((name) => names.has(name));

const addPatternNames = (pattern: unknown, names: Set<string>) => {
  const before = names.size;
  for (const name of identifierNames(pattern)) {
    names.add(name);
  }
  return names.size > before;
};

// Bindings that receive the lock result: `const rows = await lock`,
// `const [row] = await lock`, `const row = (await lock).at(0)`,
// `const [row] = ready ? await lock : []`, `rows = await lock`.
const lockBindings = (carrier: AstNode) => {
  const names = new Set<string>();
  let current = carrier;
  let parent = parentOf(current);
  while (
    parent &&
    (RESULT_CARRIERS.has(parent.type) ||
      (parent.type === "MemberExpression" && parent.object === current) ||
      (parent.type === "CallExpression" && parent.callee === current))
  ) {
    current = parent;
    parent = parentOf(current);
  }
  if (parent?.type === "VariableDeclarator") {
    addPatternNames(parent.id, names);
  } else if (parent?.type === "AssignmentExpression") {
    addPatternNames(parent.left, names);
  }
  return names;
};

// Close `bindings` over what `scope` computes from them:
// `const ids = rows.map((row) => row.id)`, `ids.push(row.id)`,
// `for (const row of rows)` and `rows.map((row) => ...)` parameters.
const deriveBindings = (scope: AstNode, seed: ReadonlySet<string>) => {
  const bindings = new Set(seed);
  const nodes = everyNode(scope);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (node.type === "VariableDeclarator" && readsAny(node.init, bindings)) {
        grew = addPatternNames(node.id, bindings) || grew;
      } else if (
        node.type === "AssignmentExpression" &&
        readsAny(node.right, bindings)
      ) {
        grew = addPatternNames(node.left, bindings) || grew;
      } else if (
        node.type === "ForOfStatement" &&
        readsAny(node.right, bindings)
      ) {
        grew = addPatternNames(node.left, bindings) || grew;
      } else if (
        node.type === "CallExpression" &&
        isAstNode(node.callee) &&
        node.callee.type === "MemberExpression"
      ) {
        const receiver = node.callee.object;
        if (
          isIdentifier(receiver) &&
          COLLECTING_METHODS.has(memberPropertyName(node.callee) ?? "") &&
          readsAny(node.arguments, bindings)
        ) {
          grew = addPatternNames(receiver, bindings) || grew;
        }
        if (readsAny(receiver, bindings)) {
          for (const argument of argumentsOf(node)) {
            if (isAstNode(argument) && FUNCTION_TYPES.has(argument.type)) {
              grew = addPatternNames(argument.params, bindings) || grew;
            }
          }
        }
      }
    }
  }
  return bindings;
};

// What a local name holds: its declarator's initializer and anything pushed
// into it (`const conditions = [a]; conditions.push(b)`).
const localValues = (scope: AstNode, name: string) =>
  everyNode(scope).flatMap((node): AstNode[] => {
    if (
      node.type === "VariableDeclarator" &&
      isIdentifier(node.id, name) &&
      isAstNode(node.init)
    ) {
      return [node.init];
    }
    if (
      node.type === "CallExpression" &&
      isAstNode(node.callee) &&
      node.callee.type === "MemberExpression" &&
      isIdentifier(node.callee.object, name) &&
      COLLECTING_METHODS.has(memberPropertyName(node.callee) ?? "")
    ) {
      return argumentsOf(node).filter(isAstNode);
    }
    return [];
  });

// The top-level conjuncts of a predicate, following `and(...)`, spreads and
// local predicate variables.
const conjunctsOf = (
  scope: AstNode,
  node: AstNode | null,
  depth = 0,
): AstNode[] => {
  if (!node) {
    return [];
  }
  if (depth > MAX_EXPANSION_DEPTH) {
    return [node];
  }
  if (node.type === "CallExpression" && isIdentifier(node.callee, "and")) {
    return argumentsOf(node)
      .filter(isAstNode)
      .flatMap((argument) => conjunctsOf(scope, argument, depth + 1));
  }
  if (node.type === "SpreadElement" && isAstNode(node.argument)) {
    return conjunctsOf(scope, node.argument, depth + 1);
  }
  if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
    return node.elements
      .filter(isAstNode)
      .flatMap((element) => conjunctsOf(scope, element, depth + 1));
  }
  if (isIdentifier(node)) {
    const values = localValues(scope, node.name);
    return values.length === 0
      ? [node]
      : values.flatMap((value) => conjunctsOf(scope, value, depth + 1));
  }
  return [node];
};

// `eq(table.id, x)` / `inArray(table.id, xs)`, keyed by operator and the
// source text of the value.
const idPin = (
  node: AstNode,
  table: string,
  text: (node: AstNode) => string,
) => {
  if (
    node.type !== "CallExpression" ||
    !isIdentifier(node.callee) ||
    !ID_PINS.has(node.callee.name)
  ) {
    return null;
  }
  const [column, value] = argumentsOf(node);
  return columnOf(column, table) === "id" && isAstNode(value)
    ? {
        operator: node.callee.name,
        value,
        key: `${node.callee.name}:${normalized(text(value))}`,
      }
    : null;
};

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/u;

// Source text compared across the lock and the write, layout ignored.
const normalized = (source: string) =>
  source.replace(/\s+/gu, "").replaceAll(",)", ")");

// A key value names an identity (`orgId`, `target.family`, `keyFor(id)`); a
// literal or an enum member (`"open"`, `STATUS.APPROVED`) names a state a row
// can move into after the lock. A lone constant identifier is a fixed key.
const isKeyValue = (value: unknown): boolean => {
  if (!isAstNode(value) || value.type === "Literal") {
    return false;
  }
  if (value.type === "TemplateLiteral") {
    return Array.isArray(value.expressions) && value.expressions.length > 0;
  }
  if (value.type === "MemberExpression") {
    let root: unknown = value;
    while (isAstNode(root) && root.type === "MemberExpression") {
      root = root.object;
    }
    return !(isIdentifier(root) && CONSTANT_NAME.test(root.name));
  }
  return true;
};

// A list of keys (`ids`, `[...ids]`); a constant list (`OPEN_STATUSES`) is a
// set of states.
const isKeyList = (value: unknown): boolean => {
  if (isIdentifier(value)) {
    return !CONSTANT_NAME.test(value.name);
  }
  if (isAstNode(value) && value.type === "ArrayExpression") {
    const elements = Array.isArray(value.elements) ? value.elements : [];
    return elements.every((element) =>
      isAstNode(element) && element.type === "SpreadElement"
        ? isKeyList(element.argument)
        : isKeyValue(element),
    );
  }
  return isKeyValue(value);
};

// The expression-bodied arrow a module-level `const name = (...) => expr`
// declares in the file of `node`.
const expressionHelper = (node: AstNode, name: string) => {
  let program: AstNode | null = node;
  while (program && program.type !== "Program") {
    program = parentOf(program);
  }
  const body = program && Array.isArray(program.body) ? program.body : [];
  for (const statement of body) {
    const declaration =
      isAstNode(statement) && statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (
      !isAstNode(declaration) ||
      declaration.type !== "VariableDeclaration" ||
      !Array.isArray(declaration.declarations)
    ) {
      continue;
    }
    for (const declarator of declaration.declarations) {
      if (
        isAstNode(declarator) &&
        isIdentifier(declarator.id, name) &&
        isAstNode(declarator.init) &&
        declarator.init.type === "ArrowFunctionExpression" &&
        isAstNode(declarator.init.body) &&
        declarator.init.body.type !== "BlockStatement"
      ) {
        return declarator.init;
      }
    }
  }
  return null;
};

// `...items.map((item) => and(...))` stands for each mapped predicate.
const mappedOperand = (operand: AstNode): AstNode => {
  const spread =
    operand.type === "SpreadElement" && isAstNode(operand.argument)
      ? operand.argument
      : null;
  const callback =
    spread?.type === "CallExpression" ? firstArgument(spread) : null;
  return spread &&
    calledMethod(spread) === "map" &&
    callback?.type === "ArrowFunctionExpression" &&
    isAstNode(callback.body) &&
    callback.body.type !== "BlockStatement"
    ? callback.body
    : operand;
};

// A predicate that names rows by identity, never by state: `eq(table.col,
// key)`, `inArray(table.col, keys)`, and `and` / `or` of those. Every existing
// row it names stays locked whatever happens to its state, so no other row can
// move into it after the lock.
const isKeyShaped = (scope: AstNode, node: AstNode, table: string): boolean => {
  if (node.type !== "CallExpression" || !isIdentifier(node.callee)) {
    return false;
  }
  const operator = node.callee.name;
  if (operator === "and" || operator === "or") {
    const operands = argumentsOf(node).filter(isAstNode).map(mappedOperand);
    return (
      operands.length > 0 &&
      operands.every((operand) =>
        conjunctsOf(scope, operand).every((part) =>
          isKeyShaped(scope, part, table),
        ),
      )
    );
  }
  if (!ID_PINS.has(operator)) {
    // A same-file key helper: `const logKey = (org, run) => and(eq(...), ...)`.
    const helper = expressionHelper(node, operator);
    return (
      helper !== null &&
      isAstNode(helper.body) &&
      isKeyShaped(helper, helper.body, table)
    );
  }
  const [column, value] = argumentsOf(node);
  return (
    columnOf(column, table) !== null &&
    (operator === "inArray" ? isKeyList(value) : isKeyValue(value))
  );
};

const writeSite = (call: AstNode): WriteSite | null => {
  const method = calledMethod(call);
  if (method !== "update" && method !== "delete") {
    return null;
  }
  const table = tableName(firstArgument(call));
  if (!table) {
    return null;
  }
  // Walk outward along the builder: update(t).set(v).from(s).where(w).
  const from: AstNode[] = [];
  let where: AstNode | null = null;
  let returning = false;
  let current = call;
  let parent = parentOf(current);
  while (
    parent &&
    parent.type === "MemberExpression" &&
    parent.object === current
  ) {
    const outer = parentOf(parent);
    if (!outer || outer.type !== "CallExpression" || outer.callee !== parent) {
      break;
    }
    const step = memberPropertyName(parent);
    const argument = firstArgument(outer);
    if (step === "where" && argument) {
      where = argument;
    } else if (step === "from" && argument) {
      from.push(argument);
    } else if (step === "returning") {
      returning = true;
    }
    current = outer;
    parent = parentOf(current);
  }
  return { node: call, outer: current, method, table, from, where, returning };
};

// `lockRowsForWrite({ table: t, query })` locks rows of `t`; its result is
// the lock result.
const ownerLockSite = (node: AstNode): LockSite | null => {
  if (!isIdentifier(node.callee)) {
    return null;
  }
  const fixedTable = LOCKED_ROWS_HELPERS.get(node.callee.name);
  if (fixedTable === undefined) {
    return null;
  }
  const options = firstArgument(node);
  const properties =
    options?.type === "ObjectExpression" && Array.isArray(options.properties)
      ? options.properties.filter(isAstNode)
      : [];
  const tableProperty = properties.find(
    (property) =>
      property.type === "Property" &&
      isIdentifier(property.key, "table") &&
      property.computed !== true,
  );
  const table =
    fixedTable ??
    tableName(isAstNode(tableProperty?.value) ? tableProperty.value : null);
  if (!table) {
    return null;
  }
  const { owner, carrier } = lockOwner(node);
  return owner
    ? {
        node,
        owner,
        table,
        where: null,
        bindings: lockBindings(carrier),
        helper: true,
      }
    : null;
};

const lockSite = (node: AstNode): LockSite | null => {
  const strength = staticStringValue(argumentsOf(node).at(0));
  if (strength === null || !WRITE_LOCKS.has(strength)) {
    return null;
  }
  const calls = chainCalls(node);
  const table = tableName(chainArgument(calls, "from"));
  if (!table) {
    return null;
  }
  const { owner, carrier } = lockOwner(node);
  return owner
    ? {
        node,
        owner,
        table,
        where: chainArgument(calls, "where"),
        bindings: lockBindings(carrier),
        helper: false,
      }
    : null;
};

// `locked.where(...)` on a binding of the helper's result, or the destructured
// `where(...)` of `const { where } = await lockRowsForWrite(...)`.
const isLockedWhere = (where: AstNode | null, names: ReadonlySet<string>) => {
  if (where?.type !== "CallExpression" || !isAstNode(where.callee)) {
    return false;
  }
  const callee = where.callee;
  if (isIdentifier(callee)) {
    return names.has(callee.name);
  }
  return (
    calledMethod(where) === "where" &&
    isIdentifier(callee.object) &&
    names.has(callee.object.name)
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          rederived:
            "This {{method}} on {{table}} follows a row lock on it but re-derives its WHERE, so it also writes rows that only matched after the lock. Lock with lockRowsForWrite and write with .where(locked.where()), or restrict the WHERE to the locked rows.",
        },
      },
      createOnce(context) {
        const locks: LockSite[] = [];
        const writes: WriteSite[] = [];
        const text = (node: AstNode) =>
          context.sourceCode.text.slice(node.range[0], node.range[1]);
        const pinned = (write: WriteSite, preceding: LockSite[]) => {
          const scope = preceding.at(0)?.owner;
          if (!scope) {
            return true;
          }
          // After the helper, the write's whole WHERE is `locked.where(...)`:
          // wrapping it (`or(locked.where(), x)`) would widen it again.
          const helperLocks = preceding.filter(({ helper }) => helper);
          if (helperLocks.length > 0) {
            return helperLocks.some((lock) =>
              isLockedWhere(write.where, lock.bindings),
            );
          }
          const seed = new Set<string>();
          for (const lock of preceding) {
            for (const name of lock.bindings) {
              seed.add(name);
            }
          }
          // Rows an earlier write to the same table returned after the lock
          // are a subset of what that write reached, so they count as locked.
          for (const earlier of writes) {
            if (
              earlier.returning &&
              earlier.table === write.table &&
              earlier.node.range[1] < write.node.range[0] &&
              preceding.some(
                (lock) =>
                  lock.node.range[1] < earlier.node.range[0] &&
                  contains(lock.owner, earlier.node),
              )
            ) {
              for (const name of lockBindings(earlier.outer)) {
                seed.add(name);
              }
            }
          }
          const derived = deriveBindings(scope, seed);
          // Only top-level AND conjuncts narrow the write; anything under
          // `or`, `not` or `notInArray` can widen it.
          const conjuncts = conjunctsOf(scope, write.where);
          const pins = conjuncts.flatMap(
            (node) => idPin(node, write.table, text) ?? [],
          );
          // `eq` / `inArray(table.id, <from the locked rows>)`.
          if (pins.some(({ value }) => readsAny(value, derived))) {
            return true;
          }
          // `UPDATE ... FROM (<locked rows>) WHERE table.id = source.id`.
          if (
            readsAny(write.from, derived) &&
            pins.some(({ operator }) => operator === "eq")
          ) {
            return true;
          }
          const writeConjuncts = new Set(
            conjuncts.map((node) => normalized(text(node))),
          );
          return preceding.some((lock) => {
            const lockConjuncts = conjunctsOf(lock.owner, lock.where);
            const lockPins = lockConjuncts.flatMap(
              (node) => idPin(node, lock.table, text) ?? [],
            );
            // A key-shaped lock holds every existing row it names, so a write
            // that keeps all of its conjuncts reaches only locked rows,
            // whatever it adds to narrow them.
            const keepsKeyLock =
              lockConjuncts.length > 0 &&
              lockConjuncts.every(
                (node) =>
                  isKeyShaped(lock.owner, node, lock.table) &&
                  writeConjuncts.has(normalized(text(node))),
              );
            // One row by primary key: the lock read exactly that row.
            const keepsRowKey = lockPins.some(
              (lockPin) =>
                lockPin.operator === "eq" &&
                pins.some(({ key }) => key === lockPin.key),
            );
            // Rows named by ids chosen elsewhere (`inArray(t.id, dependents)`)
            // cannot move into the set. Ids the lock itself filtered by state
            // can: that is the re-derived write this rule exists for.
            const namesOtherIds = pins.some(
              (pin) =>
                (pin.operator === "inArray"
                  ? isKeyList(pin.value)
                  : isKeyValue(pin.value)) &&
                lockPins.every(({ key }) => key !== pin.key),
            );
            return keepsKeyLock || keepsRowKey || namesOtherIds;
          });
        };
        return {
          before() {
            locks.length = 0;
            writes.length = 0;
          },
          CallExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            if (calledMethod(node) === "for") {
              const lock = lockSite(node);
              if (lock) {
                locks.push(lock);
              }
              return;
            }
            const ownerLock = ownerLockSite(node);
            if (ownerLock) {
              locks.push(ownerLock);
              return;
            }
            const write = writeSite(node);
            if (write) {
              writes.push(write);
            }
          },
          "Program:exit"() {
            for (const write of writes) {
              const preceding = locks.filter(
                (lock) =>
                  lock.table === write.table &&
                  lock.node.range[1] < write.node.range[0] &&
                  contains(lock.owner, write.node),
              );
              if (preceding.length === 0 || pinned(write, preceding)) {
                continue;
              }
              context.report({
                node: write.node,
                messageId: "rederived",
                data: { method: write.method, table: write.table },
              });
            }
          },
        };
      },
    },
  },
});
