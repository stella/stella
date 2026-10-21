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
// Existing sites are budgeted per file, enclosing function and spelling in
// scripts/test-timing-ledger.json (no line numbers, a reason per row). A hit
// beyond its budget is reported, and so is a budget the code no longer
// reaches. Regenerate with `bun scripts/test-timing-ledger.ts --write`.

import { eslintCompatPlugin, type ESTree } from "@oxlint/plugins";

import ledger from "../scripts/test-timing-ledger.json" with { type: "json" };
import { createBudgetLedger } from "./budget-ledger.ts";
import {
  type AstNode,
  type ScopeContext,
  everyNode,
  filenameForContext,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";

const REAL_TIME_WAIT_RULE = "no-real-time-wait";
const POLLING_LOOP_RULE = "no-polling-loop";
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
const installsFakeTimers = (node: unknown): boolean => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrapExpression(node.callee);
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    memberPropertyName(callee) === "useFakeTimers" &&
    (isIdentifier(unwrapExpression(callee.object), "jest") ||
      isIdentifier(unwrapExpression(callee.object), "vi"))
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

// Whether running `root` waits on the clock or the scheduler, directly, in a
// callback it passes, or through a function of this file it calls.
const waitsOnClock = (
  context: ScopeContext,
  root: unknown,
  seen = new Set<AstNode>(),
): boolean =>
  everyNode(root).some((node) => {
    if (
      realTimeWait(context, node) !== null ||
      isSchedulerTick(context, node)
    ) {
      return true;
    }
    if (node.type !== "CallExpression") {
      return false;
    }
    const helper = localFunction(context, node.callee);
    if (helper === null || seen.has(helper)) {
      return false;
    }
    seen.add(helper);
    return waitsOnClock(context, helper.body, seen);
  });

const LOOP_PATTERNS: ReadonlyMap<string, string> = new Map([
  ["DoWhileStatement", "do-while"],
  ["ForStatement", "for"],
  ["WhileStatement", "while"],
]);

const EXIT_TYPES: ReadonlySet<string> = new Set([
  "BreakStatement",
  "ReturnStatement",
  "ThrowStatement",
]);

// A `break`, `return` or `throw` under an `if` of the loop's own body.
const hasConditionalExit = (body: unknown): boolean =>
  ownNodes(body).some(
    (node) =>
      node.type === "IfStatement" &&
      ownNodes([node.consequent, node.alternate]).some((inner) =>
        EXIT_TYPES.has(inner.type),
      ),
  );

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
  hasConditionalExit(loop.body) ||
  (isAstNode(loop.test) && !isTrueLiteral(loop.test) && !isCounterTest(loop));

const POLL_HINT =
  /sleep|setTimeout|setInterval|setImmediate|waitForTimeout|queueMicrotask|requestAnimationFrame|Promise\.resolve/u;

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
            fakeTimers ||= installsFakeTimers(node);
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
  },
});
