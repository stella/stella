// Tests wait on the work they exercise, not on the clock.
//
// A test that sleeps to let work finish guesses how long the work takes: too
// short and it fails on a loaded machine, too long and every run pays for the
// guess. Wait on the work's own completion signal instead (the promise it
// returns, a `Promise.withResolvers` it settles, an event it emits), or drive
// fake timers. Real time is sometimes the behaviour under test (a sleep
// helper, a rate limiter's pacing, an idle timeout); such a site says so in a
// `// real-time: <reason>` comment on its line or directly above its
// statement.
//
// no-real-time-wait
//   Flagged:
//     Bun.sleep(n), Bun.sleepSync(n), `sleep` / `sleepSync` imported from "bun"
//     setTimeout / setInterval imported from "node:timers/promises"
//     sleep(n) imported from "@stll/concurrency/sleep"
//     <receiver>.waitForTimeout(n) (Playwright pages, frames, locators)
//     new Promise((resolve) => setTimeout(resolve, n)): the global
//       `setTimeout` called anywhere in the executor's own body. A local
//       `sleep` helper built this way is reported once, at its definition.
//   Allowed:
//     a `setTimeout`-built wait (the promise form, the shared `sleep` helper)
//       in a file that installs fake timers (`jest.useFakeTimers()`), where
//       the test advances the clock itself
//     a site with a `// real-time: <reason>` comment
//
// no-polling-loop
//   Flagged: a `for`, `while` or `do`-`while` loop that waits on the clock or
//     the scheduler on each pass and keeps going until a predicate holds:
//       for (let i = 0; i < 100 && !done(); i++) await sleep(5);
//       while (true) { if (ready()) break; await Bun.sleep(10); }
//       while (!seen) await new Promise((r) => setImmediate(r));
//     A wait is any `no-real-time-wait` form, a scheduler tick (`await
//     Promise.resolve()`, a promise settled from `setImmediate`,
//     `queueMicrotask` or `requestAnimationFrame`, `setImmediate` from
//     `timers/promises`), or a call to a function of the same file that
//     waits, anywhere in the loop's body, test or update (callbacks included:
//     `await act(async () => sleep(5))` waits too). The loop polls when a
//     conditional `break`/`return`/`throw` in its body, or a test other than
//     `true` or a bare counter the loop advances, decides when it stops.
//   Allowed: a fixed-count flush (`for (let i = 0; i < 3; i++) await tick()`)
//     and a loop with a `// real-time: <reason>` comment. The fix is to
//     await the signal that makes the predicate true.
//
// no-unreasoned-timeout
//   A raised timeout or a retry hides a wait that should be event-driven: the
//   test passes on a fast machine and grows slower or flakier with load.
//   Flagged without a `// timeout: <reason>` or `// quarantine: #<issue>`
//   comment:
//     a `bun:test` test or hook (named, aliased or namespace import, through
//       `.each`, `.if`, `.serial` and the other modifiers) whose timeout
//       argument (`test(title, fn, 30_000)`, `beforeAll(fn, 30_000)`, or a
//       `{ timeout }` option) is above Bun's 5000 ms default or cannot be
//       read statically, and a `{ retry }` option above zero
//     `setDefaultTimeout(n)` and `jest.setTimeout(n)` from `bun:test` above
//       the default or unreadable
//     Playwright `test.setTimeout(n)`, `testInfo.setTimeout(n)`,
//       `test.info().setTimeout(n)`, `test.slow()`, and
//       `test.describe.configure({ timeout, retries })`
//   Allowed: a timeout at or below the default, and
//     `propertyTestTimeout(...)` / `propertyTestDefaultTimeout()`, whose
//     budget the property-testing convention owns.
//
// no-literal-wait-timeout
//   Testing Library condition waits run under the suite's shared hang guard,
//   so every per-call timeout is redundant. Playwright waits instead keep
//   explicit, reviewable budgets as named constants; only bare numeric values
//   and numeric expressions are rejected there.
//   Flagged:
//     Testing Library `waitFor`, `waitForElementToBeRemoved`, and `findBy*` /
//       `findAllBy*` calls with any `timeout` option, unless
//       `// real-time: <reason>` says why the subject outlasts the hang guard
//     Playwright `expect.poll`, `toPass`, and locator assertions with a
//       bare numeric `timeout` option (including numeric expressions)
//
// Existing sites are budgeted per file, enclosing function and spelling in
// scripts/test-timing-ledger.json (no line numbers, a reason per row). A hit
// beyond its budget is reported, and so is a budget the code no longer
// reaches. Regenerate with `bun scripts/test-timing-ledger.ts --write`.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import ledger from "../scripts/test-timing-ledger.json" with { type: "json" };
import { createBudgetLedger } from "./budget-ledger.ts";
import {
  type AstNode,
  filenameForContext,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  type ScopeContext,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const REAL_TIME_WAIT_RULE = "no-real-time-wait";
const POLLING_LOOP_RULE = "no-polling-loop";
const TIMEOUT_RULE = "no-unreasoned-timeout";
const LITERAL_WAIT_TIMEOUT_RULE = "no-literal-wait-timeout";
const LEDGER_PATH = "scripts/test-timing-ledger.json";

const { tracker: budgetTracker, staleMessage: STALE_MESSAGE } =
  createBudgetLedger(LEDGER_PATH, ledger);

// --- Tagged reason comments --------------------------------------------------

type SourceComment = { range: [number, number]; value: string };

const isSourceComment = (value: unknown): value is SourceComment =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  typeof value.value === "string" &&
  "range" in value &&
  Array.isArray(value.range) &&
  value.range.length === 2 &&
  value.range.every((offset) => typeof offset === "number");

/**
 * A comment that opens with one of `tags` and a colon, then says something:
 * at least one word of three letters, so `// real-time: x` or a bare tag is
 * not a reason.
 */
export const taggedComment = (tags: readonly string[]): RegExp =>
  new RegExp(`^\\s*(?:${tags.join("|")}):\\s*(?=.*\\p{L}{3})`, "u");

const REAL_TIME_REASON = taggedComment(["real-time"]);

const lineStartOf = (text: string, offset: number): number =>
  text.lastIndexOf("\n", offset - 1) + 1;

const lineEndOf = (text: string, offset: number): number => {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
};

// The statement `node` belongs to: itself when it is one, else the nearest
// enclosing statement or declaration.
const enclosingStatement = (node: AstNode): AstNode => {
  let current: AstNode = node;
  while (!/(?:Statement|Declaration)$/u.test(current.type)) {
    const parent = current.parent;
    if (!isAstNode(parent) || parent.type === "Program") {
      return current;
    }
    current = parent;
  }
  return current;
};

type TaggedLookup = {
  comments: readonly SourceComment[];
  node: unknown;
  pattern: RegExp;
  text: string;
};

const taggedOnLineOf = (
  { comments, pattern, text }: TaggedLookup,
  offset: number,
): boolean => {
  const start = lineStartOf(text, offset);
  const end = lineEndOf(text, offset);
  return comments.some(
    (comment) =>
      comment.range[0] >= start &&
      comment.range[0] < end &&
      pattern.test(comment.value),
  );
};

// A matching comment on the node's own line or its statement's first line, or
// in the unbroken run of own-line comments directly above the statement.
const hasTaggedComment = (lookup: TaggedLookup): boolean => {
  const { comments, node, pattern, text } = lookup;
  if (!isAstNode(node)) {
    return false;
  }
  const statement = enclosingStatement(node);
  if (
    taggedOnLineOf(lookup, node.range[0]) ||
    taggedOnLineOf(lookup, statement.range[0])
  ) {
    return true;
  }
  let boundary = lineStartOf(text, statement.range[0]);
  for (const comment of comments.toReversed()) {
    if (comment.range[1] > boundary) {
      continue;
    }
    const gap = text.slice(comment.range[1], boundary);
    const commentLineStart = lineStartOf(text, comment.range[0]);
    if (
      gap.trim() !== "" ||
      gap.split("\n").length > 2 ||
      text.slice(commentLineStart, comment.range[0]).trim() !== ""
    ) {
      return false;
    }
    if (pattern.test(comment.value)) {
      return true;
    }
    boundary = commentLineStart;
  }
  return false;
};

const hasTaggedCommentInAncestors = (lookup: TaggedLookup): boolean => {
  let node = lookup.node;
  while (isAstNode(node)) {
    if (hasTaggedComment({ ...lookup, node })) {
      return true;
    }
    node = node.parent;
  }
  return false;
};

// --- Waits -------------------------------------------------------------------

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

const isFunctionNode = (node: unknown): node is AstNode =>
  isAstNode(node) && FUNCTION_TYPES.has(node.type);

// Every node under `root` that runs when `root` runs: nested functions are
// skipped, since their bodies run on their own schedule.
const ownNodes = (root: unknown): AstNode[] => {
  const out: AstNode[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isAstNode(current)) {
      continue;
    }
    out.push(current);
    if (current !== root && FUNCTION_TYPES.has(current.type)) {
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (key !== "parent" && typeof value === "object") {
        pending.push(value);
      }
    }
  }
  return out;
};

// Whether `node` names the runtime global `name`, not a local binding.
const isGlobalReference = (
  context: ScopeContext,
  node: unknown,
  name: string,
): boolean => {
  const expression = unwrapExpression(node);
  if (!isIdentifierReference(expression) || expression.name !== name) {
    return false;
  }
  const variable = resolveVariable(context, expression);
  return variable === null || variable.defs.length === 0;
};

// `name`, `globalThis.name` or `window.name`, as the runtime global.
const isGlobalFunction = (
  context: ScopeContext,
  node: unknown,
  name: string,
): boolean => {
  const expression = unwrapExpression(node);
  if (isGlobalReference(context, expression, name)) {
    return true;
  }
  return (
    isAstNode(expression) &&
    expression.type === "MemberExpression" &&
    memberPropertyName(expression) === name &&
    (isGlobalReference(context, expression.object, "globalThis") ||
      isGlobalReference(context, expression.object, "window"))
  );
};

/** A real-clock wait: how it is spelled, and whether fake timers drive it. */
type Wait = { pattern: string; fakeable: boolean };

// Imported functions that resolve after a real delay, by module. `true` marks
// those built on the global `setTimeout`, which fake timers replace.
const SLEEP_EXPORTS: ReadonlyMap<
  string,
  ReadonlyMap<string, boolean>
> = new Map([
  [
    "node:timers/promises",
    new Map([
      ["setTimeout", false],
      ["setInterval", false],
    ]),
  ],
  [
    "timers/promises",
    new Map([
      ["setTimeout", false],
      ["setInterval", false],
    ]),
  ],
  [
    "bun",
    new Map([
      ["sleep", false],
      ["sleepSync", false],
    ]),
  ],
  ["@stll/concurrency/sleep", new Map([["sleep", true]])],
]);

const BUN_SLEEPS: ReadonlySet<string> = new Set(["sleep", "sleepSync"]);

// A `new Promise(executor)` whose executor, when it runs, calls one of the
// global `timers`, e.g. `new Promise((resolve) => setTimeout(resolve, 5))`.
const promiseScheduledBy = (
  context: ScopeContext,
  node: AstNode,
  timers: readonly string[],
): string | null => {
  if (
    node.type !== "NewExpression" ||
    !isGlobalReference(context, node.callee, "Promise") ||
    !Array.isArray(node.arguments)
  ) {
    return null;
  }
  const executor = unwrapExpression(node.arguments.at(0));
  if (!isFunctionNode(executor)) {
    return null;
  }
  for (const inner of ownNodes(executor.body)) {
    if (inner.type !== "CallExpression") {
      continue;
    }
    const timer = timers.find((name) =>
      isGlobalFunction(context, inner.callee, name),
    );
    if (timer !== undefined) {
      return timer;
    }
  }
  return null;
};

// The real-clock wait a call or `new` expression performs, or null.
const realTimeWait = (context: ScopeContext, node: unknown): Wait | null => {
  if (!isAstNode(node)) {
    return null;
  }
  if (node.type === "NewExpression") {
    return promiseScheduledBy(context, node, ["setTimeout"]) === null
      ? null
      : { pattern: "new Promise(setTimeout)", fakeable: true };
  }
  if (node.type !== "CallExpression") {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (!isAstNode(callee)) {
    return null;
  }
  if (callee.type === "MemberExpression") {
    const property = memberPropertyName(callee);
    if (property === "waitForTimeout") {
      return { pattern: "waitForTimeout", fakeable: false };
    }
    if (
      property !== null &&
      BUN_SLEEPS.has(property) &&
      isGlobalReference(context, callee.object, "Bun")
    ) {
      return { pattern: `Bun.${property}`, fakeable: false };
    }
  }
  const binding = resolveImportedExpressionForEnforcement(context, callee);
  const fakeable =
    binding === null
      ? undefined
      : SLEEP_EXPORTS.get(binding.source)?.get(binding.imported);
  if (binding === null || fakeable === undefined) {
    return null;
  }
  return { pattern: `${binding.source}#${binding.imported}`, fakeable };
};

// `jest.useFakeTimers()` / `vi.useFakeTimers()`: the file replaces the global
// timers, so a `setTimeout`-built wait in it runs when the test advances them.
const installsFakeTimers = (context: ScopeContext, node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (
    !isAstNode(callee) ||
    callee.type !== "MemberExpression" ||
    memberPropertyName(callee) !== "useFakeTimers"
  ) {
    return false;
  }
  const binding = resolveImportedExpressionForEnforcement(
    context,
    callee.object,
  );
  return (
    binding !== null &&
    ((binding.source === "bun:test" && binding.imported === "jest") ||
      (binding.source === "vitest" &&
        (binding.imported === "vi" || binding.imported === "vitest")))
  );
};

const WAIT_HINT = /sleep|setTimeout|setInterval|waitForTimeout/u;

// --- Polling loops -----------------------------------------------------------

const TICK_SCHEDULERS = [
  "queueMicrotask",
  "requestAnimationFrame",
  "setImmediate",
] as const;

const TICK_EXPORTS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["node:timers/promises", new Set(["setImmediate"])],
  ["timers/promises", new Set(["setImmediate"])],
]);

// A yield to the scheduler rather than to the work.
const isSchedulerTick = (context: ScopeContext, node: AstNode): boolean => {
  if (node.type === "NewExpression") {
    return promiseScheduledBy(context, node, TICK_SCHEDULERS) !== null;
  }
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  if (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    memberPropertyName(callee) === "resolve" &&
    isGlobalReference(context, callee.object, "Promise")
  ) {
    // `await Promise.resolve()` yields a tick; `Promise.resolve(value)` is a
    // value a fake hands back.
    return (
      Array.isArray(node.arguments) &&
      node.arguments.length === 0 &&
      isAstNode(node.parent) &&
      node.parent.type === "AwaitExpression"
    );
  }
  const binding = resolveImportedExpressionForEnforcement(context, callee);
  return (
    binding !== null &&
    TICK_EXPORTS.get(binding.source)?.has(binding.imported) === true
  );
};

// The function a callee names when this file declares it: a function
// declaration, or a binding assigned once to a function expression.
const localFunction = (
  context: ScopeContext,
  callee: unknown,
): AstNode | null => {
  const expression = unwrapExpression(callee);
  if (isFunctionNode(expression)) {
    return expression;
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  const definition = variable?.defs.at(0);
  if (variable === null || definition === undefined) {
    return null;
  }
  if (definition.type === "FunctionName") {
    return isFunctionNode(definition.node) ? definition.node : null;
  }
  const initializer = unwrapExpression(stableInitializer(variable));
  return isFunctionNode(initializer) ? initializer : null;
};

const invokesCallback = (context: ScopeContext, callee: unknown): boolean => {
  const binding = resolveImportedExpressionForEnforcement(context, callee);
  return (
    binding?.imported === "act" &&
    (binding.source === "react" ||
      binding.source === "react-dom/test-utils" ||
      binding.source === "@testing-library/react")
  );
};

// Whether running `root` waits on the clock or the scheduler, directly, in a
// callback it passes, or through a function of this file it calls.
const waitsOnClock = (
  context: ScopeContext,
  root: unknown,
  seen = new Set<AstNode>(),
): boolean =>
  ownNodes(root).some((node) => {
    if (
      realTimeWait(context, node) !== null ||
      isSchedulerTick(context, node)
    ) {
      return true;
    }
    if (node.type !== "CallExpression") {
      return false;
    }
    const invoked = [
      node.callee,
      ...(invokesCallback(context, node.callee) && Array.isArray(node.arguments)
        ? node.arguments.slice(0, 1)
        : []),
    ];
    return invoked.some((callee) => {
      const helper = localFunction(context, callee);
      if (helper === null || seen.has(helper)) {
        return false;
      }
      seen.add(helper);
      return waitsOnClock(context, helper.body, seen);
    });
  });

const LOOP_PATTERNS: ReadonlyMap<string, string> = new Map([
  ["DoWhileStatement", "do-while"],
  ["ForStatement", "for"],
  ["WhileStatement", "while"],
]);

// Only a break whose target encloses this loop can stop this loop. A break
// captured by an inner loop, switch or label leaves the outer flush running.
const breakExitsLoop = (node: AstNode, loop: AstNode): boolean => {
  const label = unwrapExpression(node.label);
  let current = node.parent;
  while (isAstNode(current)) {
    if (isIdentifier(label)) {
      if (
        current.type === "LabeledStatement" &&
        isIdentifier(current.label, label.name)
      ) {
        let enclosing: unknown = loop;
        while (isAstNode(enclosing)) {
          if (enclosing === current) {
            return true;
          }
          enclosing = enclosing.parent;
        }
        return false;
      }
    } else if (
      LOOP_PATTERNS.has(current.type) ||
      current.type === "ForOfStatement" ||
      current.type === "ForInStatement" ||
      current.type === "SwitchStatement"
    ) {
      return current === loop;
    }
    current = current.parent;
  }
  return false;
};

const hasConditionalExit = (loop: AstNode): boolean =>
  ownNodes(loop.body).some((node) => {
    if (
      node.type !== "ReturnStatement" &&
      node.type !== "ThrowStatement" &&
      (node.type !== "BreakStatement" || !breakExitsLoop(node, loop))
    ) {
      return false;
    }
    let current = node.parent;
    while (isAstNode(current) && current !== loop) {
      if (current.type === "IfStatement") {
        return true;
      }
      current = current.parent;
    }
    return false;
  });

const COUNTER_OPERATORS: ReadonlySet<string> = new Set(["<", "<=", ">", ">="]);

const advancesCounter = (positions: unknown, name: string): boolean =>
  ownNodes(positions).some(
    (node) =>
      (node.type === "UpdateExpression" &&
        isIdentifier(unwrapExpression(node.argument), name)) ||
      (node.type === "AssignmentExpression" &&
        (node.operator === "+=" || node.operator === "-=") &&
        isIdentifier(unwrapExpression(node.left), name)),
  );

// A bound read without waiting: `3`, `max`, `items.length`,
// `action.intervals`, `Number(count) + 2`.
const isCountBound = (node: unknown): boolean =>
  isAstNode(node) &&
  ownNodes(node).every((inner) => inner.type !== "AwaitExpression");

// `i < 3`, `attempt <= max + 1`: a counter the loop itself advances, compared
// with a bound it reads without waiting. Such a loop runs a fixed number of
// passes whatever the system under test does.
const isCounterTest = (loop: AstNode): boolean => {
  const test = unwrapExpression(loop.test);
  if (
    !isAstNode(test) ||
    test.type !== "BinaryExpression" ||
    typeof test.operator !== "string" ||
    !COUNTER_OPERATORS.has(test.operator)
  ) {
    return false;
  }
  const positions = [
    loop.body,
    loop.type === "ForStatement" ? loop.update : null,
  ];
  return [
    [test.left, test.right],
    [test.right, test.left],
  ].some(([counter, bound]) => {
    const name = unwrapExpression(counter);
    return (
      isIdentifier(name) &&
      isCountBound(bound) &&
      advancesCounter(positions, name.name)
    );
  });
};

const isTrueLiteral = (node: unknown): boolean => {
  const test = unwrapExpression(node);
  return isAstNode(test) && test.type === "Literal" && test.value === true;
};

// Whether a predicate, not a pass count, decides when the loop stops.
const stopsOnPredicate = (loop: AstNode): boolean =>
  hasConditionalExit(loop) ||
  (isAstNode(loop.test) && !isTrueLiteral(loop.test) && !isCounterTest(loop));

const POLL_HINT =
  /sleep|setTimeout|setInterval|setImmediate|waitForTimeout|queueMicrotask|requestAnimationFrame|Promise\.resolve/u;

// --- Raised timeouts ---------------------------------------------------------

const BUN_TEST_MODULE = "bun:test";
const BUN_DEFAULT_TIMEOUT_MS = 5000;

const TIMEOUT_REASON = new RegExp(
  `${taggedComment(["timeout"]).source}|^\\s*quarantine:\\s*#\\d+`,
  "u",
);

// Where a `bun:test` export takes its timeout: the argument index of the
// number or `{ timeout }` option.
const BUN_TIMEOUT_ARGUMENT: ReadonlyMap<string, number> = new Map([
  ["afterAll", 1],
  ["afterEach", 1],
  ["beforeAll", 1],
  ["beforeEach", 1],
  ["it", 2],
  ["test", 2],
]);

// Budgets the property-testing convention computes and owns.
const OWNED_TIMEOUT_HELPERS: ReadonlySet<string> = new Set([
  "propertyTestDefaultTimeout",
  "propertyTestTimeout",
]);

// The `bun:test` export a call's callee chain reaches through member and call
// modifiers (`test.each(table)`, `test.if(condition)`, `bt.test.serial`).
const bunTestExport = (
  context: ScopeContext,
  callee: unknown,
): string | null => {
  let current = unwrapExpression(callee);
  while (isAstNode(current)) {
    const binding = resolveImportedExpressionForEnforcement(context, current);
    if (binding !== null) {
      return binding.source === BUN_TEST_MODULE ? binding.imported : null;
    }
    if (current.type === "MemberExpression") {
      current = unwrapExpression(current.object);
    } else if (current.type === "CallExpression") {
      current = unwrapExpression(current.callee);
    } else {
      return null;
    }
  }
  return null;
};

const ARITHMETIC: Readonly<Record<string, (a: number, b: number) => number>> = {
  "*": (a, b) => a * b,
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "/": (a, b) => a / b,
};

// The number an expression always evaluates to, or null when it cannot be
// read statically: literals, `const` bindings, and arithmetic over them.
const staticNumber = (
  context: ScopeContext,
  node: unknown,
  seen = new Set<unknown>(),
): number | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression) || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  if (expression.type === "Literal") {
    return typeof expression.value === "number" ? expression.value : null;
  }
  if (isIdentifierReference(expression)) {
    const variable = resolveVariable(context, expression);
    return variable === null
      ? null
      : staticNumber(context, stableInitializer(variable), seen);
  }
  if (
    expression.type === "BinaryExpression" &&
    typeof expression.operator === "string"
  ) {
    const apply = Object.hasOwn(ARITHMETIC, expression.operator)
      ? ARITHMETIC[expression.operator]
      : undefined;
    const left = staticNumber(context, expression.left, seen);
    const right = staticNumber(context, expression.right, seen);
    return apply === undefined || left === null || right === null
      ? null
      : apply(left, right);
  }
  return null;
};

const isOwnedTimeoutHelper = (
  context: ScopeContext,
  node: unknown,
): boolean => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression) || expression.type !== "CallExpression") {
    return false;
  }
  const binding = resolveImportedExpressionForEnforcement(
    context,
    expression.callee,
  );
  return (
    binding?.source === "@stll/property-testing" &&
    OWNED_TIMEOUT_HELPERS.has(binding.imported)
  );
};

// Whether a timeout value raises the budget above Bun's default, or cannot be
// read and so may.
const raisesTimeout = (context: ScopeContext, node: unknown): boolean => {
  if (isOwnedTimeoutHelper(context, node)) {
    return false;
  }
  const value = staticNumber(context, node);
  return value === null || value > BUN_DEFAULT_TIMEOUT_MS;
};

const optionValue = (options: AstNode, key: string): unknown => {
  if (!Array.isArray(options.properties)) {
    return undefined;
  }
  for (const property of options.properties) {
    if (
      isAstNode(property) &&
      property.type === "Property" &&
      property.computed !== true &&
      (isIdentifier(property.key, key) ||
        (isAstNode(property.key) && property.key.value === key))
    ) {
      return property.value;
    }
  }
  return undefined;
};

type RaisedTimeout = { node: unknown; pattern: string };

// The raised timeout or retry a `bun:test` timeout argument carries.
const raisedBunTimeout = (
  context: ScopeContext,
  argument: unknown,
  name: string,
): RaisedTimeout | null => {
  const value = unwrapExpression(argument);
  if (!isAstNode(value)) {
    return null;
  }
  if (value.type !== "ObjectExpression") {
    return raisesTimeout(context, value)
      ? { node: value, pattern: `${name} timeout` }
      : null;
  }
  const timeout = optionValue(value, "timeout");
  if (timeout !== undefined && raisesTimeout(context, timeout)) {
    return { node: timeout, pattern: `${name} timeout` };
  }
  const retry = optionValue(value, "retry");
  const retries = retry === undefined ? 0 : staticNumber(context, retry);
  return retries === 0
    ? null
    : { node: retry ?? value, pattern: `${name} retry` };
};

const PLAYWRIGHT_TEST_ROOTS: ReadonlySet<string> = new Set([
  "test",
  "testInfo",
]);

// The identifier a member/call chain starts from: `test` in
// `test.info().setTimeout`, `testInfo` in `testInfo.setTimeout`.
const chainRootIdentifier = (
  node: unknown,
): (AstNode & { type: "Identifier"; name: string }) | null => {
  let current = unwrapExpression(node);
  while (isAstNode(current)) {
    if (isIdentifier(current)) {
      return current;
    }
    if (current.type === "MemberExpression") {
      current = unwrapExpression(current.object);
    } else if (current.type === "CallExpression") {
      current = unwrapExpression(current.callee);
    } else {
      return null;
    }
  }
  return null;
};

const chainRoot = (node: unknown): string | null =>
  chainRootIdentifier(node)?.name ?? null;

// A Playwright test-level timeout or retry change.
const raisedPlaywrightTimeout = (call: AstNode): RaisedTimeout | null => {
  const callee = unwrapExpression(call.callee);
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return null;
  }
  const root = chainRoot(callee.object);
  if (root === null || !PLAYWRIGHT_TEST_ROOTS.has(root)) {
    return null;
  }
  const method = memberPropertyName(callee);
  if (method === "setTimeout") {
    return { node: call, pattern: `${root}.setTimeout` };
  }
  if (method === "slow" && root === "test") {
    return { node: call, pattern: "test.slow" };
  }
  const options = Array.isArray(call.arguments)
    ? unwrapExpression(call.arguments.at(0))
    : null;
  if (
    method === "configure" &&
    isAstNode(options) &&
    options.type === "ObjectExpression" &&
    (optionValue(options, "timeout") !== undefined ||
      optionValue(options, "retries") !== undefined)
  ) {
    return { node: call, pattern: "test.describe.configure" };
  }
  return null;
};

// The raised timeout a call sets, if any.
const raisedTimeout = (
  context: ScopeContext,
  call: AstNode,
): RaisedTimeout | null => {
  const args = Array.isArray(call.arguments) ? call.arguments : [];
  const name = bunTestExport(context, call.callee);
  if (name === "setDefaultTimeout") {
    return raisesTimeout(context, args.at(0))
      ? { node: call, pattern: "setDefaultTimeout" }
      : null;
  }
  if (name === "jest") {
    const callee = unwrapExpression(call.callee);
    return isAstNode(callee) &&
      callee.type === "MemberExpression" &&
      memberPropertyName(callee) === "setTimeout" &&
      raisesTimeout(context, args.at(0))
      ? { node: call, pattern: "jest.setTimeout" }
      : null;
  }
  const index = name === null ? undefined : BUN_TIMEOUT_ARGUMENT.get(name);
  if (name !== null && index !== undefined) {
    const optionsFirst = unwrapExpression(args.at(1));
    return (
      raisedBunTimeout(context, args.at(index), name) ??
      (index === 2 &&
      isAstNode(optionsFirst) &&
      optionsFirst.type === "ObjectExpression"
        ? raisedBunTimeout(context, optionsFirst, name)
        : null)
    );
  }
  return name === null ? raisedPlaywrightTimeout(call) : null;
};

const memberChainNames = (node: unknown): string[] => {
  const names: string[] = [];
  let current = unwrapExpression(node);
  while (isAstNode(current) && current.type === "MemberExpression") {
    const name = memberPropertyName(current);
    if (name === null) {
      return [];
    }
    names.unshift(name);
    current = unwrapExpression(current.object);
  }
  if (isIdentifier(current)) {
    names.unshift(current.name);
  } else if (isAstNode(current) && current.type === "CallExpression") {
    names.unshift(...memberChainNames(current.callee));
  }
  return names;
};

// A DOM wait may outlast the shared hang guard when its subject runs on the
// real clock; `reasonable` marks the sites that can say so with a reason.
type LiteralWaitTimeout = {
  node: AstNode;
  pattern: string;
  reasonable: boolean;
};

const literalTimeoutOption = (
  options: unknown,
  pattern: string,
  mode: "any" | "bare-number",
): LiteralWaitTimeout | null => {
  const object = unwrapExpression(options);
  if (!isAstNode(object) || object.type !== "ObjectExpression") {
    return null;
  }
  const timeout = optionValue(object, "timeout");
  const node = unwrapExpression(timeout);
  if (!isAstNode(node)) {
    return null;
  }
  if (mode === "any") {
    return { node, pattern, reasonable: true };
  }
  const isBareNumber = (candidate: unknown): boolean => {
    const expression = unwrapExpression(candidate);
    if (!isAstNode(expression)) {
      return false;
    }
    return (
      (expression.type === "Literal" && typeof expression.value === "number") ||
      (expression.type === "BinaryExpression" &&
        typeof expression.operator === "string" &&
        Object.hasOwn(ARITHMETIC, expression.operator) &&
        isBareNumber(expression.left) &&
        isBareNumber(expression.right))
    );
  };
  return isBareNumber(node) ? { node, pattern, reasonable: false } : null;
};

const literalWaitTimeout = (
  context: ScopeContext,
  call: AstNode,
): LiteralWaitTimeout | null => {
  const args = Array.isArray(call.arguments) ? call.arguments : [];
  const names = memberChainNames(call.callee);
  const method = names.at(-1);
  if (method === undefined) {
    return null;
  }
  if (method === "waitFor" || method === "waitForElementToBeRemoved") {
    return literalTimeoutOption(args.at(1), method, "any");
  }
  if (/^find(?:All)?By\p{Lu}/u.test(method)) {
    return literalTimeoutOption(args.at(2), method, "any");
  }
  // The chain's root binding, so an aliased `expect` import still counts.
  const expectBinding = resolveImportedExpressionForEnforcement(
    context,
    chainRootIdentifier(call.callee),
  );
  const playwrightExpect =
    expectBinding?.imported === "expect" &&
    (expectBinding.source === "@playwright/test" ||
      /(?:^|\/)helpers\/test$/u.test(expectBinding.source));
  if (playwrightExpect && method === "poll" && names.length === 2) {
    return literalTimeoutOption(args.at(1), "expect.poll", "bare-number");
  }
  if (playwrightExpect && (method === "toPass" || /^to\p{Lu}/u.test(method))) {
    return literalTimeoutOption(args.at(-1), method, "bare-number");
  }
  return null;
};

type WaitSite = { node: ESTree.Node; wait: Wait };

export default eslintCompatPlugin({
  meta: { name: "test-timing" },
  rules: {
    [REAL_TIME_WAIT_RULE]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          wait:
            "`{{pattern}}` waits on the real clock, so this test guesses how " +
            "long the work takes. Await the work's own completion signal (the " +
            "promise it returns, a `Promise.withResolvers` it settles, an " +
            "event) or drive fake timers; when real time is the behaviour " +
            "under test, say so with `// real-time: <reason>`. Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker(REAL_TIME_WAIT_RULE);
        let sites: WaitSite[] = [];
        let fakeTimers = false;
        let hinted = false;
        let comments: readonly SourceComment[] | null = null;

        const record = (node: ESTree.Node) => {
          const wait = realTimeWait(context, node);
          if (wait === null) {
            return;
          }
          comments ??= context.sourceCode
            .getAllComments()
            .filter(isSourceComment);
          if (
            !hasTaggedComment({
              comments,
              node,
              pattern: REAL_TIME_REASON,
              text: context.sourceCode.text,
            })
          ) {
            sites.push({ node, wait });
          }
        };

        return {
          before() {
            tracker.reset(filenameForContext(context));
            sites = [];
            fakeTimers = false;
            hinted = WAIT_HINT.test(context.sourceCode.text);
            comments = null;
          },
          CallExpression(node) {
            fakeTimers ||= installsFakeTimers(context, node);
            if (hinted) {
              record(node);
            }
          },
          NewExpression(node) {
            if (hinted) {
              record(node);
            }
          },
          "Program:exit"(node) {
            for (const { node: site, wait } of sites) {
              if (fakeTimers && wait.fakeable) {
                continue;
              }
              const report = tracker.record(site, wait.pattern, "wait");
              if (report !== null) {
                context.report({ node: site, ...report });
              }
            }
            for (const report of tracker.stale()) {
              context.report({ node, ...report });
            }
          },
        };
      },
    },
    [POLLING_LOOP_RULE]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          poll:
            "This `{{pattern}}` loop polls: it waits on the clock or the " +
            "scheduler until a condition holds, so it passes or fails with " +
            "the machine's load. Await the signal that makes the condition " +
            "true (the promise the work returns, a `Promise.withResolvers` it " +
            "settles, an event); when real time is the behaviour under test, " +
            "say so with `// real-time: <reason>`. Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker(POLLING_LOOP_RULE);
        let hinted = false;
        let comments: readonly SourceComment[] | null = null;

        const check = (loop: ESTree.Node) => {
          const node: unknown = loop;
          const pattern = LOOP_PATTERNS.get(loop.type);
          if (
            !hinted ||
            pattern === undefined ||
            !isAstNode(node) ||
            !stopsOnPredicate(node) ||
            !waitsOnClock(context, [
              node.body,
              node.test,
              node.type === "ForStatement" ? node.update : null,
            ])
          ) {
            return;
          }
          comments ??= context.sourceCode
            .getAllComments()
            .filter(isSourceComment);
          if (
            hasTaggedComment({
              comments,
              node,
              pattern: REAL_TIME_REASON,
              text: context.sourceCode.text,
            })
          ) {
            return;
          }
          const report = tracker.record(loop, pattern, "poll");
          if (report !== null) {
            context.report({ node: loop, ...report });
          }
        };

        return {
          before() {
            tracker.reset(filenameForContext(context));
            hinted = POLL_HINT.test(context.sourceCode.text);
            comments = null;
          },
          DoWhileStatement: check,
          ForStatement: check,
          WhileStatement: check,
          "Program:exit"(node) {
            for (const report of tracker.stale()) {
              context.report({ node, ...report });
            }
          },
        };
      },
    },
    [TIMEOUT_RULE]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          timeout:
            "`{{pattern}}` raises this test's budget above the default, which " +
            "hides a wait that should end on the work's own signal. Remove " +
            "it and await the milestone, or say why the test needs it with " +
            "`// timeout: <reason>` (or `// quarantine: #<issue>`). Ledger key: {{key}}",
          stale: STALE_MESSAGE,
        },
      },
      createOnce(context) {
        const tracker = budgetTracker(TIMEOUT_RULE);
        let comments: readonly SourceComment[] | null = null;

        return {
          before() {
            tracker.reset(filenameForContext(context));
            comments = null;
          },
          CallExpression(call) {
            const node: unknown = call;
            if (!isAstNode(node)) {
              return;
            }
            const raised = raisedTimeout(context, node);
            if (raised === null) {
              return;
            }
            comments ??= context.sourceCode
              .getAllComments()
              .filter(isSourceComment);
            if (
              hasTaggedComment({
                comments,
                node: raised.node,
                pattern: TIMEOUT_REASON,
                text: context.sourceCode.text,
              }) ||
              hasTaggedCommentInAncestors({
                comments,
                node,
                pattern: TIMEOUT_REASON,
                text: context.sourceCode.text,
              })
            ) {
              return;
            }
            const report = tracker.record(call, raised.pattern, "timeout");
            if (report !== null) {
              context.report({ node: call, ...report });
            }
          },
          "Program:exit"(node) {
            for (const report of tracker.stale()) {
              context.report({ node, ...report });
            }
          },
        };
      },
    },
    [LITERAL_WAIT_TIMEOUT_RULE]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          timeout:
            "`{{pattern}}` uses a disallowed per-call timeout. DOM condition waits use the suite's shared hang guard unless `// real-time: <reason>` says why the subject outlasts it; Playwright waits express numeric budgets as named constants.",
        },
      },
      createOnce(context) {
        let comments: readonly SourceComment[] | null = null;
        return {
          before() {
            comments = null;
          },
          CallExpression(call) {
            const node: unknown = call;
            if (!isAstNode(node)) {
              return;
            }
            const timeout = literalWaitTimeout(context, node);
            if (timeout === null) {
              return;
            }
            comments ??= context.sourceCode
              .getAllComments()
              .filter(isSourceComment);
            if (
              timeout.reasonable &&
              hasTaggedCommentInAncestors({
                comments,
                node: timeout.node,
                pattern: REAL_TIME_REASON,
                text: context.sourceCode.text,
              })
            ) {
              return;
            }
            context.report({
              node: timeout.node,
              messageId: "timeout",
              data: { pattern: timeout.pattern },
            });
          },
        };
      },
    },
  },
});
