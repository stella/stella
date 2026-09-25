#!/usr/bin/env bun
// Database round trips awaited once per loop iteration (the N+1 query shape),
// found with the TypeScript type checker instead of by the spelling of a
// receiver. A handle renamed `database`, destructured out of a context, or
// narrowed to `Pick<typeof rootDb, "select">` is still a handle; a Redis
// client that happens to be called `db` is not one.
//
// Contract: one JavaScript `ts.Program` over the API's source and scripts
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
// flagged, but only where nothing can bypass that exit: no `continue` targets
// the loop, and no `try` with a `catch` or `finally` sits in between.
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
// A directive that suppresses nothing is an error, like an unused lint
// directive. `scripts/ratchet.ts` budgets the directives.
//
// Usage: bun scripts/db-await-in-loop.ts

import { panic } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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
  readonly directiveProblems: readonly DbAwaitInLoopDirectiveProblem[];
  readonly unclassified: readonly DbAwaitInLoopUnclassified[];
  readonly filesScanned: number;
};

export type ScanDbAwaitInLoopOptions = {
  readonly program: ts.Program;
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

const isImportAlias = (symbol: ts.Symbol): boolean =>
  (symbol.declarations ?? []).some(
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
    ts.isTypeAssertionExpression(current)
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
    ts.isTypeAssertionExpression(parent)
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
  if (
    !isMapLikeCall(mapCall) ||
    !mapCall.arguments.some((argument) => argument === child)
  ) {
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

const isIterationStatement = (node: ts.Node): boolean =>
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

// Can anything in `loop` go round it again early? Any `continue` targeting it,
// labelled or not, and wherever it sits, can bypass an exit that follows a
// site, so its presence voids the exemption for the whole loop.
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
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(loop, visit);
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
// bypass or override that exit: no `continue` targets the loop anywhere in
// it, and no `try` between the site and the loop has a `catch` (a retry) or a
// `finally` (which can replace the exit).
const leavesLoopAfter = (site: ts.Node, loop: ts.Node): boolean => {
  if (isContinuedAnywhere(loop)) {
    return false;
  }
  let statement: ts.Node = site;
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
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
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
  for (const entry of owner.statements) {
    if (after && isLoopExit(entry, loop)) {
      return true;
    }
    after ||= entry === statement;
  }
  return false;
};

const findLoopContext = (
  site: ts.Node,
): { context: LoopContext; fanOut: ts.CallExpression | null } | null => {
  let child: ts.Node = site;
  let current: ts.Node = site.parent;
  while (!ts.isSourceFile(current)) {
    if (
      isPerIterationPosition(current, child) &&
      !leavesLoopAfter(site, current)
    ) {
      return { context: "loop", fanOut: null };
    }
    if (ts.isClassStaticBlockDeclaration(current)) {
      return null;
    }
    if (isFunctionBoundary(current) && !isResultTryPromiseCallback(current)) {
      const fanOut = promiseFanOutOfCallback(current);
      return fanOut === null ? null : { context: "fan-out", fanOut };
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
const DIRECTIVE_PATTERN =
  /\/\/[ \t]*db-await-in-loop(?<variant>-disable|-enable)?(?<rest>[^\n]*)/gu;

const literalRanges = (sourceFile: ts.SourceFile): [number, number][] => {
  const ranges: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      ranges.push([node.getStart(sourceFile), node.getEnd()]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ranges;
};

const isCommentOnlyLine = (text: string): boolean => {
  const trimmed = text.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  );
};

export const parseDirectives = (
  sourceFile: ts.SourceFile,
  file: string,
): FileDirectives => {
  const text = sourceFile.text;
  if (!text.includes(DIRECTIVE_TOKEN)) {
    return { lines: [], blocks: [], problems: [] };
  }
  const literals = literalRanges(sourceFile);
  const sourceLines = text.split("\n");
  const lines: Directive[] = [];
  const blocks: BlockRange[] = [];
  const problems: DbAwaitInLoopDirectiveProblem[] = [];
  let openBlock: Directive | null = null;

  for (const match of text.matchAll(DIRECTIVE_PATTERN)) {
    const position = match.index;
    if (literals.some(([start, end]) => position >= start && position < end)) {
      continue;
    }
    const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
    const variant = match.groups?.["variant"] ?? "";
    const rest = match.groups?.["rest"] ?? "";
    const before = text
      .slice(
        position - sourceFile.getLineAndCharacterOfPosition(position).character,
        position,
      )
      .trim();
    if (isCommentOnlyLine(before) && before !== "") {
      // The token is quoted inside another comment's prose, not a directive.
      continue;
    }
    const trailing = before !== "";

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

    let target = line;
    if (!trailing) {
      target = line + 1;
      while (
        target <= sourceLines.length &&
        isCommentOnlyLine(sourceLines[target - 1] ?? "")
      ) {
        target += 1;
      }
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

export const scanDbAwaitInLoop = ({
  program,
  repositoryRoot,
  isInScope,
  handleDeclarationFiles,
}: ScanDbAwaitInLoopOptions): DbAwaitInLoopReport => {
  const checker = program.getTypeChecker();
  const handleFiles = new Set(
    handleDeclarationFiles.map((file) =>
      toPosix(path.resolve(repositoryRoot, file)),
    ),
  );

  const isProgramSource = (sourceFile: ts.SourceFile): boolean =>
    !sourceFile.isDeclarationFile &&
    !program.isSourceFileFromExternalLibrary(sourceFile) &&
    !sourceFile.fileName.includes("/node_modules/");

  const handleMemo = new Map<ts.Type, boolean>();
  const executableMemo = new Map<ts.Type, boolean>();
  const runnerMemo = new Map<ts.Type, boolean>();

  const memoized = (
    memo: Map<ts.Type, boolean>,
    type: ts.Type,
    compute: () => boolean,
  ): boolean => {
    const known = memo.get(type);
    if (known !== undefined) {
      return known;
    }
    memo.set(type, false);
    const value = compute();
    memo.set(type, value);
    return value;
  };

  // `any`, `unknown`, and the checker's error type are intrinsic types that
  // carry exactly one of these flags.
  const isAnyLike = (type: ts.Type): boolean =>
    type.flags === ts.TypeFlags.Any || type.flags === ts.TypeFlags.Unknown;

  const resolveConstraint = (type: ts.Type): ts.Type =>
    type.isTypeParameter()
      ? (checker.getBaseConstraintOfType(type) ?? type)
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

  const isDrizzleHandleType = (type: ts.Type): boolean => {
    const symbol = type.getSymbol();
    return (
      symbol !== undefined &&
      DRIZZLE_HANDLE_TYPE.test(symbol.getName()) &&
      (symbol.declarations ?? []).some(isDrizzleDeclaration)
    );
  };

  // A type Drizzle declares (`PgTable`, `SQL`, `SQLWrapper`,
  // `PgUpdateSetSource`, ...), through a union or a type parameter's
  // constraint.
  const isDrizzleDeclaredType = (type: ts.Type): boolean => {
    const resolved = resolveConstraint(type);
    if (resolved.isUnion() || resolved.isIntersection()) {
      return resolved.types.some(isDrizzleDeclaredType);
    }
    return [resolved.getSymbol(), resolved.aliasSymbol].some((symbol) =>
      (symbol?.declarations ?? []).some(isDrizzleDeclaration),
    );
  };

  // A member that takes a Drizzle table, statement or update payload is a
  // database operation wherever in this program it is declared: a structural
  // adapter over the driver (`delete: (table: PgTable) => ...`,
  // `execute: (query: SQL) => ...`) is a handle by what it accepts. Library
  // members are not adapters: `Array.prototype.with` over Drizzle row types
  // takes a Drizzle-declared value and writes nothing.
  const takesDrizzleArgument = (type: ts.Type): boolean => {
    const resolved = checker.getNonNullableType(type);
    const parts = resolved.isUnion() ? resolved.types : [resolved];
    return parts.some((part) =>
      checker
        .getSignaturesOfType(part, ts.SignatureKind.Call)
        .some((signature) =>
          signature
            .getParameters()
            .some((parameter) =>
              isDrizzleDeclaredType(checker.getTypeOfSymbol(parameter)),
            ),
        ),
    );
  };

  const hasHandleCapability = (type: ts.Type): boolean =>
    memoized(handleMemo, type, () => {
      const resolved = resolveConstraint(type);
      if (resolved.isUnion()) {
        return resolved.types.some(hasHandleCapability);
      }
      if (isAnyLike(resolved)) {
        return false;
      }
      if (isDrizzleHandleType(resolved)) {
        return true;
      }
      if (
        HANDLE_MEMBER_NAMES.some((name) => {
          const member = checker.getPropertyOfType(resolved, name);
          return (
            member !== undefined &&
            ((member.declarations ?? []).some(isHandleMemberDeclaration) ||
              ((member.declarations ?? []).some((declaration) =>
                isProgramSource(declaration.getSourceFile()),
              ) &&
                takesDrizzleArgument(checker.getTypeOfSymbol(member))))
          );
        })
      ) {
        return true;
      }
      // A wrapper that opens transactions on a handle (a maintenance or
      // read-only session's `{ transaction, execute }`) is one by capability.
      const transaction = checker.getPropertyOfType(resolved, "transaction");
      return (
        transaction !== undefined &&
        isRunner(checker.getTypeOfSymbol(transaction))
      );
    });

  const isExecutableQuery = (type: ts.Type): boolean =>
    memoized(executableMemo, type, () => {
      const resolved = resolveConstraint(type);
      if (resolved.isUnion()) {
        return resolved.types.some(isExecutableQuery);
      }
      if (isAnyLike(resolved)) {
        return false;
      }
      return (
        checker.getPropertyOfType(resolved, "then")?.declarations ?? []
      ).some(isDrizzleDeclaration);
    });

  const callbackReceivesHandle = (type: ts.Type): boolean => {
    const resolved = resolveConstraint(checker.getNonNullableType(type));
    const parts = resolved.isUnion() ? resolved.types : [resolved];
    return parts.some((part) =>
      checker
        .getSignaturesOfType(part, ts.SignatureKind.Call)
        .some((signature) => {
          const [first] = signature.getParameters();
          return (
            first !== undefined &&
            hasHandleCapability(checker.getTypeOfSymbol(first))
          );
        }),
    );
  };

  const isRunner = (type: ts.Type): boolean =>
    memoized(runnerMemo, type, () => {
      const resolved = resolveConstraint(checker.getNonNullableType(type));
      const parts = resolved.isUnion() ? resolved.types : [resolved];
      return parts.some((part) =>
        checker
          .getSignaturesOfType(part, ts.SignatureKind.Call)
          .some((signature) =>
            signature
              .getParameters()
              .some((parameter) =>
                callbackReceivesHandle(checker.getTypeOfSymbol(parameter)),
              ),
          ),
      );
    });

  const typeOf = (node: ts.Node): ts.Type => checker.getTypeAtLocation(node);

  const isThenable = (type: ts.Type): boolean => {
    const resolved = resolveConstraint(type);
    const parts = resolved.isUnion() ? resolved.types : [resolved];
    return parts.some(
      (part) =>
        !isAnyLike(part) &&
        checker.getPropertyOfType(part, "then") !== undefined,
    );
  };

  // Does this call's chain start at a database member of a handle
  // (`writer.delete(table).where(...)`)? A structural adapter's builders are
  // not Drizzle's, so awaiting the thenable at the chain's end is the
  // evidence that it runs.
  const chainStartsAtHandleMember = (call: ts.CallExpression): boolean => {
    let current: ts.Expression = unwrap(call.expression);
    for (;;) {
      if (ts.isPropertyAccessExpression(current)) {
        const member = current.name.text;
        if (
          HANDLE_MEMBER_NAME_SET.has(member) &&
          hasHandleCapability(typeOf(current.expression))
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
  const isQueryCall = (call: ts.CallExpression, executed: boolean): boolean => {
    const callee = unwrap(call.expression);
    if (isRunner(typeOf(callee))) {
      return true;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const member = callee.name.text;
      if (
        EXECUTING_HANDLE_MEMBERS.has(member) &&
        hasHandleCapability(typeOf(callee.expression))
      ) {
        return true;
      }
      if (
        QUERY_EXECUTION_MEMBERS.has(member) &&
        (checker.getSymbolAtLocation(callee.name)?.declarations ?? []).some(
          isDrizzleDeclaration,
        )
      ) {
        return true;
      }
    }
    if (!executed) {
      return false;
    }
    const type = typeOf(call);
    return (
      isExecutableQuery(type) ||
      (isThenable(type) && chainStartsAtHandleMember(call))
    );
  };

  const isHandleValue = (expression: ts.Expression): boolean => {
    const type = typeOf(expression);
    return hasHandleCapability(type) || isRunner(type);
  };

  // The handle a call receives as an argument, directly or inside an object
  // literal (by value or shorthand, nested literals included). Function
  // arguments are not searched: a handle used inside a callback runs wherever
  // that callback runs, which is the callee's business.
  const findHandleInValue = (expression: ts.Expression): string | null => {
    const value = unwrap(expression);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return null;
    }
    if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (ts.isPropertyAssignment(property)) {
          const found = findHandleInValue(property.initializer);
          if (found !== null) {
            return found;
          }
        } else if (
          ts.isShorthandPropertyAssignment(property) &&
          isHandleValue(property.name)
        ) {
          return property.name.text;
        }
      }
      return null;
    }
    return isHandleValue(value) ? subjectText(value) : null;
  };

  const findHandleArgument = (call: ts.CallExpression): string | null => {
    for (const argument of call.arguments) {
      const found = findHandleInValue(
        ts.isSpreadElement(argument) ? argument.expression : argument,
      );
      if (found !== null) {
        return found;
      }
    }
    return null;
  };

  const bodyOf = (declaration: ts.Node | undefined): ts.Node | null => {
    if (declaration === undefined) {
      return null;
    }
    if (ts.isVariableDeclaration(declaration)) {
      return declaration.initializer === undefined
        ? null
        : bodyOf(unwrap(declaration.initializer));
    }
    if (!isFunctionBoundary(declaration) || declaration.body === undefined) {
      return null;
    }
    return isProgramSource(declaration.getSourceFile())
      ? declaration.body
      : null;
  };

  const resolveCalleeBody = (call: ts.CallExpression): ts.Node | null =>
    bodyOf(checker.getResolvedSignature(call)?.getDeclaration());

  const resolveFunctionValueBody = (
    expression: ts.Expression,
  ): ts.Node | null => {
    const value = unwrap(expression);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      return value.body;
    }
    let symbol = checker.getSymbolAtLocation(value);
    if (symbol !== undefined && isImportAlias(symbol)) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    for (const declaration of symbol?.declarations ?? []) {
      const body = bodyOf(declaration);
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
  const scanForDatabaseWork = (
    node: ts.Node,
    hops: number,
    viaResolution: boolean,
  ): Match | null => {
    let found: Match | null = null;
    const visit = (current: ts.Node): void => {
      if (found !== null) {
        return;
      }
      if (ts.isCallExpression(current) && isChainEnd(current)) {
        const counts = viaResolution || !isDirectAwaitOperand(current);
        if (counts) {
          if (isQueryCall(current, isExecutedPosition(current))) {
            found = QUERY_MATCH;
            return;
          }
          const handle = findHandleArgument(current);
          if (handle !== null) {
            found = { kind: "handle", subject: handle };
            return;
          }
        }
        if (hops > 0) {
          const body = resolveCalleeBody(current);
          if (body !== null && summarize(body, hops - 1) !== null) {
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
        isExecutableQuery(typeOf(current))
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
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  };

  const summarize = (body: ts.Node, hops: number): Match | null => {
    const byHops = summaryMemo.get(body) ?? new Map<number, Match | null>();
    summaryMemo.set(body, byHops);
    if (byHops.has(hops)) {
      return byHops.get(hops) ?? null;
    }
    byHops.set(hops, null);
    const match = scanForDatabaseWork(body, hops, true);
    byHops.set(hops, match);
    return match;
  };

  // `Promise.all(items.map(cb))` whose callback reaches the database.
  const fanOutMatch = (expression: ts.Expression): Match | null => {
    const call = unwrap(expression);
    if (!isPromiseFanOutCall(call) || call.arguments.length !== 1) {
      return null;
    }
    const [argument] = call.arguments;
    const mapCall = argument === undefined ? null : unwrap(argument);
    if (mapCall === null || !isMapLikeCall(mapCall)) {
      return null;
    }
    const callback = mapCall.arguments.at(-1);
    if (callback === undefined) {
      return null;
    }
    const inline = unwrap(callback);
    if (ts.isArrowFunction(inline) || ts.isFunctionExpression(inline)) {
      return scanForDatabaseWork(inline.body, 1, false);
    }
    const body = resolveFunctionValueBody(inline);
    return body === null ? null : summarize(body, 1);
  };

  const fanOutMemo = new Map<ts.CallExpression, Match | null>();
  const cachedFanOutMatch = (call: ts.CallExpression): Match | null => {
    if (!fanOutMemo.has(call)) {
      fanOutMemo.set(call, fanOutMatch(call));
    }
    return fanOutMemo.get(call) ?? null;
  };

  const isUnclassified = (expression: ts.Expression): boolean => {
    if (isAnyLike(typeOf(expression))) {
      return true;
    }
    if (!ts.isCallExpression(expression)) {
      return false;
    }
    const callee = unwrap(expression.expression);
    return (
      isAnyLike(typeOf(callee)) ||
      (ts.isPropertyAccessExpression(callee) &&
        isAnyLike(typeOf(callee.expression)))
    );
  };

  const hits: DbAwaitInLoopHit[] = [];
  const unclassified: DbAwaitInLoopUnclassified[] = [];
  const directiveProblems: DbAwaitInLoopDirectiveProblem[] = [];
  let suppressedHits = 0;
  let filesScanned = 0;

  for (const sourceFile of program.getSourceFiles()) {
    const file = toPosix(path.relative(repositoryRoot, sourceFile.fileName));
    if (!isProgramSource(sourceFile) || !isInScope(file)) {
      continue;
    }
    filesScanned += 1;
    const fileHits: DbAwaitInLoopHit[] = [];

    const location = (node: ts.Node): { line: number; column: number } => {
      const position = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      return { line: position.line + 1, column: position.character + 1 };
    };

    const report = (site: ts.Node, match: Match): void => {
      fileHits.push({
        file,
        ...location(site),
        kind: match.kind,
        subject: match.kind === "query" ? "" : match.subject,
      });
    };

    const inspectSite = (site: ts.Node, awaited: ts.Expression): void => {
      const loop = findLoopContext(site);
      const fanOut =
        ts.isCallExpression(awaited) && isPromiseFanOutCall(awaited)
          ? cachedFanOutMatch(awaited)
          : null;
      if (loop === null && fanOut === null) {
        return;
      }
      if (ts.isCallExpression(awaited) && isQueryCall(awaited, true)) {
        if (loop !== null) {
          report(site, QUERY_MATCH);
        }
        return;
      }
      if (!ts.isCallExpression(awaited) && isExecutableQuery(typeOf(awaited))) {
        if (loop !== null) {
          report(site, QUERY_MATCH);
        }
        return;
      }
      if (fanOut !== null) {
        report(site, fanOut);
        return;
      }
      if (loop === null) {
        return;
      }
      let match: Match | null = null;
      if (ts.isCallExpression(awaited)) {
        const handle = findHandleArgument(awaited);
        if (handle !== null) {
          match = { kind: "handle", subject: handle };
        } else {
          const body = resolveCalleeBody(awaited);
          if (body !== null && summarize(body, HELPER_HOPS - 1) !== null) {
            match = {
              kind: "helper",
              subject: subjectText(awaited.expression),
            };
          }
        }
      }
      if (match === null) {
        if (isUnclassified(awaited)) {
          unclassified.push({
            file,
            ...location(site),
            subject: subjectText(awaited),
          });
        }
        return;
      }
      if (loop.fanOut !== null && cachedFanOutMatch(loop.fanOut) !== null) {
        // The enclosing fan-out already reports on its own await; one fan-out
        // must not cost two suppressions.
        return;
      }
      report(site, match);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node)) {
        inspectSite(node, unwrap(node.expression));
      } else if (
        ts.isYieldExpression(node) &&
        node.asteriskToken !== undefined &&
        node.expression !== undefined
      ) {
        const argument = resultAwaitArgument(node.expression);
        if (argument !== null) {
          inspectSite(node, argument);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    const directives = parseDirectives(sourceFile, file);
    directiveProblems.push(...directives.problems);
    for (const hit of fileHits) {
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
  ): number => a.file.localeCompare(b.file) || a.line - b.line;

  return {
    hits: hits.toSorted(byLocation),
    suppressedHits,
    directiveProblems: directiveProblems.toSorted(byLocation),
    unclassified: unclassified.toSorted(byLocation),
    filesScanned,
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

const readProjectFileNames = (configPath: string): readonly string[] => {
  const configFile = ts.readConfigFile(configPath, (file) =>
    ts.sys.readFile(file),
  );
  if (configFile.error !== undefined) {
    panic(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  return ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  ).fileNames;
};

const run = (): number => {
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
      API_PROJECTS.flatMap((project) =>
        readProjectFileNames(path.join(REPO_ROOT, project)),
      ),
    ),
  ];
  const program = createProgram({
    configPath: path.join(REPO_ROOT, mainProject),
    rootNames,
  });
  const programReady = performance.now();

  const report = scanDbAwaitInLoop({
    program,
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
      console.log(`  ${site.file}:${site.line}:${site.column} ${site.subject}`);
    }
  }

  const seconds = (milliseconds: number): string =>
    (milliseconds / 1000).toFixed(1);
  const peakMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(
    `db-await-in-loop: ${report.filesScanned} files, program ${seconds(programReady - started)}s, scan ${seconds(finished - programReady)}s, peak RSS ${peakMiB} MiB; ${report.suppressedHits} suppressed, ${report.hits.length} unsuppressed, ${report.directiveProblems.length} directive problem(s)`,
  );

  return report.hits.length > 0 || report.directiveProblems.length > 0 ? 1 : 0;
};

if (import.meta.main) {
  process.exitCode = run();
}
