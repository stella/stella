// Test-run hygiene for suites written against `bun:test`.
//
// Oxlint's jest and vitest rules recognise their own frameworks' imports and
// globals, not `bun:test`, so a committed `test.only` or an unexplained
// `test.skip` in a Bun suite passes lint. These rules resolve each test
// function through its import (named, aliased, or a namespace member such as
// `bt.test`) and only consider calls that reach a `bun:test` export.
//
// no-focused-tests
//   Flagged: test.only(...), it.only(...), describe.only(...), test["only"],
//            test.only.each(table)(...), test.if(condition).only(...)
//
// no-disabled-tests
//   Flagged without a reason comment on the same line or directly above:
//            test.skip(...), test.todo(...), describe.skip(...), xtest(...),
//            xit(...), xdescribe(...)
//   Allowed: the conditional forms (`test.skipIf(condition)`,
//            `test.todoIf(condition)`, `test.if(condition)`), and a disabled
//            registration inside a branch of the block it belongs to
//            (`if (!databaseUrl) describe.skip(...) else describe(...)`);
//            both state their reason in code.
//
// no-identical-title
//   Flagged: two tests (or two describe blocks) with the same static title in
//            the same block. Titles built from expressions and `.each` format
//            strings are not compared, and each branch of a conditional is a
//            block of its own, so the skipped and the real registration of
//            one suite may share a title.
//
// no-promise-matchers
//   Flagged: expect(promise).rejects.*, expect(promise).resolves.*, also
//            after `.not`, on the `bun:test` `expect` (named, aliased, or a
//            namespace member).
//            An `expect(...).rejects` that is not awaited can settle after the
//            test ends, so its failure lands on a later test or is lost.
//   Allowed: `expect(await promise)...` for a resolved value, and
//            `expect(await rejectionOf(promise))...` (from
//            `@stll/property-testing/rejection`) for a rejection. Another
//            framework's `expect` (Playwright) is not considered.
//
// no-unmanaged-database-client
//   Flagged: constructing a database client, called or with `new`, through
//            its import: `SQL` from `bun` (and `Bun.SQL`), `createSqlClient`
//            from `apps/api/src/db/sql-client.ts`, `drizzle(url)` or
//            `drizzle({ connection })` from a network drizzle driver,
//            `postgres` from `postgres`, `Pool` and `Client` from `pg`.
//   Also flagged: closing the shared-process client imported from `db/root`,
//   including stable database, client, and close-method aliases.
//   Allowed: `drizzle({ client })`, which wraps a client opened elsewhere,
//   and closing clients owned by a gated-test-database fixture.
//   The gated suites run in one process, so a client a test leaves open
//   holds its connections for the rest of the run. Tests open them through
//   `apps/api/src/tests/gated-test-database.ts`, which closes every client it
//   opens; the lint config exempts that module.
//
// require-module-mock-reset
//   Every test using a module-scope standalone `mock(...)` binding must be
//   enclosed by a `beforeEach` or `afterEach` that restores its default state:
//   `mock()` needs `mockReset()`; `mock(implementation)` needs `mockReset()`
//   followed by a default implementation; and a mock whose implementation is
//   never overridden may use `mockClear()`. A parent describe's hook covers
//   nested suites, but not sibling suites. A spy must be created in a
//   `beforeEach` (never at module scope) and an enclosing `afterEach` must call
//   `mock.restore()`: restoring a spy detaches it for the rest of the file.

import { eslintCompatPlugin } from "@oxlint/plugins";
import { panic } from "better-result";

import {
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  isStringLiteral,
  memberPropertyName,
  resolveImport,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  stableInitializer,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode, FilenameContext, ScopeContext } from "./utils.ts";

const BUN_TEST_MODULE = "bun:test";
const EXPECT_EXPORT = "expect";
const MODULE_MOCK_EXPORTS = new Set(["mock", "spyOn"]);
const FILE_HOOK_EXPORTS = new Set(["beforeEach", "afterEach"]);
const MOCK_DEFAULT_METHODS = new Set([
  "mockImplementation",
  "mockReturnValue",
  "mockResolvedValue",
  "mockRejectedValue",
]);
const MOCK_OVERRIDE_METHODS = new Set([
  ...MOCK_DEFAULT_METHODS,
  "mockImplementationOnce",
  "mockReturnValueOnce",
  "mockResolvedValueOnce",
  "mockRejectedValueOnce",
]);

const FORCED_DATABASE_DROP =
  /(?:^|;)\s*DROP\s+DATABASE\b[^;]*(?:\bWITH\s*)?\(\s*FORCE\b/iu;
const SQL_IDENTIFIER_CHARACTER = /[A-Za-z0-9_$\u0080-\u{10ffff}]/u;
const SQL_DOLLAR_QUOTE =
  /\$(?:[A-Za-z_\u0080-\u{10ffff}][A-Za-z0-9_\u0080-\u{10ffff}]*)?\$/uy;

type SqlMaskState =
  | { type: "code" }
  | { type: "line-comment" }
  | { type: "block-comment"; depth: number }
  | { type: "quoted-identifier" }
  | { type: "quoted-string"; syntax: "standard" | "escaped" }
  | { type: "dollar-quoted"; delimiter: string };

// A quote inside a comment belongs to that comment, and vice versa.
const maskSqlValuesAndComments = (text: string) => {
  const masked: string[] = [];
  let state: SqlMaskState = { type: "code" };
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    const next = text.charAt(index + 1);
    switch (state.type) {
      case "line-comment":
        if (character === "\n" || character === "\r") {
          masked.push(character);
          state = { type: "code" };
        }
        continue;
      case "block-comment":
        if (character === "/" && next === "*") {
          state.depth++;
          index++;
        } else if (character === "*" && next === "/") {
          state.depth--;
          index++;
          if (state.depth === 0) {
            state = { type: "code" };
          }
        }
        continue;
      case "quoted-identifier":
        if (character === '"') {
          if (next === '"') {
            index++;
          } else {
            state = { type: "code" };
          }
        }
        continue;
      case "quoted-string":
        if (state.syntax === "escaped" && character === "\\") {
          index++;
        } else if (character === "'") {
          if (next === "'") {
            index++;
          } else {
            state = { type: "code" };
          }
        }
        continue;
      case "dollar-quoted":
        if (text.startsWith(state.delimiter, index)) {
          index += state.delimiter.length - 1;
          state = { type: "code" };
        }
        continue;
      case "code":
        if (character === "-" && next === "-") {
          masked.push(" ");
          state = { type: "line-comment" };
          index++;
          continue;
        }
        if (character === "/" && next === "*") {
          masked.push(" ");
          state = { type: "block-comment", depth: 1 };
          index++;
          continue;
        }
        if (character === '"') {
          masked.push(" __value__ ");
          state = { type: "quoted-identifier" };
          continue;
        }
        if (character === "'") {
          masked.push(" __value__ ");
          state = {
            type: "quoted-string",
            syntax:
              /[eE]/u.test(text.charAt(index - 1)) &&
              !SQL_IDENTIFIER_CHARACTER.test(text.charAt(index - 2))
                ? "escaped"
                : "standard",
          };
          continue;
        }
        if (
          character === "$" &&
          !SQL_IDENTIFIER_CHARACTER.test(text.charAt(index - 1))
        ) {
          SQL_DOLLAR_QUOTE.lastIndex = index;
          const delimiter = SQL_DOLLAR_QUOTE.exec(text)?.at(0);
          if (delimiter !== undefined) {
            masked.push(" __value__ ");
            state = { type: "dollar-quoted", delimiter };
            index += delimiter.length - 1;
            continue;
          }
        }
        masked.push(character);
        continue;
      default: {
        state satisfies never;
        panic("Unhandled SQL masking state");
      }
    }
  }
  return masked.join("");
};

const databaseDropText = (node: unknown) => {
  if (isStringLiteral(node)) {
    return node.value;
  }
  if (
    !isAstNode(node) ||
    node.type !== "TemplateLiteral" ||
    !Array.isArray(node.quasis)
  ) {
    return null;
  }
  return node.quasis
    .map((quasi: unknown) => {
      const value = isAstNode(quasi) ? quasi.value : null;
      return typeof value === "object" &&
        value !== null &&
        "cooked" in value &&
        typeof value.cooked === "string"
        ? value.cooked
        : "";
    })
    .join(" __identifier__ ");
};

const TEST_KIND = { describe: "describe", test: "test" } as const;
type TestKind = (typeof TEST_KIND)[keyof typeof TEST_KIND];

// `bun:test` exports that register a test or a block, by what they register.
const TEST_FUNCTIONS: ReadonlyMap<string, TestKind> = new Map([
  ["describe", TEST_KIND.describe],
  ["xdescribe", TEST_KIND.describe],
  ["it", TEST_KIND.test],
  ["test", TEST_KIND.test],
  ["xit", TEST_KIND.test],
  ["xtest", TEST_KIND.test],
]);

// Exports that are the disabled form of a test function themselves.
const DISABLED_FUNCTIONS = new Set(["xdescribe", "xit", "xtest"]);

const PROMISE_MATCHER_PROPERTIES = new Set(["rejects", "resolves"]);
const NEGATION_MODIFIER = "not";

const FOCUS_MODIFIER = "only";
const DISABLE_MODIFIERS = new Set(["skip", "todo"]);
const EACH_MODIFIER = "each";

const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

// Comments that configure tooling rather than explain anything. The fixture
// harness (scripts/check-oxlint-fixture-counts.ts) rewrites disable directives
// into `fixture-expect` markers, which are directives too.
const DIRECTIVE_COMMENT =
  /^\s*(?:oxlint-|eslint-|@ts-|expect-clean:|fixture-expect\b|prettier-ignore)/u;
const HAS_LETTER = /\p{L}/u;

type TestRegistration = {
  call: AstNode;
  exportName: string;
  kind: TestKind;
  // Member and call modifiers between the export and the registering call,
  // in source order: `test.only.each(table)(...)` has ["only", "each"].
  modifiers: string[];
};

// A call is the registering one when nothing further chains off it:
// `test.if(condition)` inside `test.if(condition)("title", fn)` only selects
// a modifier, and reporting both would count the same test twice.
const isOutermostCall = (call: AstNode): boolean => {
  const parent = call.parent;
  if (!isAstNode(parent)) {
    return true;
  }
  if (parent.type === "CallExpression" && parent.callee === call) {
    return false;
  }
  return !(parent.type === "MemberExpression" && parent.object === call);
};

// The `bun:test` registration a call performs, following the callee chain
// through member modifiers (`.only`, `["skip"]`) and modifier calls
// (`.if(condition)`, `.each(table)`) down to the imported test function.
const testRegistration = (
  context: ScopeContext,
  call: unknown,
): TestRegistration | null => {
  if (
    !isAstNode(call) ||
    call.type !== "CallExpression" ||
    !isOutermostCall(call)
  ) {
    return null;
  }
  const modifiers: string[] = [];
  let current = unwrapExpression(call.callee);
  while (current !== null) {
    const binding = resolveImportedExpressionForEnforcement(context, current);
    const kind =
      binding?.source === BUN_TEST_MODULE
        ? TEST_FUNCTIONS.get(binding.imported)
        : undefined;
    if (binding !== null && kind !== undefined) {
      return { call, exportName: binding.imported, kind, modifiers };
    }
    if (current.type === "MemberExpression") {
      const modifier = memberPropertyName(current);
      if (modifier === null) {
        return null;
      }
      modifiers.unshift(modifier);
      current = unwrapExpression(current.object);
      continue;
    }
    if (current.type !== "CallExpression") {
      return null;
    }
    current = unwrapExpression(current.callee);
  }
  return null;
};

const describeRegistration = ({
  exportName,
  modifiers,
}: TestRegistration): string => [exportName, ...modifiers].join(".");

type SourceComment = { range: [number, number]; value: string };

const lineStartOf = (text: string, offset: number): number =>
  text.lastIndexOf("\n", offset - 1) + 1;

const lineEndOf = (text: string, offset: number): number => {
  const end = text.indexOf("\n", offset);
  return end === -1 ? text.length : end;
};

const isReasonComment = (comment: SourceComment): boolean =>
  !DIRECTIVE_COMMENT.test(comment.value) && HAS_LETTER.test(comment.value);

type ReasonLookup = {
  comments: readonly SourceComment[];
  node: AstNode;
  text: string;
};

// A reason is a non-directive comment on the call's first line, or in the
// unbroken run of own-line comments directly above it (directives such as a
// disable comment may sit in that run).
const hasReasonComment = ({ comments, node, text }: ReasonLookup): boolean => {
  const lineStart = lineStartOf(text, node.range[0]);
  const lineEnd = lineEndOf(text, node.range[0]);
  if (
    comments.some(
      (comment) =>
        comment.range[0] >= lineStart &&
        comment.range[0] < lineEnd &&
        isReasonComment(comment),
    )
  ) {
    return true;
  }
  let boundary = lineStart;
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
    if (isReasonComment(comment)) {
      return true;
    }
    boundary = commentLineStart;
  }
  return false;
};

const isSourceComment = (value: unknown): value is SourceComment =>
  typeof value === "object" &&
  value !== null &&
  "value" in value &&
  typeof value.value === "string" &&
  "range" in value &&
  Array.isArray(value.range) &&
  value.range.length === 2 &&
  value.range.every((offset) => typeof offset === "number");

// A title the rule can compare: a string literal or a template without
// substitutions.
const staticTitle = (node: unknown): string | null => {
  const title = unwrapExpression(node);
  if (isStringLiteral(title)) {
    return title.value;
  }
  if (
    !isAstNode(title) ||
    title.type !== "TemplateLiteral" ||
    !Array.isArray(title.expressions) ||
    title.expressions.length > 0 ||
    !Array.isArray(title.quasis)
  ) {
    return null;
  }
  const quasi: unknown = title.quasis.at(0);
  if (!isAstNode(quasi)) {
    return null;
  }
  // `TemplateElement.value` is a plain `{ raw, cooked }` record, not a node.
  const value: unknown = quasi.value;
  return typeof value === "object" &&
    value !== null &&
    "cooked" in value &&
    typeof value.cooked === "string"
    ? value.cooked
    : null;
};

// Whether `node` is one of the mutually exclusive arms of its parent.
const isConditionalBranch = (node: AstNode): boolean => {
  const parent = node.parent;
  if (!isAstNode(parent)) {
    return false;
  }
  if (
    parent.type === "IfStatement" ||
    parent.type === "ConditionalExpression"
  ) {
    return parent.consequent === node || parent.alternate === node;
  }
  return parent.type === "LogicalExpression" && parent.right === node;
};

type EnclosingBlock = { node: unknown; conditional: boolean };

// The block a registration belongs to: the nearest enclosing function (a
// describe callback, or a helper), conditional branch, or the file itself.
const enclosingBlock = (node: AstNode): EnclosingBlock => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (isConditionalBranch(current)) {
      return { node: current, conditional: true };
    }
    const parent = current.parent;
    if (
      isAstNode(parent) &&
      (FUNCTION_TYPES.has(parent.type) || parent.type === "Program")
    ) {
      return { node: parent, conditional: false };
    }
    current = parent;
  }
  return { node: null, conditional: false };
};

const mentionsBunTest = (text: string): boolean =>
  text.includes(BUN_TEST_MODULE);

const isProgram = (node: unknown): boolean =>
  isAstNode(node) && node.type === "Program";

const bunTestExport = (context: ScopeContext, node: unknown): string | null => {
  const binding = resolveImportedExpressionForEnforcement(context, node);
  return binding?.source === BUN_TEST_MODULE ? binding.imported : null;
};

const isModuleMockCreation = (
  context: ScopeContext,
  node: AstNode,
): boolean => {
  const callee = unwrapExpression(node.callee);
  const directExport = bunTestExport(context, callee);
  if (directExport !== null && MODULE_MOCK_EXPORTS.has(directExport)) {
    return true;
  }
  return (
    isAstNode(callee) &&
    callee.type === "MemberExpression" &&
    memberPropertyName(callee) === "module" &&
    bunTestExport(context, callee.object) === "mock"
  );
};

const enclosingHook = (
  context: ScopeContext,
  node: AstNode,
): { exportName: string; scope: unknown; call: AstNode } | null => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      const call = current.parent;
      if (
        !isAstNode(call) ||
        call.type !== "CallExpression" ||
        !Array.isArray(call.arguments) ||
        !call.arguments.includes(current)
      ) {
        return null;
      }
      const exportName = bunTestExport(context, call.callee);
      if (exportName === null || !FILE_HOOK_EXPORTS.has(exportName)) {
        return null;
      }
      return { exportName, scope: enclosingBlock(call).node, call };
    }
    current = current.parent;
  }
  return null;
};

const enclosingSpyLifecycle = (
  context: ScopeContext,
  node: AstNode,
): "beforeEach" | "test" | null => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      const call = current.parent;
      if (
        !isAstNode(call) ||
        call.type !== "CallExpression" ||
        !Array.isArray(call.arguments) ||
        !call.arguments.includes(current)
      ) {
        return null;
      }
      if (bunTestExport(context, call.callee) === "beforeEach") {
        return "beforeEach";
      }
      // A spy created in a test body outlives the test unless an enclosing
      // afterEach restores it.
      return testRegistration(context, call)?.kind === TEST_KIND.test
        ? "test"
        : null;
    }
    current = current.parent;
  }
  return null;
};

// What one hook call does to module mocks, in order.
type HookCalls = {
  scope: unknown;
  resets: Set<string>;
  reinstalled: Set<string>;
  clears: Set<string>;
};

/** Whether a hook leaves `binding` reset with its default before a test. */
const keepsDefault = (
  calls: HookCalls,
  binding: string,
  hasDefault: boolean,
  isOverridden: boolean,
): boolean =>
  (calls.resets.has(binding) &&
    (!hasDefault || calls.reinstalled.has(binding))) ||
  (calls.clears.has(binding) && !isOverridden);

const resetRequirement = (hasDefault: boolean, isOverridden: boolean) => {
  if (!hasDefault) {
    return "use mockReset() in an enclosing hook";
  }
  return isOverridden
    ? "use mockReset() and reinstall its default implementation in the same enclosing hook"
    : "use mockReset() and reinstall its default implementation, or use mockClear() because nothing overrides it";
};

/** Whether a spy's own test restores it in a `finally` block. */
const restoredByOwnTest = (
  spy: { test: AstNode | null; binding: string | null },
  finallyRestores: ReadonlyMap<AstNode, ReadonlySet<string>>,
): boolean =>
  spy.test !== null &&
  [...(finallyRestores.get(spy.test) ?? [])].some(
    (name) => name === "*" || name === spy.binding,
  );

/** The callback of the test registration a node runs in, if any. */
const enclosingTestCallback = (
  context: ScopeContext,
  node: AstNode,
): AstNode | null => {
  let current: unknown = node;
  while (isAstNode(current)) {
    if (FUNCTION_TYPES.has(current.type)) {
      const call = current.parent;
      return isAstNode(call) &&
        call.type === "CallExpression" &&
        Array.isArray(call.arguments) &&
        call.arguments.includes(current) &&
        testRegistration(context, call)?.kind === TEST_KIND.test
        ? current
        : null;
    }
    current = current.parent;
  }
  return null;
};

/** Whether a node sits in the `finally` block of a try statement. */
const inFinally = (node: AstNode): boolean => {
  let current: unknown = node;
  while (isAstNode(current) && !FUNCTION_TYPES.has(current.type)) {
    const parent: unknown = current.parent;
    if (
      isAstNode(parent) &&
      parent.type === "TryStatement" &&
      parent.finalizer === current
    ) {
      return true;
    }
    current = parent;
  }
  return false;
};

/** The variable a spy is bound to, through chained configuration calls. */
const spyBinding = (node: AstNode): string | null => {
  let current: unknown = node;
  while (isAstNode(current)) {
    const parent: unknown = current.parent;
    if (!isAstNode(parent)) {
      return null;
    }
    if (parent.type === "VariableDeclarator") {
      return identifierName(parent.id);
    }
    if (
      parent.type !== "MemberExpression" &&
      parent.type !== "CallExpression"
    ) {
      return null;
    }
    current = parent;
  }
  return null;
};

const calledMember = (
  node: AstNode,
): { object: AstNode; property: string } | null => {
  const callee = unwrapExpression(node.callee);
  if (!isAstNode(callee) || callee.type !== "MemberExpression") {
    return null;
  }
  const object = unwrapExpression(callee.object);
  const property = memberPropertyName(callee);
  return object === null || property === null ? null : { object, property };
};

const identifierName = (node: unknown): string | null =>
  isAstNode(node) && node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : null;

const enclosingTestScopes = (
  context: ScopeContext,
  node: AstNode,
): unknown[] => {
  const scopes: unknown[] = [];
  let current: unknown = node;
  while (isAstNode(current)) {
    if (current.type === "Program") {
      scopes.push(current);
      break;
    }
    if (FUNCTION_TYPES.has(current.type)) {
      const call = current.parent;
      if (
        isAstNode(call) &&
        call.type === "CallExpression" &&
        Array.isArray(call.arguments) &&
        call.arguments.includes(current) &&
        testRegistration(context, call)?.kind === TEST_KIND.describe
      ) {
        scopes.push(current);
      }
    }
    current = current.parent;
  }
  return scopes;
};

// Exports that open a database connection pool when constructed, by module.
const CLIENT_CONSTRUCTORS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["bun", new Set(["SQL"])],
  ["postgres", new Set(["default"])],
  ["pg", new Set(["Pool", "Client"])],
]);

// Drizzle drivers whose `drizzle` opens its own client from a URL or a
// `connection` option.
const DRIZZLE_NETWORK_DRIVERS = new Set([
  "drizzle-orm/bun-sql",
  "drizzle-orm/node-postgres",
  "drizzle-orm/postgres-js",
]);

// The repository owner every Bun SQL client is built through; its factory
// opens a pool exactly like `new SQL`.
const SQL_CLIENT_OWNER = "apps/api/src/db/sql-client";
const SQL_CLIENT_FACTORY = "createSqlClient";

const CLIENT_CONSTRUCTOR_HINT =
  /\bSQL\b|drizzle|postgres|\bpg\b|createSqlClient|\brootDb\b|db\/(?:root|sql-close)/u;

// `Bun.SQL`, with `Bun` the runtime global rather than a local binding.
const isGlobalBunSql = (context: ScopeContext, callee: AstNode): boolean => {
  if (
    callee.type !== "MemberExpression" ||
    memberPropertyName(callee) !== "SQL"
  ) {
    return false;
  }
  const object = unwrapExpression(callee.object);
  return (
    isIdentifierReference(object) &&
    object.name === "Bun" &&
    resolveVariable(context, object) === null
  );
};

// `drizzle({ client })` wraps a client something else opened and closes; any
// other argument (a URL, a `connection` option, or nothing) makes the driver
// open one.
const wrapsProvidedClient = (argument: unknown): boolean => {
  const options = unwrapExpression(argument);
  if (
    !isAstNode(options) ||
    options.type !== "ObjectExpression" ||
    !Array.isArray(options.properties)
  ) {
    return false;
  }
  const keys = new Set(
    options.properties.map((property: unknown) =>
      isAstNode(property) && property.type === "Property"
        ? getPropertyName(property.key)
        : null,
    ),
  );
  return keys.has("client") && !keys.has("connection");
};

// The client a call or `new` expression constructs, named for the report, or
// null when it constructs none.
const constructedClient = (
  context: ScopeContext & FilenameContext,
  node: unknown,
): string | null => {
  if (!isAstNode(node)) {
    return null;
  }
  const callee = unwrapExpression(node.callee);
  if (!isAstNode(callee)) {
    return null;
  }
  if (isGlobalBunSql(context, callee)) {
    return "Bun.SQL";
  }
  const owned = resolveImport(context, callee);
  if (
    owned?.moduleId === SQL_CLIENT_OWNER &&
    owned.imported === SQL_CLIENT_FACTORY
  ) {
    return SQL_CLIENT_FACTORY;
  }
  const binding = resolveImportedExpressionForEnforcement(context, callee);
  if (binding === null) {
    return null;
  }
  if (CLIENT_CONSTRUCTORS.get(binding.source)?.has(binding.imported) === true) {
    return binding.imported === "default"
      ? binding.source
      : `${binding.imported} from "${binding.source}"`;
  }
  if (
    node.type === "CallExpression" &&
    binding.imported === "drizzle" &&
    DRIZZLE_NETWORK_DRIVERS.has(binding.source) &&
    !wrapsProvidedClient(
      Array.isArray(node.arguments) ? node.arguments.at(0) : undefined,
    )
  ) {
    return `drizzle from "${binding.source}"`;
  }
  return null;
};

type SharedDatabaseProvenance = "database" | "client" | "close";

const sharedDatabaseMember = (
  source: SharedDatabaseProvenance | null,
  property: string | null,
): SharedDatabaseProvenance | null => {
  switch (source) {
    case "database":
      return property === "$client" ? "client" : null;
    case "client":
      return property === "close" ? "close" : null;
    case "close":
    case null:
      return null;
    default:
      source satisfies never;
      return panic("Unhandled shared database provenance");
  }
};

type DestructuredSharedDatabaseOptions = {
  pattern: unknown;
  binding: unknown;
  source: SharedDatabaseProvenance | null;
};

const destructuredSharedDatabase = ({
  pattern,
  binding,
  source,
}: DestructuredSharedDatabaseOptions): SharedDatabaseProvenance | null => {
  if (source === null || !isAstNode(pattern)) {
    return null;
  }
  if (pattern === binding) {
    return source;
  }
  if (pattern.type === "AssignmentPattern") {
    return destructuredSharedDatabase({
      pattern: pattern.left,
      binding,
      source,
    });
  }
  if (pattern.type !== "ObjectPattern" || !Array.isArray(pattern.properties)) {
    return null;
  }
  for (const property of pattern.properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      (property.computed === true && !isStringLiteral(property.key))
    ) {
      continue;
    }
    const selected = destructuredSharedDatabase({
      pattern: property.value,
      binding,
      source: sharedDatabaseMember(source, getPropertyName(property.key)),
    });
    if (selected !== null) {
      return selected;
    }
  }
  return null;
};

type SharedDatabaseProvenanceOptions = {
  context: ScopeContext & FilenameContext;
  node: unknown;
  seen?: Set<unknown>;
};

const sharedDatabaseProvenance = ({
  context,
  node,
  seen = new Set<unknown>(),
}: SharedDatabaseProvenanceOptions): SharedDatabaseProvenance | null => {
  const expression = unwrapExpression(node);
  if (expression === null || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  const imported = resolveImport(context, expression);
  if (
    imported?.moduleId === "apps/api/src/db/root" &&
    imported.imported === "rootDb"
  ) {
    return "database";
  }
  if (expression.type === "MemberExpression") {
    return sharedDatabaseMember(
      sharedDatabaseProvenance({ context, node: expression.object, seen }),
      memberPropertyName(expression),
    );
  }
  if (!isIdentifierReference(expression)) {
    return null;
  }
  const variable = resolveVariable(context, expression);
  if (variable === null) {
    return null;
  }
  const initializer = stableInitializer(variable);
  if (initializer === null) {
    return null;
  }
  const source = sharedDatabaseProvenance({ context, node: initializer, seen });
  const definition = variable.defs.at(0);
  const declaration = definition?.node;
  return isAstNode(declaration) &&
    isAstNode(declaration.id) &&
    declaration.id.type === "ObjectPattern"
    ? destructuredSharedDatabase({
        pattern: declaration.id,
        binding: definition?.name,
        source,
      })
    : source;
};

const closesSharedDatabaseClient = (
  context: ScopeContext & FilenameContext,
  node: unknown,
) => {
  if (!isAstNode(node) || node.type !== "CallExpression") {
    return false;
  }
  if (sharedDatabaseProvenance({ context, node: node.callee }) === "close") {
    return true;
  }
  const helper = resolveImport(context, node.callee);
  return (
    helper?.moduleId === "apps/api/src/db/sql-close" &&
    helper.imported === "forceClosePool" &&
    Array.isArray(node.arguments) &&
    sharedDatabaseProvenance({ context, node: node.arguments.at(0) }) ===
      "client"
  );
};

export default eslintCompatPlugin({
  meta: { name: "bun-test-hygiene" },
  rules: {
    "require-module-mock-reset": {
      meta: {
        type: "problem",
        messages: {
          missingReset:
            'Module-level mock "{{binding}}" is not reset for test "{{test}}". {{required}}; `mock.restore()` covers spies only.',
          moduleSpy:
            "A module-level spy is detached as soon as `mock.restore()` runs. Create it in `beforeEach` and restore it with `mock.restore()` in an enclosing `afterEach`.",
          missingSpyRestore:
            "This spy must be restored with `mock.restore()` in an enclosing `afterEach`, or, when the test creates it, by the test's own `finally`; a restore in `beforeEach` detaches it before the test runs.",
        },
      },
      createOnce(context) {
        const moduleMocks = new Map<string, AstNode>();
        const tests: { node: AstNode; title: string }[] = [];
        // Per hook call: what it resets, reinstalls after resetting, and clears.
        const hookCalls = new Map<AstNode, HookCalls>();
        const overriddenMocks = new Set<string>();
        const spies: {
          node: AstNode;
          scopes: unknown[];
          test: AstNode | null;
          binding: string | null;
        }[] = [];
        // Per test callback: spies its `finally` blocks restore ("*" for all).
        const finallyRestores = new Map<AstNode, Set<string>>();
        const afterEachRestoreScopes = new Set<unknown>();
        const recordTest = (node: AstNode) => {
          if (testRegistration(context, node)?.kind !== TEST_KIND.test) {
            return;
          }
          tests.push({
            node,
            title:
              staticTitle(
                Array.isArray(node.arguments) ? node.arguments.at(0) : null,
              ) ?? "<dynamic title>",
          });
        };
        // A module-scope mock binding to track, or a module-scope spy, which
        // is reported (true) because no restore can keep it attached.
        const recordModuleMock = (node: AstNode): boolean => {
          if (
            !isProgram(enclosingBlock(node).node) ||
            !isModuleMockCreation(context, node)
          ) {
            return false;
          }
          if (
            bunTestExport(context, unwrapExpression(node.callee)) === "spyOn"
          ) {
            context.report({ node, messageId: "moduleSpy" });
            return true;
          }
          const declarator = node.parent;
          const name =
            isAstNode(declarator) && declarator.type === "VariableDeclarator"
              ? identifierName(declarator.id)
              : null;
          if (name !== null) {
            moduleMocks.set(name, node);
          }
          return false;
        };
        const recordSpyLifecycle = (
          node: AstNode,
          member: ReturnType<typeof calledMember>,
        ) => {
          if (
            bunTestExport(context, unwrapExpression(node.callee)) === "spyOn" &&
            enclosingSpyLifecycle(context, node) !== null
          ) {
            spies.push({
              node,
              scopes: enclosingTestScopes(context, node),
              test: enclosingTestCallback(context, node),
              binding: spyBinding(node),
            });
          }
          const test =
            member === null ? null : enclosingTestCallback(context, node);
          if (test !== null && member !== null && inFinally(node)) {
            const restored =
              member.property === "restore" &&
              bunTestExport(context, member.object) === "mock"
                ? "*"
                : member.property === "mockRestore"
                  ? identifierName(member.object)
                  : null;
            if (restored !== null) {
              const names = finallyRestores.get(test) ?? new Set<string>();
              names.add(restored);
              finallyRestores.set(test, names);
            }
          }
          const hook = enclosingHook(context, node);
          if (
            hook?.exportName === "afterEach" &&
            member?.property === "restore" &&
            bunTestExport(context, member.object) === "mock"
          ) {
            afterEachRestoreScopes.add(hook.scope);
          }
        };
        // An implementation override outside the reset hooks.
        const recordOverride = (member: ReturnType<typeof calledMember>) => {
          const name = member === null ? null : identifierName(member.object);
          if (
            member !== null &&
            name !== null &&
            MOCK_OVERRIDE_METHODS.has(member.property)
          ) {
            overriddenMocks.add(name);
          }
        };
        const recordHookReset = (
          hook: NonNullable<ReturnType<typeof enclosingHook>>,
          member: NonNullable<ReturnType<typeof calledMember>>,
        ) => {
          if (
            member.property === "restore" &&
            bunTestExport(context, member.object) === "mock"
          ) {
            return;
          }
          const name = identifierName(member.object);
          if (name === null) {
            return;
          }
          const calls = hookCalls.get(hook.call) ?? {
            scope: hook.scope,
            resets: new Set<string>(),
            reinstalled: new Set<string>(),
            clears: new Set<string>(),
          };
          hookCalls.set(hook.call, calls);
          if (member.property === "mockReset") {
            calls.resets.add(name);
          } else if (MOCK_DEFAULT_METHODS.has(member.property)) {
            // Only a reinstall after the reset in this same hook restores the
            // default before the next test.
            if (calls.resets.has(name)) {
              calls.reinstalled.add(name);
            }
          } else if (member.property === "mockClear") {
            calls.clears.add(name);
          }
        };
        return {
          before() {
            moduleMocks.clear();
            tests.length = 0;
            hookCalls.clear();
            overriddenMocks.clear();
            spies.length = 0;
            afterEachRestoreScopes.clear();
            return mentionsBunTest(context.sourceCode.text);
          },
          CallExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            recordTest(node);
            if (recordModuleMock(node)) {
              return;
            }
            const member = calledMember(node);
            recordSpyLifecycle(node, member);
            const hook = enclosingHook(context, node);
            if (hook === null) {
              recordOverride(member);
              return;
            }
            if (member !== null) {
              recordHookReset(hook, member);
            }
          },
          "Program:exit"() {
            for (const spy of spies) {
              if (
                !restoredByOwnTest(spy, finallyRestores) &&
                !spy.scopes.some((scope) => afterEachRestoreScopes.has(scope))
              ) {
                context.report({
                  node: spy.node,
                  messageId: "missingSpyRestore",
                });
              }
            }
            for (const [binding, creation] of moduleMocks) {
              const hasDefault =
                Array.isArray(creation.arguments) &&
                creation.arguments.length > 0;
              const isOverridden = overriddenMocks.has(binding);
              const uncovered = tests.find(
                ({ node }) =>
                  !enclosingTestScopes(context, node).some((scope) =>
                    [...hookCalls.values()].some(
                      (calls) =>
                        calls.scope === scope &&
                        keepsDefault(calls, binding, hasDefault, isOverridden),
                    ),
                  ),
              );
              if (uncovered !== undefined) {
                context.report({
                  node: uncovered.node,
                  messageId: "missingReset",
                  data: {
                    binding,
                    test: uncovered.title,
                    required: resetRequirement(hasDefault, isOverridden),
                  },
                });
              }
            }
          },
        };
      },
    },
    "no-forced-database-drop": {
      meta: {
        type: "problem",
        messages: {
          forcedDrop:
            "Close fixture-owned database clients before a normal DROP DATABASE. FORCE requires backend-termination privileges and can terminate another fixture's sessions.",
        },
      },
      createOnce(context) {
        const report = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
        ) => {
          const text = databaseDropText(node);
          if (
            text !== null &&
            FORCED_DATABASE_DROP.test(maskSqlValuesAndComments(text))
          ) {
            context.report({ node, messageId: "forcedDrop" });
          }
        };
        return {
          before() {
            return /\bFORCE\b|\\[ux]/iu.test(context.sourceCode.text);
          },
          Literal: report,
          TemplateLiteral: report,
        };
      },
    },
    "no-focused-tests": {
      meta: {
        type: "problem",
        messages: {
          focused:
            "`{{call}}` focuses the run on this test, so every other test in " +
            "the file silently stops running. Remove `.only` before committing.",
        },
      },
      createOnce(context) {
        return {
          before() {
            return mentionsBunTest(context.sourceCode.text);
          },
          CallExpression(node) {
            const registration = testRegistration(context, node);
            if (
              registration === null ||
              !registration.modifiers.includes(FOCUS_MODIFIER)
            ) {
              return;
            }
            context.report({
              node,
              messageId: "focused",
              data: { call: describeRegistration(registration) },
            });
          },
        };
      },
    },
    "no-disabled-tests": {
      meta: {
        type: "problem",
        messages: {
          disabled:
            "`{{call}}` disables this test without a stated reason. Add a " +
            "comment on the same line or directly above saying why it is " +
            "disabled and what re-enables it, use a conditional form " +
            "(`.skipIf(condition)`, `.todoIf(condition)`), or remove it.",
        },
      },
      createOnce(context) {
        let comments: readonly SourceComment[] | null = null;

        return {
          before() {
            comments = null;
            return mentionsBunTest(context.sourceCode.text);
          },
          CallExpression(node) {
            const registration = testRegistration(context, node);
            if (
              registration === null ||
              (!DISABLED_FUNCTIONS.has(registration.exportName) &&
                !registration.modifiers.some((modifier) =>
                  DISABLE_MODIFIERS.has(modifier),
                ))
            ) {
              return;
            }
            if (enclosingBlock(registration.call).conditional) {
              return;
            }
            comments ??= context.sourceCode
              .getAllComments()
              .filter(isSourceComment);
            if (
              hasReasonComment({
                comments,
                node: registration.call,
                text: context.sourceCode.text,
              })
            ) {
              return;
            }
            context.report({
              node,
              messageId: "disabled",
              data: { call: describeRegistration(registration) },
            });
          },
        };
      },
    },
    "no-promise-matchers": {
      meta: {
        type: "problem",
        messages: {
          promiseMatcher:
            "`expect(...).{{property}}` can settle after the test ends when " +
            "it is not awaited. `await` the promise instead " +
            "(`expect(await promise)...`), or capture the rejection with " +
            "`rejectionOf` from `@stll/property-testing/rejection` " +
            "(`expect(await rejectionOf(promise))...`).",
        },
      },
      createOnce(context) {
        return {
          before() {
            return mentionsBunTest(context.sourceCode.text);
          },
          MemberExpression(node) {
            if (!isAstNode(node)) {
              return;
            }
            const property = memberPropertyName(node);
            if (
              property === null ||
              !PROMISE_MATCHER_PROPERTIES.has(property)
            ) {
              return;
            }
            // `expect(p).not.rejects` puts the modifier between the call and
            // the matcher property.
            let subject = unwrapExpression(node.object);
            while (
              isAstNode(subject) &&
              subject.type === "MemberExpression" &&
              memberPropertyName(subject) === NEGATION_MODIFIER
            ) {
              subject = unwrapExpression(subject.object);
            }
            if (!isAstNode(subject) || subject.type !== "CallExpression") {
              return;
            }
            const binding = resolveImportedExpressionForEnforcement(
              context,
              subject.callee,
            );
            if (
              binding?.source !== BUN_TEST_MODULE ||
              binding.imported !== EXPECT_EXPORT
            ) {
              return;
            }
            context.report({
              node,
              messageId: "promiseMatcher",
              data: { property },
            });
          },
        };
      },
    },
    "no-unmanaged-database-client": {
      meta: {
        type: "problem",
        messages: {
          unmanagedClient:
            "This test constructs a database client ({{client}}) that nothing " +
            "is bound to close. Open it through `openGatedTestDatabase` or " +
            "`withGatedTestClients` from `@/api/tests/gated-test-database`, " +
            "which close every client they open even when cleanup throws.",
          sharedClient:
            "This test closes a shared-process database client. Tests may close " +
            "only their own clients; use `openGatedTestDatabase` or " +
            "`withGatedTestClients` for fixture-owned connections.",
        },
      },
      createOnce(context) {
        const report = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
        ) => {
          const client = constructedClient(context, node);
          if (client === null) {
            return;
          }
          context.report({
            node,
            messageId: "unmanagedClient",
            data: { client },
          });
        };

        return {
          before() {
            return CLIENT_CONSTRUCTOR_HINT.test(context.sourceCode.text);
          },
          CallExpression(node) {
            if (closesSharedDatabaseClient(context, node)) {
              context.report({ node, messageId: "sharedClient" });
              return;
            }
            report(node);
          },
          NewExpression(node) {
            report(node);
          },
        };
      },
    },
    "no-identical-title": {
      meta: {
        type: "problem",
        messages: {
          identicalTitle:
            "Another {{kind}} in this block is already titled '{{title}}'. " +
            "Rename one to say what differs, so a failure names the case " +
            "that failed.",
        },
      },
      createOnce(context) {
        // Titles seen per enclosing block, keyed by kind and title.
        const titlesByBlock = new Map<unknown, Set<string>>();

        return {
          before() {
            titlesByBlock.clear();
            return mentionsBunTest(context.sourceCode.text);
          },
          CallExpression(node) {
            const registration = testRegistration(context, node);
            if (
              registration === null ||
              registration.modifiers.includes(EACH_MODIFIER)
            ) {
              return;
            }
            const { arguments: args } = registration.call;
            const title = staticTitle(
              Array.isArray(args) ? args.at(0) : undefined,
            );
            if (title === null) {
              return;
            }
            const block = enclosingBlock(registration.call).node;
            const seen = titlesByBlock.get(block) ?? new Set<string>();
            titlesByBlock.set(block, seen);
            const key = `${registration.kind}\u0000${title}`;
            if (!seen.has(key)) {
              seen.add(key);
              return;
            }
            context.report({
              node,
              messageId: "identicalTitle",
              data: { kind: registration.kind, title },
            });
          },
        };
      },
    },
  },
});
