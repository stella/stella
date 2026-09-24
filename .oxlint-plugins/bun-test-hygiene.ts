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

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  isAstNode,
  isStringLiteral,
  memberPropertyName,
  resolveImportedExpression,
  unwrapExpression,
} from "./utils.ts";
import type { AstNode, ScopeContext } from "./utils.ts";

const BUN_TEST_MODULE = "bun:test";

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
    const binding = resolveImportedExpression(context, current);
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

export default eslintCompatPlugin({
  meta: { name: "bun-test-hygiene" },
  rules: {
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
