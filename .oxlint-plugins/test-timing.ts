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
  filenameForContext,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  memberPropertyName,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  unwrapExpression,
} from "./utils.ts";

const REAL_TIME_WAIT_RULE = "no-real-time-wait";
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
  node: AstNode;
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
  },
});
