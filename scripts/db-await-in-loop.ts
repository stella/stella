#!/usr/bin/env bun
// Database round trips awaited once per loop iteration (the N+1 query shape),
// found with the TypeScript type checker instead of by the spelling of a
// receiver. A handle renamed `database`, destructured out of a context, or
// narrowed to `Pick<typeof rootDb, "select">` is still a handle; a Redis
// client that happens to be called `db` is not one.
//
// Contract: one JavaScript `Program` over the API's source and scripts
// projects (`apps/api/tsconfig.json` plus `apps/api/tsconfig.scripts.json`,
// which extends it). Tests, `apps/api/src/tests/`, and the development seed
// scripts are out of scope: their loop lengths are a fixture's, not a
// tenant's. No other workspace holds a Drizzle handle.
//
// Recognition is by type provenance and capability, never by name:
//   - A HANDLE is a value whose type has a database member (`select`,
//     `insert`, `update`, `delete`, `execute`, `transaction`, `query`, ...)
//     declared by a Drizzle database or transaction class, or by one of the
//     handle modules below; a `Pick` or partial interface derived from those
//     keeps the declarations and so counts too. A structural adapter whose
//     database-named member takes a Drizzle-declared argument (`PgTable`,
//     `SQL`, `SQLWrapper`, `PgUpdateSetSource`, ...) counts by that argument.
//     A Drizzle relational query builder (`tx.query.users`) is a handle as
//     well, and so is any wrapper whose `transaction` member is a runner.
//   - A RUNNER is a callable with a callback parameter whose first parameter
//     is a handle: `scopedDb`, `safeDb`, the ingestion and public-reader
//     boundaries, `db.transaction`. Invoking it opens one transaction.
//   - An EXECUTED QUERY is an awaited value whose `then` is Drizzle's (a
//     fluent select/insert/update/delete, a relational query, a raw
//     `execute`), a `.execute()`/`.then()` on one, a runner invocation, or an
//     awaited thenable at the end of a chain that starts at a handle's
//     database member (a structural adapter's own builders).
//     Building a query without executing it is not a round trip.
//
// A site is flagged when, inside a loop position that re-runs per iteration
// (a loop body, a `while`/`do` test, a `for` test or update), or inside the
// callback of `Promise.all(items.map(...))`, an awaited expression (or
// `yield* Result.await(...)`) is:
//   - an executed query or a runner invocation ("query");
//   - a call that receives a handle or runner as an argument, directly or in
//     an object literal ("handle"). This is a conservative candidate, as it
//     was for the lexical rule: a helper that takes a handle may not query;
//   - a call to a function in this program whose body issues one of the two
//     shapes above within two hops ("helper"). A function that captures a
//     handle instead of taking it as a parameter is found this way.
// `Promise.all(items.map(cb))` / `Promise.allSettled(...)` is concurrent
// N-query fan-out and is flagged as one site on its own `await`, whether the
// callback is inline or named, and whether or not it awaits inside. A
// literal array (`Promise.all([a(tx), b(tx)])`) has a fixed length and is not
// fan-out. A site whose statement is a `return`/`throw`, or is followed in its
// statement list by an exit from the loop, runs once per loop and is not
// flagged when no `try` with a `catch` or `finally` can override the exit.
// A return-site or an immediately following exit is independent of unrelated
// continues; a later exit still requires no `continue` targeting the loop.
// One DB hit per constant-bounded round is exempt: canonical chunk inputs
// (literal/const size >= 2), array slice-step loops with that stride, fixed
// sets of at most 16 elements, and nonnegative constant-start counters bounded by <= 16.
// The counter must not be written in the body. Multiple DB hits, fan-out,
// enclosing loops or fan-out callbacks, dynamic sizes and keyset walks stay
// flagged; bounded rounds cannot hide per-row work in a nested loop.
// `items.forEach(async ...)` starts work without awaiting it and is
// not tracked, as before. A `Result.tryPromise` callback runs in place, so a
// loop around it is still the loop.
//
// Not claimed: transitive completeness. Calls through callback parameters,
// dynamic dispatch through interfaces, and helpers more than two hops away
// are not followed. A site whose awaited value, callee, or receiver resolves
// to `any`/`unknown` is not certified clean either: it is printed as
// "unclassified" instead.
//
// Suppression, with a reason that says why the sequence is required:
//   // db-await-in-loop: <reason>            the next code line (comment lines
//                                            in between are skipped), or this
//                                            line when trailing code
//   // db-await-in-loop-disable: <reason>    until
//   // db-await-in-loop-enable
// Directives are read from comment trivia, so one inside a template
// interpolation counts and text inside a string, template, or block comment
// does not. A directive that suppresses nothing is an error, like an unused
// lint directive. `scripts/ratchet.ts` budgets the directives through
// `countDbAwaitInLoopDirectives`, the same parse the check applies.
//
// Usage: bun scripts/db-await-in-loop.ts

import { panic } from "better-result";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import * as ts from "tsrs/unstable/ast";
import {
  API,
  type Checker,
  type Program,
  SignatureKind,
  type Symbol as CompilerSymbol,
  type Type,
  TypeFlags,
} from "tsrs/unstable/async";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";

import {
  type ParsedSource,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";
import { createProgram } from "../packages/scripts/src/typescript-program.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const API_PROJECTS = [
  "apps/api/tsconfig.json",
  "apps/api/tsconfig.scripts.json",
] as const;

// The modules that declare Stella's own handle and runner types. A member
// named like a database operation that is declared here is a handle member,
// whether or not its type still mentions Drizzle.
const API_HANDLE_DECLARATION_FILES = [
  "apps/api/src/db/root.ts",
  "apps/api/src/db/safe-db.ts",
  "apps/api/src/db/scoped.ts",
  "apps/api/src/lib/case-law-ingestion-db.ts",
] as const;

const API_SCOPE = /^apps\/api\/(?:src|scripts)\/.+\.ts$/u;
const API_SCOPE_EXCLUDED =
  /(?:\.d\.ts$|\.test\.ts$|\.spec\.ts$|^apps\/api\/src\/tests\/|^apps\/api\/scripts\/seed-[^/]*\.ts$)/u;

export const isApiSourceInScope = (relativePath: string): boolean =>
  API_SCOPE.test(relativePath) && !API_SCOPE_EXCLUDED.test(relativePath);

const HANDLE_MEMBER_NAMES = [
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "insert",
  "update",
  "delete",
  "execute",
  "transaction",
  "query",
  "with",
  "$count",
  "refreshMaterializedView",
] as const;

const HANDLE_MEMBER_NAME_SET: ReadonlySet<string> = new Set(
  HANDLE_MEMBER_NAMES,
);

// Handle members that run a statement when called, as opposed to starting a
// builder whose execution is decided by what happens to it next.
const EXECUTING_HANDLE_MEMBERS: ReadonlySet<string> = new Set([
  "execute",
  "transaction",
  "$count",
  "refreshMaterializedView",
]);

const QUERY_EXECUTION_MEMBERS: ReadonlySet<string> = new Set([
  "execute",
  "then",
  "catch",
  "finally",
]);

const DRIZZLE_FILE =
  /[\\/]node_modules[\\/](?:\.bun[\\/][^\\/]+[\\/]node_modules[\\/])?drizzle-orm[\\/]/u;
const DRIZZLE_HANDLE_CLASS = /(?:Database|Transaction)$/u;
const DRIZZLE_HANDLE_TYPE = /(?:Database|Transaction|RelationalQueryBuilder)$/u;

const MAP_LIKE_METHODS: ReadonlySet<string> = new Set([
  "map",
  "forEach",
  "flatMap",
]);
const PROMISE_FAN_OUT_METHODS: ReadonlySet<string> = new Set([
  "all",
  "allSettled",
]);

// A helper found at an awaited site is followed this many function bodies
// deep: its own body, and the body of one helper it calls.
const HELPER_HOPS = 2;

export type DbAwaitInLoopKind = "query" | "handle" | "helper";

export type DbAwaitInLoopHit = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: DbAwaitInLoopKind;
  readonly subject: string;
};

export type DbAwaitInLoopDirectiveProblem = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

export type DbAwaitInLoopUnclassified = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly subject: string;
};

export type DbAwaitInLoopReport = {
  readonly hits: readonly DbAwaitInLoopHit[];
  readonly suppressedHits: number;
  readonly boundedRoundHits: number;
  readonly directiveProblems: readonly DbAwaitInLoopDirectiveProblem[];
  readonly unclassified: readonly DbAwaitInLoopUnclassified[];
  readonly filesScanned: number;
  // Suppressions per file, counted from the same parse the check applied.
  readonly directiveCounts: Readonly<Record<string, number>>;
};

export type ScanDbAwaitInLoopOptions = {
  readonly program: Program;
  readonly checker: Checker;
  readonly repositoryRoot: string;
  readonly isInScope: (relativePath: string) => boolean;
  // Repository-relative paths of the modules that declare handle types.
  readonly handleDeclarationFiles: readonly string[];
};

type Match =
  | { readonly kind: "query" }
  | { readonly kind: "handle" | "helper"; readonly subject: string };

const QUERY_MATCH: Match = { kind: "query" };

type LoopContext = "loop" | "fan-out";

const toPosix = (file: string): string => file.replaceAll(path.sep, "/");

const hasModifiers = (node: ts.Node): node is ts.Node & ts.ModifiersBase =>
  "modifiers" in node;

const declarationsOf = async (
  symbol: CompilerSymbol | undefined,
): Promise<ts.Declaration[]> => {
  const declarations: ts.Declaration[] = [];
  for (const handle of symbol?.declarations ?? []) {
    const declaration = await handle.resolve();
    if (declaration === undefined) {
      panic("Missing symbol declaration");
    }
    declarations.push(declaration);
  }
  return declarations;
};

const someAsync = async <T>(
  values: readonly T[],
  predicate: (value: T) => boolean | Promise<boolean>,
): Promise<boolean> => {
  for (const value of values) {
    if (await predicate(value)) {
      return true;
    }
  }
  return false;
};

const everyAsync = async <T>(
  values: readonly T[],
  predicate: (value: T) => boolean | Promise<boolean>,
): Promise<boolean> => {
  for (const value of values) {
    if (!(await predicate(value))) {
      return false;
    }
  }
  return true;
};

const childrenAsync = async <T>(
  node: ts.Node,
  visit: (child: ts.Node) => Promise<T>,
): Promise<T | undefined> => {
  const children: ts.Node[] = [];
  node.forEachChild((child) => {
    children.push(child);
  });
  for (const child of children) {
    const value = await visit(child);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const isImportAlias = async (symbol: CompilerSymbol): Promise<boolean> =>
  (await declarationsOf(symbol)).some(
    (declaration) =>
      ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportEqualsDeclaration(declaration) ||
      ts.isExportSpecifier(declaration),
  );

const unwrap = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertion(current)
  ) {
    current = current.expression;
  }
  return current;
};

// The nearest ancestor that is not a value-preserving wrapper of `node`.
const outerParent = (node: ts.Node): { parent: ts.Node; child: ts.Node } => {
  let child = node;
  let parent = node.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isTypeAssertion(parent)
  ) {
    child = parent;
    parent = parent.parent;
  }
  return { parent, child };
};

const subjectText = (node: ts.Node): string => {
  const text = node.getText().replaceAll(/\s+/gu, " ");
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

const isMemberCall = (
  node: ts.Node,
  object: string,
  names: ReadonlySet<string>,
): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === object &&
  names.has(node.expression.name.text);

const RESULT_AWAIT: ReadonlySet<string> = new Set(["await"]);
const RESULT_TRY_PROMISE: ReadonlySet<string> = new Set(["tryPromise"]);

const isPromiseFanOutCall = (node: ts.Node): node is ts.CallExpression =>
  isMemberCall(node, "Promise", PROMISE_FAN_OUT_METHODS);

const isMapLikeCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  MAP_LIKE_METHODS.has(node.expression.name.text);

type FunctionWithBody =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

const isFunctionBoundary = (node: ts.Node): node is FunctionWithBody =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node);

// The object-literal member `fn` is the value of, when it is one.
const tryPromiseProperty = (
  fn: ts.Node,
  parent: ts.Node,
  child: ts.Node,
): ts.PropertyAssignment | ts.MethodDeclaration | null => {
  if (ts.isPropertyAssignment(parent) && parent.initializer === child) {
    return parent;
  }
  if (ts.isMethodDeclaration(fn) && ts.isObjectLiteralExpression(fn.parent)) {
    return fn;
  }
  return null;
};

// `Result.tryPromise(async () => ...)` and `Result.tryPromise({ try: ... })`
// run the callback where it stands, so a loop around it is the callback's loop.
const isResultTryPromiseCallback = (fn: ts.Node): boolean => {
  const { parent, child } = outerParent(fn);
  if (isMemberCall(parent, "Result", RESULT_TRY_PROMISE)) {
    return parent.arguments.some((argument) => argument === child);
  }
  const property = tryPromiseProperty(fn, parent, child);
  if (
    property === null ||
    !ts.isIdentifier(property.name) ||
    property.name.text !== "try"
  ) {
    return false;
  }
  const { parent: call, child: literal } = outerParent(property.parent);
  return (
    isMemberCall(call, "Result", RESULT_TRY_PROMISE) &&
    call.arguments.some((argument) => argument === literal)
  );
};

// Is `fn` the callback of `items.map(...)` (or `forEach`/`flatMap`) whose
// call is itself an argument of `Promise.all(...)`/`Promise.allSettled(...)`?
const promiseFanOutOfCallback = (fn: ts.Node): ts.CallExpression | null => {
  const { parent: mapCall, child } = outerParent(fn);
  if (!isMapLikeCall(mapCall) || mapCall.arguments[0] !== child) {
    return null;
  }
  const { parent: fanOut, child: mapChild } = outerParent(mapCall);
  return isPromiseFanOutCall(fanOut) &&
    fanOut.arguments.some((argument) => argument === mapChild)
    ? fanOut
    : null;
};

const isPerIterationPosition = (loop: ts.Node, child: ts.Node): boolean => {
  if (ts.isForStatement(loop)) {
    return (
      loop.statement === child ||
      loop.condition === child ||
      loop.incrementor === child
    );
  }
  if (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) {
    return loop.statement === child;
  }
  if (ts.isWhileStatement(loop) || ts.isDoStatement(loop)) {
    return loop.statement === child || loop.expression === child;
  }
  return false;
};

// tsrs names the loop kinds but not their union.
type IterationStatement =
  | ts.DoStatement
  | ts.ForInStatement
  | ts.ForOfStatement
  | ts.ForStatement
  | ts.WhileStatement;

const isIterationStatement = (node: ts.Node): node is IterationStatement =>
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node);

// Does `jump` leave `loop`? An unlabelled `break` leaves the nearest loop or
// `switch`; a labelled one leaves the statement carrying its label.
const breaksOutOf = (jump: ts.BreakStatement, loop: ts.Node): boolean => {
  const label = jump.label?.text;
  let current: ts.Node = jump.parent;
  while (current !== loop && !ts.isSourceFile(current)) {
    if (isFunctionBoundary(current)) {
      return false;
    }
    if (
      label === undefined &&
      (isIterationStatement(current) || ts.isSwitchStatement(current))
    ) {
      return false;
    }
    current = current.parent;
  }
  if (current !== loop) {
    return false;
  }
  return (
    label === undefined ||
    (ts.isLabeledStatement(loop.parent) && loop.parent.label.text === label)
  );
};

// The loop a `continue` goes round again: the nearest loop, or the loop its
// label names. Null when it would have to cross a function boundary.
const continueTarget = (jump: ts.ContinueStatement): ts.Node | null => {
  const label = jump.label?.text;
  let current: ts.Node = jump.parent;
  while (!ts.isSourceFile(current)) {
    if (isFunctionBoundary(current)) {
      return null;
    }
    if (label === undefined && isIterationStatement(current)) {
      return current;
    }
    if (
      label !== undefined &&
      ts.isLabeledStatement(current) &&
      current.label.text === label
    ) {
      return current.statement;
    }
    current = current.parent;
  }
  return null;
};

// A continue targeting this loop can bypass a later exit when another
// statement intervenes. It cannot bypass the site's own or immediate exit.
const isContinuedAnywhere = (loop: ts.Node): boolean => {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || isFunctionBoundary(node)) {
      return;
    }
    if (ts.isContinueStatement(node) && continueTarget(node) === loop) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  loop.forEachChild(visit);
  return found;
};

const isLoopExit = (statement: ts.Statement, loop: ts.Node): boolean =>
  ts.isReturnStatement(statement) ||
  ts.isThrowStatement(statement) ||
  (ts.isBreakStatement(statement) && breaksOutOf(statement, loop));

// Is the site's statement itself a `return`/`throw`, or followed in its own
// statement list by an exit from `loop`? Then it runs at most once per run of
// the loop, however many iterations came before it:
// `if (failed) { await flush(); return; }`. Exempted only where nothing can
// bypass or override that exit: an intervening statement needs the absence
// of a loop-targeting continue, and a surrounding try cannot have a catch
// (a retry) or finally (which can replace the exit).
const leavesLoopAfter = (site: ts.Node, loop: ts.Node): boolean => {
  let statement: ts.Node = site;
  // `if (done) return await flush();` exits from inside the `if`.
  let exitsOnTheWay = false;
  while (
    statement.parent !== loop &&
    !ts.isBlock(statement.parent) &&
    !ts.isCaseClause(statement.parent) &&
    !ts.isDefaultClause(statement.parent)
  ) {
    statement = statement.parent;
    if (isFunctionBoundary(statement)) {
      return false;
    }
    exitsOnTheWay ||=
      ts.isReturnStatement(statement) || ts.isThrowStatement(statement);
  }
  // An exit inside a callback that runs in place (a `Result.tryPromise`
  // body) leaves the callback, not the loop. Inside a `try` with a `catch`, a
  // failing call skips the exit and the catch may go round again; a `finally`
  // can replace the exit with its own completion.
  for (let scope = statement.parent; scope !== loop; scope = scope.parent) {
    if (
      isFunctionBoundary(scope) ||
      ts.isSourceFile(scope) ||
      (ts.isTryStatement(scope) &&
        (scope.catchClause !== undefined || scope.finallyBlock !== undefined))
    ) {
      return false;
    }
  }
  if (exitsOnTheWay) {
    return true;
  }
  const owner = statement.parent;
  if (
    !ts.isBlock(owner) &&
    !ts.isCaseClause(owner) &&
    !ts.isDefaultClause(owner)
  ) {
    return false;
  }
  let after = false;
  let immediate = true;
  for (const entry of owner.statements) {
    if (!after) {
      after = entry === statement;
      continue;
    }
    if (isLoopExit(entry, loop) && (immediate || !isContinuedAnywhere(loop))) {
      return true;
    }
    immediate = false;
  }
  return false;
};

const findLoopContext = (
  site: ts.Node,
  exitSites: "include" | "exclude" = "exclude",
): {
  context: LoopContext;
  loop: IterationStatement | null;
  fanOut: ts.CallExpression | null;
} | null => {
  let child: ts.Node = site;
  let current: ts.Node = site.parent;
  while (!ts.isSourceFile(current)) {
    if (
      isIterationStatement(current) &&
      isPerIterationPosition(current, child) &&
      (exitSites === "include" || !leavesLoopAfter(site, current))
    ) {
      return { context: "loop", loop: current, fanOut: null };
    }
    if (ts.isClassStaticBlockDeclaration(current)) {
      return null;
    }
    if (isFunctionBoundary(current) && !isResultTryPromiseCallback(current)) {
      const fanOut = promiseFanOutOfCallback(current);
      return fanOut === null
        ? null
        : { context: "fan-out", loop: null, fanOut };
    }
    child = current;
    current = current.parent;
  }
  return null;
};

const resultAwaitArgument = (
  expression: ts.Expression,
): ts.Expression | null => {
  const call = unwrap(expression);
  if (!isMemberCall(call, "Result", RESULT_AWAIT)) {
    return null;
  }
  const [argument] = call.arguments;
  return call.arguments.length === 1 && argument !== undefined
    ? unwrap(argument)
    : null;
};

// Is `node` the outermost link of its call/member chain?
const isChainEnd = (node: ts.Node): boolean => {
  const { parent, child } = outerParent(node);
  return !(
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === child
  );
};

const isDirectAwaitOperand = (node: ts.Node): boolean => {
  const { parent } = outerParent(node);
  return ts.isAwaitExpression(parent);
};

// Positions where a query value is executed: awaited, returned (so the caller
// awaits it), handed to `Result.await`, or given to a `Promise` combinator.
const isExecutedPosition = (node: ts.Node): boolean => {
  const { parent, child } = outerParent(node);
  if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)) {
    return true;
  }
  if (ts.isArrowFunction(parent)) {
    return parent.body === child;
  }
  if (isMemberCall(parent, "Result", RESULT_AWAIT)) {
    return true;
  }
  if (isPromiseFanOutCall(parent)) {
    return true;
  }
  if (ts.isArrayLiteralExpression(parent)) {
    return isPromiseFanOutCall(outerParent(parent).parent);
  }
  return false;
};

type DirectiveKind = "line" | "disable" | "enable";

type Directive = {
  readonly kind: DirectiveKind;
  readonly line: number;
  readonly target: number;
  readonly reason: string;
  used: boolean;
};

type BlockRange = {
  readonly directive: Directive;
  readonly start: number;
  readonly end: number;
};

type FileDirectives = {
  readonly lines: readonly Directive[];
  readonly blocks: readonly BlockRange[];
  readonly problems: readonly DbAwaitInLoopDirectiveProblem[];
};

const DIRECTIVE_TOKEN = "db-await-in-loop";
const DIRECTIVE_BODY =
  /^[ \t]*db-await-in-loop(?<variant>-disable|-enable)?(?<rest>.*)$/u;

type DirectiveComment = {
  readonly line: number;
  // The line a next-line directive covers: its own when code precedes it,
  // otherwise the line of the first token after it.
  readonly target: number;
  readonly variant: string;
  readonly rest: string;
};

const directiveComments = (parsed: ParsedSource): DirectiveComment[] => {
  const { sourceText: text, comments, locate } = parsed;
  const tokenStarts: number[] = [];
  walk(parsed.program, (node) => {
    tokenStarts.push(node.start);
  });
  tokenStarts.sort((a, b) => a - b);
  const directives: DirectiveComment[] = [];
  for (const comment of comments) {
    if (comment.type !== "Line") {
      continue;
    }
    const match = DIRECTIVE_BODY.exec(comment.value);
    if (match === null) {
      continue;
    }
    const { line, column } = locate(comment.start);
    const lineStart = comment.start - column + 1;
    const trailing = text.slice(lineStart, comment.start).trim() !== "";
    const next = tokenStarts.find((position) => position >= comment.end);
    directives.push({
      line,
      target: trailing || next === undefined ? line : locate(next).line,
      variant: match.groups?.["variant"] ?? "",
      rest: match.groups?.["rest"] ?? "",
    });
  }
  return directives;
};

export const parseDirectives = (
  parsed: ParsedSource,
  file: string,
): FileDirectives => {
  if (!parsed.sourceText.includes(DIRECTIVE_TOKEN)) {
    return { lines: [], blocks: [], problems: [] };
  }
  const lines: Directive[] = [];
  const blocks: BlockRange[] = [];
  const problems: DbAwaitInLoopDirectiveProblem[] = [];
  let openBlock: Directive | null = null;

  for (const { line, target, variant, rest } of directiveComments(parsed)) {
    if (variant === "-enable") {
      if (rest.trim() !== "") {
        problems.push({
          file,
          line,
          message:
            "`// db-await-in-loop-enable` takes no text; put the reason on the matching disable",
        });
      }
      if (openBlock === null) {
        problems.push({
          file,
          line,
          message:
            "`// db-await-in-loop-enable` has no matching `// db-await-in-loop-disable: <reason>`",
        });
        continue;
      }
      blocks.push({ directive: openBlock, start: openBlock.line, end: line });
      openBlock = null;
      continue;
    }

    const reason = rest.startsWith(":") ? rest.slice(1).trim() : "";
    if (!rest.startsWith(":") || reason === "") {
      problems.push({
        file,
        line,
        message: `\`// ${DIRECTIVE_TOKEN}${variant}\` needs a reason: \`// ${DIRECTIVE_TOKEN}${variant}: <why the sequence is required>\``,
      });
      continue;
    }

    if (variant === "-disable") {
      if (openBlock !== null) {
        problems.push({
          file,
          line,
          message:
            "`// db-await-in-loop-disable` opened again before the previous one was closed",
        });
        continue;
      }
      openBlock = { kind: "disable", line, target: line, reason, used: false };
      continue;
    }

    lines.push({ kind: "line", line, target, reason, used: false });
  }

  if (openBlock !== null) {
    problems.push({
      file,
      line: openBlock.line,
      message:
        "`// db-await-in-loop-disable` is never closed with `// db-await-in-loop-enable`",
    });
  }
  return { lines, blocks, problems };
};

// The suppressions a file carries, as the check applies them: next-line and
// trailing directives plus each closed disable/enable block. The ratchet
// budgets exactly this count, so what it counts and what the check honours
// cannot drift apart.
const countParsedDirectives = (directives: FileDirectives): number =>
  directives.lines.length + directives.blocks.length;

export const countDbAwaitInLoopDirectives = (
  text: string,
  file: string,
): number => {
  if (!text.includes(DIRECTIVE_TOKEN)) {
    return 0;
  }
  return countParsedDirectives(parseDirectives(parseSource(file, text), file));
};

export const scanDbAwaitInLoop = async ({
  program,
  checker,
  repositoryRoot,
  isInScope,
  handleDeclarationFiles,
}: ScanDbAwaitInLoopOptions): Promise<DbAwaitInLoopReport> => {
  const handleFiles = new Set(
    handleDeclarationFiles.map((file) =>
      toPosix(path.resolve(repositoryRoot, file)),
    ),
  );

  // preserveSymlinks gives workspace imports a node_modules path; ownership
  // follows the physical source rather than that spelling.
  const chunkFile = toPosix(
    realpathSync(
      path.resolve(repositoryRoot, "packages/concurrency/src/chunk.ts"),
    ),
  );
  const symbolOf = async (
    expression: ts.Expression,
  ): Promise<CompilerSymbol | undefined> => {
    const symbol = await checker.getSymbolAtLocation(unwrap(expression));
    return symbol !== undefined && (await isImportAlias(symbol))
      ? await checker.getAliasedSymbol(symbol)
      : symbol;
  };
  const isConstDeclaration = (
    node: ts.Declaration,
  ): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    node.parent.getFirstToken()?.kind === ts.SyntaxKind.ConstKeyword;

  const isChunkHelper = async (
    expression: ts.Expression,
    seen = new Set<CompilerSymbol>(),
  ): Promise<boolean> => {
    const symbol = await symbolOf(expression);
    if (symbol === undefined || seen.has(symbol)) {
      return false;
    }
    seen.add(symbol);
    return await someAsync(
      await declarationsOf(symbol),
      async (declaration) => {
        if (
          symbol.name === "chunk" &&
          toPosix(realpathSync(declaration.getSourceFile().fileName)) ===
            chunkFile
        ) {
          return true;
        }
        return (
          isConstDeclaration(declaration) &&
          declaration.initializer !== undefined &&
          (await isChunkHelper(declaration.initializer, seen))
        );
      },
    );
  };

  const isConstValue = async (expression: ts.Expression): Promise<boolean> => {
    const value = unwrap(expression);
    if (
      ts.isPropertyAccessExpression(value) ||
      ts.isElementAccessExpression(value)
    ) {
      return await isConstValue(value.expression);
    }
    return (await declarationsOf(await symbolOf(value))).some(
      isConstDeclaration,
    );
  };
  const literalNumber = async (
    expression: ts.Expression,
  ): Promise<number | null> => {
    const value = unwrap(expression);
    if (!ts.isNumericLiteral(value) && !(await isConstValue(value))) {
      return null;
    }
    const type = await checker.getTypeAtLocation(value);
    return type.isNumberLiteralType() && Number.isSafeInteger(type.value)
      ? type.value
      : null;
  };

  const isConstObject = async (
    expression: ts.Expression,
    seen = new Set<CompilerSymbol>(),
  ): Promise<boolean> => {
    const value = unwrap(expression);
    if (ts.isObjectLiteralExpression(value)) {
      return !value.properties.some(ts.isSpreadAssignment);
    }
    const symbol = await symbolOf(value);
    if (symbol === undefined || seen.has(symbol)) {
      return false;
    }
    seen.add(symbol);
    return await someAsync(
      await declarationsOf(symbol),
      async (declaration) =>
        isConstDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        (await isConstObject(declaration.initializer, seen)),
    );
  };

  const isReadonlyObject = async (
    expression: ts.Expression,
    seen = new Set<CompilerSymbol>(),
  ): Promise<boolean> => {
    if (!(await isConstObject(expression))) {
      return false;
    }
    const properties = await (
      await checker.getTypeAtLocation(expression)
    ).getProperties();
    if (
      properties.length > 0 &&
      (await everyAsync(properties, async (property) =>
        (await declarationsOf(property)).some(
          (declaration) =>
            hasModifiers(declaration) &&
            declaration.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            ),
        ),
      ))
    ) {
      return true;
    }
    let value = expression;
    while (
      ts.isParenthesizedExpression(value) ||
      ts.isSatisfiesExpression(value) ||
      ts.isAsExpression(value) ||
      ts.isTypeAssertion(value)
    ) {
      if (
        (ts.isAsExpression(value) || ts.isTypeAssertion(value)) &&
        ts.isTypeReferenceNode(value.type) &&
        ts.isIdentifier(value.type.typeName) &&
        value.type.typeName.text === "const"
      ) {
        return true;
      }
      value = value.expression;
    }
    const symbol = await symbolOf(value);
    if (symbol === undefined || seen.has(symbol)) {
      return false;
    }
    seen.add(symbol);
    return await someAsync(
      await declarationsOf(symbol),
      async (declaration) =>
        isConstDeclaration(declaration) &&
        declaration.type === undefined &&
        declaration.initializer !== undefined &&
        (await isReadonlyObject(declaration.initializer, seen)),
    );
  };

  const fixedSetLength = async (
    expression: ts.Expression,
  ): Promise<number | null> => {
    const value = unwrap(expression);
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.some(ts.isSpreadElement)
        ? null
        : value.elements.length;
    }
    if (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression)
    ) {
      const member = value.expression;
      if (!["entries", "keys", "values"].includes(member.name.text)) {
        return null;
      }
      if (value.arguments.length === 0) {
        return await fixedSetLength(member.expression);
      }
      const [object] = value.arguments;
      if (
        !ts.isIdentifier(member.expression) ||
        member.expression.text !== "Object" ||
        value.arguments.length !== 1 ||
        object === undefined ||
        !(await isReadonlyObject(object))
      ) {
        return null;
      }
      const type = await checker.getTypeAtLocation(object);
      return (await checker.getIndexInfosOfType(type)).length === 0
        ? (await type.getProperties()).length
        : null;
    }
    const type = await checker.getTypeAtLocation(value);
    if (!type.isTupleType() || !(await type.getTarget()).readonly) {
      return null;
    }
    const length = await type.getProperty("length");
    if (length === undefined) {
      return null;
    }
    const lengthType = await checker.getTypeOfSymbolAtLocation(length, value);
    const lengths = lengthType.isUnionType()
      ? await lengthType.getTypes()
      : [lengthType];
    let maximum = 0;
    for (const entry of lengths) {
      if (!entry.isNumberLiteralType()) {
        return null;
      }
      maximum = Math.max(maximum, entry.value);
    }
    return maximum;
  };

  const writesCounter = async (
    body: ts.Node,
    counter: CompilerSymbol,
  ): Promise<boolean> => {
    const containsCounter = async (node: ts.Node): Promise<boolean> =>
      (ts.isIdentifier(node) &&
        (await checker.getSymbolAtLocation(node)) === counter) ||
      (await childrenAsync(node, containsCounter)) === true;
    const visit = async (node: ts.Node): Promise<boolean> => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (await containsCounter(node.left))
      ) {
        return true;
      }
      if (
        (ts.isPrefixUnaryExpression(node) ||
          ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken) &&
        (await containsCounter(node.operand))
      ) {
        return true;
      }
      return (await childrenAsync(node, visit)) === true;
    };
    return await visit(body);
  };

  const isCounter = async (
    expression: ts.Expression,
    counter: CompilerSymbol,
  ): Promise<boolean> =>
    ts.isIdentifier(unwrap(expression)) &&
    (await symbolOf(expression)) === counter;

  const counterStep = async (
    expression: ts.Expression,
    counter: CompilerSymbol,
  ): Promise<number | null> => {
    const increment = unwrap(expression);
    if (
      ts.isBinaryExpression(increment) &&
      increment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      (await isCounter(increment.left, counter))
    ) {
      return await literalNumber(increment.right);
    }
    if (
      (ts.isPrefixUnaryExpression(increment) ||
        ts.isPostfixUnaryExpression(increment)) &&
      increment.operator === ts.SyntaxKind.PlusPlusToken &&
      (await isCounter(increment.operand, counter))
    ) {
      return 1;
    }
    return null;
  };

  const boundedCounter = async (loop: ts.ForStatement): Promise<boolean> => {
    if (
      !loop.initializer ||
      !ts.isVariableDeclarationList(loop.initializer) ||
      loop.initializer.declarations.length !== 1 ||
      !loop.condition ||
      !loop.incrementor
    ) {
      return false;
    }
    const declaration = loop.initializer.declarations.at(0);
    if (
      !declaration ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer
    ) {
      return false;
    }
    const initial = await literalNumber(declaration.initializer);
    if (initial === null || initial < 0) {
      return false;
    }
    const counter = await checker.getSymbolAtLocation(declaration.name);
    if (!counter || (await writesCounter(loop.statement, counter))) {
      return false;
    }
    const step = await counterStep(loop.incrementor, counter);
    if (step === null || step < 1) {
      return false;
    }
    let condition = unwrap(loop.condition);
    while (
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      condition = unwrap(condition.left);
    }
    if (
      !ts.isBinaryExpression(condition) ||
      !(await isCounter(condition.left, counter))
    ) {
      return false;
    }
    const operator = condition.operatorToken.kind;
    if (
      operator !== ts.SyntaxKind.LessThanToken &&
      operator !== ts.SyntaxKind.LessThanEqualsToken
    ) {
      return false;
    }
    const bound = await literalNumber(condition.right);
    if (bound !== null) {
      return step === 1 && bound >= 0 && bound <= 16;
    }
    const right = unwrap(condition.right);
    return (
      step >= 2 &&
      operator === ts.SyntaxKind.LessThanToken &&
      ts.isPropertyAccessExpression(right) &&
      right.name.text === "length" &&
      checker.isArrayType(await checker.getTypeAtLocation(right.expression))
    );
  };

  const boundedRoundShape = async (
    loop: IterationStatement,
  ): Promise<boolean> => {
    if (ts.isForStatement(loop)) {
      return await boundedCounter(loop);
    }
    if (!ts.isForOfStatement(loop)) {
      return false;
    }
    const iterable = unwrap(loop.expression);
    let batches = iterable;
    if (
      ts.isCallExpression(batches) &&
      batches.arguments.length === 0 &&
      ts.isPropertyAccessExpression(batches.expression) &&
      ["entries", "keys", "values"].includes(batches.expression.name.text)
    ) {
      batches = unwrap(batches.expression.expression);
    }
    if (
      ts.isCallExpression(batches) &&
      (await isChunkHelper(batches.expression))
    ) {
      const size = batches.arguments.at(1);
      const number = size === undefined ? null : await literalNumber(size);
      return batches.arguments.length === 2 && number !== null && number >= 2;
    }
    const length = await fixedSetLength(iterable);
    return length !== null && length <= 16;
  };

  const hasEnclosingIteration = (loop: IterationStatement): boolean => {
    for (
      let node: ts.Node = loop.parent;
      !ts.isSourceFile(node);
      node = node.parent
    ) {
      if (isIterationStatement(node)) {
        return true;
      }
      if (isFunctionBoundary(node)) {
        if (promiseFanOutOfCallback(node) !== null) {
          return true;
        }
        if (!isResultTryPromiseCallback(node)) {
          return false;
        }
      }
    }
    return false;
  };

  const isProgramSource = async (sourceFile: ts.SourceFile): Promise<boolean> =>
    !sourceFile.isDeclarationFile &&
    !(await program.isSourceFileFromExternalLibrary(sourceFile)) &&
    !sourceFile.fileName.includes("/node_modules/");

  const handleMemo = new Map<Type, boolean>();
  const executableMemo = new Map<Type, boolean>();
  const runnerMemo = new Map<Type, boolean>();

  const memoized = async (
    memo: Map<Type, boolean>,
    type: Type,
    compute: () => Promise<boolean>,
  ): Promise<boolean> => {
    const known = memo.get(type);
    if (known !== undefined) {
      return known;
    }
    memo.set(type, false);
    const value = await compute();
    memo.set(type, value);
    return value;
  };

  // `any`, `unknown`, and the checker's error type are intrinsic types that
  // carry exactly one of these flags.
  const isAnyLike = (type: Type): boolean =>
    type.flags === TypeFlags.Any || type.flags === TypeFlags.Unknown;

  const resolveConstraint = async (type: Type): Promise<Type> =>
    type.isTypeParameter()
      ? ((await checker.getBaseConstraintOfType(type)) ?? type)
      : type;

  const isDrizzleDeclaration = (declaration: ts.Declaration): boolean =>
    DRIZZLE_FILE.test(declaration.getSourceFile().fileName);

  const containerName = (declaration: ts.Declaration): string | null => {
    const container = declaration.parent;
    if (
      (ts.isClassDeclaration(container) ||
        ts.isInterfaceDeclaration(container)) &&
      container.name !== undefined
    ) {
      return container.name.text;
    }
    return null;
  };

  const isHandleMemberDeclaration = (declaration: ts.Declaration): boolean => {
    if (isDrizzleDeclaration(declaration)) {
      const name = containerName(declaration);
      return name !== null && DRIZZLE_HANDLE_CLASS.test(name);
    }
    return handleFiles.has(toPosix(declaration.getSourceFile().fileName));
  };

  const isDrizzleHandleType = async (type: Type): Promise<boolean> => {
    const symbol = await type.getSymbol();
    return (
      symbol !== undefined &&
      DRIZZLE_HANDLE_TYPE.test(symbol.name) &&
      (await declarationsOf(symbol)).some(isDrizzleDeclaration)
    );
  };

  // A type Drizzle declares (`PgTable`, `SQL`, `SQLWrapper`,
  // `PgUpdateSetSource`, ...), through a union or a type parameter's
  // constraint.
  const isDrizzleDeclaredType = async (type: Type): Promise<boolean> => {
    const resolved = await resolveConstraint(type);
    if (resolved.isUnionType() || resolved.isIntersectionType()) {
      return await someAsync(await resolved.getTypes(), isDrizzleDeclaredType);
    }
    return await someAsync(
      [await resolved.getSymbol(), await resolved.getAliasSymbol()],
      async (symbol) =>
        (await declarationsOf(symbol)).some(isDrizzleDeclaration),
    );
  };

  // A member that takes a Drizzle table, statement or update payload is a
  // database operation wherever in this program it is declared: a structural
  // adapter over the driver (`delete: (table: PgTable) => ...`,
  // `execute: (query: SQL) => ...`) is a handle by what it accepts. Library
  // members are not adapters: `Array.prototype.with` over Drizzle row types
  // takes a Drizzle-declared value and writes nothing.
  const takesDrizzleArgument = async (type: Type): Promise<boolean> => {
    const resolved = await checker.getNonNullableType(type);
    const parts = resolved.isUnionType()
      ? await resolved.getTypes()
      : [resolved];
    return await someAsync(
      parts,
      async (part) =>
        await someAsync(
          await checker.getSignaturesOfType(part, SignatureKind.Call),
          async (signature) =>
            await someAsync(
              await signature.getParameters(),
              async (parameter) =>
                await isDrizzleDeclaredType(
                  await checker.getTypeOfSymbol(parameter),
                ),
            ),
        ),
    );
  };

  const hasHandleCapability = async (type: Type): Promise<boolean> =>
    await memoized(handleMemo, type, async () => {
      const resolved = await resolveConstraint(type);
      if (resolved.isUnionType()) {
        return await someAsync(await resolved.getTypes(), hasHandleCapability);
      }
      if (isAnyLike(resolved)) {
        return false;
      }
      if (await isDrizzleHandleType(resolved)) {
        return true;
      }
      if (
        await someAsync(HANDLE_MEMBER_NAMES, async (name) => {
          const member = await checker.getPropertyOfType(resolved, name);
          return (
            member !== undefined &&
            ((await declarationsOf(member)).some(isHandleMemberDeclaration) ||
              ((await someAsync(
                await declarationsOf(member),
                async (declaration) =>
                  await isProgramSource(declaration.getSourceFile()),
              )) &&
                (await takesDrizzleArgument(
                  await checker.getTypeOfSymbol(member),
                ))))
          );
        })
      ) {
        return true;
      }
      // A wrapper that opens transactions on a handle (a maintenance or
      // read-only session's `{ transaction, execute }`) is one by capability.
      const transaction = await checker.getPropertyOfType(
        resolved,
        "transaction",
      );
      return (
        transaction !== undefined &&
        (await isRunner(await checker.getTypeOfSymbol(transaction)))
      );
    });

  const isExecutableQuery = async (type: Type): Promise<boolean> =>
    await memoized(executableMemo, type, async () => {
      const resolved = await resolveConstraint(type);
      if (resolved.isUnionType()) {
        return await someAsync(await resolved.getTypes(), isExecutableQuery);
      }
      if (isAnyLike(resolved)) {
        return false;
      }
      return (
        await declarationsOf(await checker.getPropertyOfType(resolved, "then"))
      ).some(isDrizzleDeclaration);
    });

  const callbackReceivesHandle = async (type: Type): Promise<boolean> => {
    const resolved = await resolveConstraint(
      await checker.getNonNullableType(type),
    );
    const parts = resolved.isUnionType()
      ? await resolved.getTypes()
      : [resolved];
    return await someAsync(
      parts,
      async (part) =>
        await someAsync(
          await checker.getSignaturesOfType(part, SignatureKind.Call),
          async (signature) => {
            const [first] = await signature.getParameters();
            return (
              first !== undefined &&
              (await hasHandleCapability(await checker.getTypeOfSymbol(first)))
            );
          },
        ),
    );
  };

  const isRunner = async (type: Type): Promise<boolean> =>
    await memoized(runnerMemo, type, async () => {
      const resolved = await resolveConstraint(
        await checker.getNonNullableType(type),
      );
      const parts = resolved.isUnionType()
        ? await resolved.getTypes()
        : [resolved];
      return await someAsync(
        parts,
        async (part) =>
          await someAsync(
            await checker.getSignaturesOfType(part, SignatureKind.Call),
            async (signature) =>
              await someAsync(
                await signature.getParameters(),
                async (parameter) =>
                  await callbackReceivesHandle(
                    await checker.getTypeOfSymbol(parameter),
                  ),
              ),
          ),
      );
    });

  const typeOf = async (node: ts.Node): Promise<Type> =>
    await checker.getTypeAtLocation(node);

  const isThenable = async (type: Type): Promise<boolean> => {
    const resolved = await resolveConstraint(type);
    const parts = resolved.isUnionType()
      ? await resolved.getTypes()
      : [resolved];
    return await someAsync(
      parts,
      async (part) =>
        !isAnyLike(part) &&
        (await checker.getPropertyOfType(part, "then")) !== undefined,
    );
  };

  // Does this call's chain start at a database member of a handle
  // (`writer.delete(table).where(...)`)? A structural adapter's builders are
  // not Drizzle's, so awaiting the thenable at the chain's end is the
  // evidence that it runs.
  const chainStartsAtHandleMember = async (
    call: ts.CallExpression,
  ): Promise<boolean> => {
    let current: ts.Expression = unwrap(call.expression);
    for (;;) {
      if (ts.isPropertyAccessExpression(current)) {
        const member = current.name.text;
        if (
          HANDLE_MEMBER_NAME_SET.has(member) &&
          (await hasHandleCapability(await typeOf(current.expression)))
        ) {
          return true;
        }
        current = unwrap(current.expression);
      } else if (ts.isCallExpression(current)) {
        current = unwrap(current.expression);
      } else {
        return false;
      }
    }
  };

  // A call that runs a statement: a runner invocation, an executing handle
  // member (`tx.execute(...)`, `db.transaction(...)`), `.execute()`/`.then()`
  // on a query, or a query value in an executed position.
  const isQueryCall = async (
    call: ts.CallExpression,
    executed: boolean,
  ): Promise<boolean> => {
    const callee = unwrap(call.expression);
    if (await isRunner(await typeOf(callee))) {
      return true;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const member = callee.name.text;
      if (
        EXECUTING_HANDLE_MEMBERS.has(member) &&
        (await hasHandleCapability(await typeOf(callee.expression)))
      ) {
        return true;
      }
      if (
        QUERY_EXECUTION_MEMBERS.has(member) &&
        (
          await declarationsOf(await checker.getSymbolAtLocation(callee.name))
        ).some(isDrizzleDeclaration)
      ) {
        return true;
      }
    }
    if (!executed) {
      return false;
    }
    const type = await typeOf(call);
    return (
      (await isExecutableQuery(type)) ||
      ((await isThenable(type)) && (await chainStartsAtHandleMember(call)))
    );
  };

  const isHandleValue = async (expression: ts.Expression): Promise<boolean> => {
    const type = await typeOf(expression);
    return (await hasHandleCapability(type)) || (await isRunner(type));
  };

  // The handle a call receives as an argument, directly or inside an object
  // literal (by value or shorthand, nested literals included). Function
  // arguments are not searched: a handle used inside a callback runs wherever
  // that callback runs, which is the callee's business.
  const findHandleInValue = async (
    expression: ts.Expression,
  ): Promise<string | null> => {
    const value = unwrap(expression);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return null;
    }
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isPropertyAssignment(property)) {
          const found = await findHandleInValue(property.initializer);
          if (found !== null) {
            return found;
          }
        } else if (
          ts.isShorthandPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          (await isHandleValue(property.name))
        ) {
          return property.name.text;
        }
      }
      return null;
    }
    return (await isHandleValue(value)) ? subjectText(value) : null;
  };

  const findHandleArgument = async (
    call: ts.CallExpression,
  ): Promise<string | null> => {
    for (const argument of call.arguments) {
      const found = await findHandleInValue(
        ts.isSpreadElement(argument) ? argument.expression : argument,
      );
      if (found !== null) {
        return found;
      }
    }
    return null;
  };

  const bodyOf = async (
    declaration: ts.Node | undefined,
  ): Promise<ts.Node | null> => {
    if (declaration === undefined) {
      return null;
    }
    if (ts.isVariableDeclaration(declaration)) {
      return declaration.initializer === undefined
        ? null
        : await bodyOf(unwrap(declaration.initializer));
    }
    if (!isFunctionBoundary(declaration) || declaration.body === undefined) {
      return null;
    }
    return (await isProgramSource(declaration.getSourceFile()))
      ? declaration.body
      : null;
  };

  const resolveCalleeBody = async (
    call: ts.CallExpression,
  ): Promise<ts.Node | null> =>
    await bodyOf(
      await (await checker.getResolvedSignature(call)).declaration?.resolve(),
    );

  const resolveFunctionValueBody = async (
    expression: ts.Expression,
  ): Promise<ts.Node | null> => {
    const value = unwrap(expression);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return value.body;
    }
    let symbol = await checker.getSymbolAtLocation(value);
    if (symbol !== undefined && (await isImportAlias(symbol))) {
      symbol = await checker.getAliasedSymbol(symbol);
    }
    for (const declaration of await declarationsOf(symbol)) {
      const body = await bodyOf(declaration);
      if (body !== null) {
        return body;
      }
    }
    return null;
  };

  const summaryMemo = new Map<ts.Node, Map<number, Match | null>>();

  // Does `node` issue a query, or hand a handle to a helper, within `hops`
  // further function bodies? `viaResolution` is false only while scanning an
  // inline fan-out callback's own body, where a directly awaited call belongs
  // to the await site inside the callback and must not be counted twice.
  const scanForDatabaseWork = async (
    node: ts.Node,
    hops: number,
    viaResolution: boolean,
  ): Promise<Match | null> => {
    let found: Match | null = null;
    const visit = async (current: ts.Node): Promise<void> => {
      if (found !== null) {
        return;
      }
      if (ts.isCallExpression(current) && isChainEnd(current)) {
        const counts = viaResolution || !isDirectAwaitOperand(current);
        if (counts) {
          if (await isQueryCall(current, isExecutedPosition(current))) {
            found = QUERY_MATCH;
            return;
          }
          const handle = await findHandleArgument(current);
          if (handle !== null) {
            found = { kind: "handle", subject: handle };
            return;
          }
        }
        if (hops > 0) {
          const body = await resolveCalleeBody(current);
          if (body !== null && (await summarize(body, hops - 1)) !== null) {
            found = {
              kind: "helper",
              subject: subjectText(current.expression),
            };
            return;
          }
        }
      } else if (
        (ts.isIdentifier(current) ||
          ts.isPropertyAccessExpression(current) ||
          ts.isElementAccessExpression(current)) &&
        (viaResolution || !isDirectAwaitOperand(current)) &&
        isExecutedPosition(current) &&
        (await isExecutableQuery(await typeOf(current)))
      ) {
        // A query held in a variable and then awaited or returned: an async
        // function adopts the returned thenable, so returning it runs it.
        found = QUERY_MATCH;
        return;
      }
      if (
        isFunctionBoundary(current) &&
        current !== node &&
        !ts.isCallExpression(outerParent(current).parent)
      ) {
        // A function defined here but not handed to a call is not run here.
        return;
      }
      await childrenAsync(current, visit);
    };
    await visit(node);
    return found;
  };

  const summarize = async (
    body: ts.Node,
    hops: number,
  ): Promise<Match | null> => {
    const byHops = summaryMemo.get(body) ?? new Map<number, Match | null>();
    summaryMemo.set(body, byHops);
    if (byHops.has(hops)) {
      return byHops.get(hops) ?? null;
    }
    byHops.set(hops, null);
    const match = await scanForDatabaseWork(body, hops, true);
    byHops.set(hops, match);
    return match;
  };

  // `Promise.all(items.map(cb))` whose callback reaches the database.
  const fanOutMatch = async (
    expression: ts.Expression,
  ): Promise<Match | null> => {
    const call = unwrap(expression);
    if (!isPromiseFanOutCall(call) || call.arguments.length !== 1) {
      return null;
    }
    const [argument] = call.arguments;
    const mapCall = argument === undefined ? null : unwrap(argument);
    if (mapCall === null || !isMapLikeCall(mapCall)) {
      return null;
    }
    // The callback is the first argument; a second is the optional `thisArg`.
    const [callback] = mapCall.arguments;
    if (callback === undefined) {
      return null;
    }
    const inline = unwrap(callback);
    if (ts.isArrowFunction(inline) || ts.isFunctionExpression(inline)) {
      return await scanForDatabaseWork(inline.body, 1, false);
    }
    const body = await resolveFunctionValueBody(inline);
    return body === null ? null : await summarize(body, 1);
  };

  const fanOutMemo = new Map<ts.CallExpression, Match | null>();
  const cachedFanOutMatch = async (
    call: ts.CallExpression,
  ): Promise<Match | null> => {
    if (!fanOutMemo.has(call)) {
      fanOutMemo.set(call, await fanOutMatch(call));
    }
    return fanOutMemo.get(call) ?? null;
  };

  const isUnclassified = async (
    expression: ts.Expression,
  ): Promise<boolean> => {
    if (isAnyLike(await typeOf(expression))) {
      return true;
    }
    if (!ts.isCallExpression(expression)) {
      return false;
    }
    const callee = unwrap(expression.expression);
    return (
      isAnyLike(await typeOf(callee)) ||
      (ts.isPropertyAccessExpression(callee) &&
        isAnyLike(await typeOf(callee.expression)))
    );
  };

  const hits: DbAwaitInLoopHit[] = [];
  const unclassified: DbAwaitInLoopUnclassified[] = [];
  const directiveProblems: DbAwaitInLoopDirectiveProblem[] = [];
  const directiveCounts: Record<string, number> = {};
  let suppressedHits = 0;
  let boundedRoundHits = 0;
  let filesScanned = 0;

  for (const sourceFileName of await program.getSourceFileNames()) {
    const sourceFile =
      (await program.getSourceFile(sourceFileName)) ??
      panic(`Missing program source: ${sourceFileName}`);
    const file = repoRelativePath(repositoryRoot, sourceFile.fileName);
    if (!(await isProgramSource(sourceFile)) || !isInScope(file)) {
      continue;
    }
    filesScanned += 1;
    const fileHits: {
      hit: DbAwaitInLoopHit;
      loop: IterationStatement | null;
      fanOut: boolean;
    }[] = [];

    const loopHits = new Map<ts.Node, number>();
    const fanOutSites = new Set<ts.Node>();

    const location = (node: ts.Node): { line: number; column: number } => {
      const position = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      return { line: position.line + 1, column: position.character + 1 };
    };

    const report = (site: ts.Node, match: Match): void => {
      for (
        let node: ts.Node = site.parent;
        !ts.isSourceFile(node);
        node = node.parent
      ) {
        if (isIterationStatement(node)) {
          loopHits.set(node, (loopHits.get(node) ?? 0) + 1);
        }
        if (isFunctionBoundary(node) && !isResultTryPromiseCallback(node)) {
          break;
        }
      }
      const context = findLoopContext(site);
      if (context === null && !fanOutSites.has(site)) {
        return;
      }
      fileHits.push({
        hit: {
          file,
          ...location(site),
          kind: match.kind,
          subject: match.kind === "query" ? "" : match.subject,
        },
        loop: context?.loop ?? null,
        fanOut:
          (context?.fanOut !== null && context?.fanOut !== undefined) ||
          fanOutSites.has(site),
      });
    };

    const inspectSite = async (
      site: ts.Node,
      awaited: ts.Expression,
    ): Promise<void> => {
      const loop = findLoopContext(site);
      const fanOut =
        ts.isCallExpression(awaited) && isPromiseFanOutCall(awaited)
          ? await cachedFanOutMatch(awaited)
          : null;
      if (fanOut !== null) {
        fanOutSites.add(site);
      }
      if (
        loop === null &&
        fanOut === null &&
        findLoopContext(site, "include") === null
      ) {
        return;
      }
      // The enclosing fan-out already reports on its own await; one fan-out
      // must not cost two suppressions, whatever the inner site is.
      const ownedByFanOut =
        loop?.fanOut !== null &&
        loop?.fanOut !== undefined &&
        (await cachedFanOutMatch(loop.fanOut)) !== null;
      if (
        (ts.isCallExpression(awaited) && (await isQueryCall(awaited, true))) ||
        (!ts.isCallExpression(awaited) &&
          (await isExecutableQuery(await typeOf(awaited))))
      ) {
        if (!ownedByFanOut) {
          report(site, QUERY_MATCH);
        }
        return;
      }
      if (fanOut !== null) {
        report(site, fanOut);
        return;
      }
      let match: Match | null = null;
      if (ts.isCallExpression(awaited)) {
        const handle = await findHandleArgument(awaited);
        if (handle !== null) {
          match = { kind: "handle", subject: handle };
        } else {
          const body = await resolveCalleeBody(awaited);
          if (
            body !== null &&
            (await summarize(body, HELPER_HOPS - 1)) !== null
          ) {
            match = {
              kind: "helper",
              subject: subjectText(awaited.expression),
            };
          }
        }
      }
      if (match === null) {
        if (await isUnclassified(awaited)) {
          unclassified.push({
            file,
            ...location(site),
            subject: subjectText(awaited),
          });
        }
        return;
      }
      if (ownedByFanOut) {
        return;
      }
      report(site, match);
    };

    const visit = async (node: ts.Node): Promise<void> => {
      if (ts.isAwaitExpression(node)) {
        await inspectSite(node, unwrap(node.expression));
      } else if (
        ts.isYieldExpression(node) &&
        node.asteriskToken !== undefined &&
        node.expression !== undefined
      ) {
        const argument = resultAwaitArgument(node.expression);
        if (argument !== null) {
          await inspectSite(node, argument);
        }
      }
      await childrenAsync(node, visit);
    };
    await visit(sourceFile);

    const directives = parseDirectives(
      parseSource(file, sourceFile.text),
      file,
    );
    directiveProblems.push(...directives.problems);
    const directiveCount = countParsedDirectives(directives);
    if (directiveCount > 0) {
      directiveCounts[file] = directiveCount;
    }
    for (const { hit, loop, fanOut } of fileHits) {
      if (
        loop !== null &&
        !fanOut &&
        loopHits.get(loop) === 1 &&
        !hasEnclosingIteration(loop) &&
        (await boundedRoundShape(loop))
      ) {
        boundedRoundHits += 1;
        continue;
      }
      const lineDirective = directives.lines.find(
        (directive) => directive.target === hit.line,
      );
      const block = directives.blocks.find(
        (range) => range.start < hit.line && hit.line < range.end,
      );
      const suppressor = lineDirective ?? block?.directive;
      if (suppressor === undefined) {
        hits.push(hit);
        continue;
      }
      suppressor.used = true;
      suppressedHits += 1;
    }
    for (const directive of [
      ...directives.lines,
      ...directives.blocks.map(({ directive: opening }) => opening),
    ]) {
      if (!directive.used) {
        directiveProblems.push({
          file,
          line: directive.line,
          message:
            "unused `// db-await-in-loop` directive: nothing on the line(s) it covers awaits the database in a loop; remove it",
        });
      }
    }
  }

  const byLocation = <T extends { file: string; line: number }>(
    a: T,
    b: T,
  ): number => compareCodeUnit(a.file, b.file) || a.line - b.line;

  return {
    hits: hits.toSorted(byLocation),
    suppressedHits,
    boundedRoundHits,
    directiveProblems: directiveProblems.toSorted(byLocation),
    unclassified: unclassified.toSorted(byLocation),
    filesScanned,
    directiveCounts,
  };
};

const HIT_MESSAGES: Record<DbAwaitInLoopKind, (subject: string) => string> = {
  query: () =>
    "Database call awaited inside a loop scales the query count with the " +
    "input size (N+1). Batch with `inArray(...)`, a join, or one " +
    "aggregated query, or await once outside the loop.",
  handle: (subject) =>
    `Awaited call receives the database handle \`${subject}\` inside ` +
    "a loop, so the query behind it runs once per iteration (N+1). Hand " +
    "the whole set to a batched helper, or await once outside the loop.",
  helper: (subject) =>
    `Awaited call \`${subject}\` reaches the database inside a loop, ` +
    "so its query runs once per iteration (N+1). Batch the work behind " +
    "one call, or await once outside the loop.",
};

export const describeHit = (hit: DbAwaitInLoopHit): string =>
  HIT_MESSAGES[hit.kind](hit.subject);

const SUPPRESSION_HINT =
  "If the sequence is required (a cursor walk, a page loop, an ordered write, " +
  "a small fixed bound), put `// db-await-in-loop: <reason>` on the line above.";

const readProjectFileNames = async (
  configPath: string,
): Promise<readonly string[]> => {
  const api = new API({ cwd: path.dirname(configPath) });
  try {
    return (await api.parseConfigFile(configPath)).fileNames;
  } finally {
    await api.close();
  }
};

const run = async (): Promise<number> => {
  const started = performance.now();
  for (const file of [...API_PROJECTS, ...API_HANDLE_DECLARATION_FILES]) {
    if (!existsSync(path.join(REPO_ROOT, file))) {
      panic(
        `db-await-in-loop: ${file} is missing; update the project or handle-module list`,
      );
    }
  }
  const [mainProject] = API_PROJECTS;
  const rootNames = [
    ...new Set(
      (
        await Promise.all(
          API_PROJECTS.map(
            async (project) =>
              await readProjectFileNames(path.join(REPO_ROOT, project)),
          ),
        )
      ).flat(),
    ),
  ];
  const opened = await createProgram({
    configPath: path.join(REPO_ROOT, mainProject),
    rootNames,
  });
  const { program, checker } = opened;
  try {
    const programReady = performance.now();

    const report = await scanDbAwaitInLoop({
      program,
      checker,
      repositoryRoot: REPO_ROOT,
      isInScope: isApiSourceInScope,
      handleDeclarationFiles: API_HANDLE_DECLARATION_FILES,
    });
    const finished = performance.now();

    for (const hit of report.hits) {
      console.error(
        `${hit.file}:${hit.line}:${hit.column} ${describeHit(hit)} [db-await-in-loop/${hit.kind}]`,
      );
    }
    if (report.hits.length > 0) {
      console.error(SUPPRESSION_HINT);
    }
    for (const problem of report.directiveProblems) {
      console.error(`${problem.file}:${problem.line} ${problem.message}`);
    }
    if (report.unclassified.length > 0) {
      console.log(
        `db-await-in-loop: ${report.unclassified.length} awaited site(s) in loops resolve to any/unknown and are NOT certified clean:`,
      );
      for (const site of report.unclassified) {
        console.log(
          `  ${site.file}:${site.line}:${site.column} ${site.subject}`,
        );
      }
    }

    const seconds = (milliseconds: number): string =>
      (milliseconds / 1000).toFixed(1);
    const peakMiB = Math.round(process.resourceUsage().maxRSS / 1024);
    console.log(
      `db-await-in-loop: ${report.filesScanned} files, program ${seconds(programReady - started)}s, scan ${seconds(finished - programReady)}s, peak RSS ${peakMiB} MiB; ${report.boundedRoundHits} constant-bounded rounds, ${report.suppressedHits} suppressed, ${report.hits.length} unsuppressed, ${report.directiveProblems.length} directive problem(s)`,
    );

    return report.hits.length > 0 || report.directiveProblems.length > 0
      ? 1
      : 0;
  } finally {
    await opened.close();
  }
};

if (import.meta.main) {
  process.exitCode = await run();
}
