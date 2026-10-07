// Empty and constant fallback handlers discard failures. Item loops must
// surface them; tests must assert outcomes or explain an intentional swallow
// on the catch line or directly above it. Reasons document intent, not proof
// that an arbitrary handler observes every failure.
import type { ESTree } from "@oxlint/plugins";
import { eslintCompatPlugin } from "@oxlint/plugins";
import { panic } from "better-result";

import { sha256Hex } from "@stll/sha256/node";

import ledger from "../scripts/swallowed-item-error-ledger.json" with { type: "json" };
import {
  filenameForContext,
  isAstNode,
  isIdentifier,
  memberPropertyName,
  unwrapExpression,
} from "./utils.ts";

const RULE_NAME = "no-swallowed-item-error";
const MIN_REASON_LENGTH = 12;
const SWALLOW_OK_PREFIX = "swallow-ok:";
const PLACEHOLDER_OPENERS = new Set(["todo", "fixme", "tbd"]);
const PLACEHOLDER_PHRASES = new Set([
  "placeholder",
  "placeholder reason",
  "reason here",
  "reason goes here",
  "explain why",
  "explain here",
  "best effort",
  "best-effort",
  "best effort cleanup",
  "best-effort cleanup",
  "ignore",
  "ignore errors",
  "ignore failures",
  "test",
  "test only",
  "cleanup",
]);
const TRAILING_FILLER = new Set([".", "!", " "]);

/** A reason that names no cause: an opener such as "todo", or a stock phrase. */
const isPlaceholderReason = (reason: string): boolean => {
  const words = reason
    .toLowerCase()
    .split(/\s/u)
    .filter((word) => word !== "");
  const opener = /^[a-z]+/u.exec(words[0] ?? "")?.[0];
  if (opener !== undefined && PLACEHOLDER_OPENERS.has(opener)) {
    return true;
  }
  let phrase = words.join(" ");
  while (TRAILING_FILLER.has(phrase.at(-1) ?? "")) {
    phrase = phrase.slice(0, -1);
  }
  return PLACEHOLDER_PHRASES.has(phrase);
};
const ITERATION_METHODS = new Set([
  "map",
  "flatMap",
  "forEach",
  "each",
  "filter",
  "reduce",
  "some",
  "every",
  "find",
]);
const FUNCTION_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);
const LOOP_TYPES = new Set([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);
const ledgerByFile = new Map<string, Set<string>>();
for (const [index, entry] of ledger.entries()) {
  const previous = index === 0 ? undefined : ledger.at(index - 1);
  if (
    !entry.reason.trim() ||
    (previous !== undefined && previous.id >= entry.id)
  ) {
    panic(
      "swallowed-item-error ledger must be reasoned, sorted and duplicate-free",
    );
  }
  const [file, fingerprint] = entry.id.split("::");
  if (!file || !fingerprint || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    panic("invalid swallowed-item-error ledger entry");
  }
  const budget = ledgerByFile.get(file) ?? new Set<string>();
  budget.add(fingerprint);
  ledgerByFile.set(file, budget);
}

const insideItemLoop = (node: unknown): boolean => {
  if (!isAstNode(node)) {
    return false;
  }
  let parent = node.parent;
  while (isAstNode(parent)) {
    if (LOOP_TYPES.has(parent.type)) {
      return true;
    }
    if (FUNCTION_TYPES.has(parent.type)) {
      const call = parent.parent;
      if (!isAstNode(call) || call.type !== "CallExpression") {
        return false;
      }
      const callee = unwrapExpression(call.callee);
      return (
        isAstNode(callee) &&
        callee.type === "MemberExpression" &&
        ITERATION_METHODS.has(memberPropertyName(callee) ?? "")
      );
    }
    parent = parent.parent;
  }
  return false;
};

const constantFallback = (node: unknown): boolean => {
  const value = unwrapExpression(node);
  if (isIdentifier(value, "undefined")) {
    return true;
  }
  if (!isAstNode(value)) {
    return false;
  }
  switch (value.type) {
    case "Literal":
      return true;
    case "TemplateLiteral":
      return Array.isArray(value.expressions) && value.expressions.length === 0;
    case "UnaryExpression":
      return constantFallback(value.argument);
    case "ArrayExpression":
      return (
        Array.isArray(value.elements) &&
        value.elements.every(
          (element) => element === null || constantFallback(element),
        )
      );
    case "ObjectExpression":
      return (
        Array.isArray(value.properties) &&
        value.properties.every(
          (property) =>
            isAstNode(property) &&
            property.type === "Property" &&
            property.kind === "init" &&
            (property.computed === false || constantFallback(property.key)) &&
            constantFallback(property.value),
        )
      );
    default:
      return false;
  }
};

const swallowedBody = (node: unknown): boolean => {
  const body = unwrapExpression(node);
  if (!isAstNode(body)) {
    return false;
  }
  if (body.type !== "BlockStatement") {
    return constantFallback(body);
  }
  if (!Array.isArray(body.body)) {
    return false;
  }
  return body.body.every(
    (statement) =>
      isAstNode(statement) &&
      (statement.type === "EmptyStatement" ||
        statement.type === "ContinueStatement" ||
        statement.type === "BreakStatement" ||
        (statement.type === "ReturnStatement" &&
          (statement.argument === null ||
            constantFallback(statement.argument)))),
  );
};

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    "no-test-swallowed-error": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          swallowed:
            "Assert the promise outcome or place // swallow-ok: <specific reason> (at least 12 characters) on the catch line or directly above it.",
        },
      },
      createOnce(context) {
        let reasonLines = new Set<number>();
        let precedingReasonLines = new Set<number>();
        const report = (node: ESTree.CatchClause | ESTree.CallExpression) => {
          const callee =
            node.type === "CallExpression"
              ? unwrapExpression(node.callee)
              : null;
          const anchor =
            isAstNode(callee) &&
            callee.type === "MemberExpression" &&
            isAstNode(callee.property)
              ? callee.property
              : node;
          const line = context.sourceCode.getLocFromIndex(anchor.range[0]).line;
          if (reasonLines.has(line) || precedingReasonLines.has(line - 1)) {
            return;
          }
          context.report({ node: anchor, messageId: "swallowed" });
        };
        return {
          before() {
            reasonLines = new Set();
            precedingReasonLines = new Set();
          },
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type !== "Line") {
                continue;
              }
              const text = comment.value.trimStart();
              const reason = text.startsWith(SWALLOW_OK_PREFIX)
                ? text.slice(SWALLOW_OK_PREFIX.length).trim()
                : undefined;
              if (
                reason !== undefined &&
                reason.length >= MIN_REASON_LENGTH &&
                !isPlaceholderReason(reason) &&
                /\p{L}/u.test(reason) &&
                new Set(reason).size > 1
              ) {
                const { line, column } = context.sourceCode.getLocFromIndex(
                  comment.range[0],
                );
                reasonLines.add(line);
                const prefix = context.sourceCode.text.slice(
                  comment.range[0] - column,
                  comment.range[0],
                );
                if (prefix.trim() === "") {
                  precedingReasonLines.add(line);
                }
              }
            }
          },
          CatchClause(node) {
            if (node.body.body.length === 0) {
              report(node);
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            const callback = unwrapExpression(node.arguments.at(0));
            if (
              isAstNode(callee) &&
              callee.type === "MemberExpression" &&
              memberPropertyName(callee) === "catch" &&
              isAstNode(callback) &&
              FUNCTION_TYPES.has(callback.type) &&
              swallowedBody(callback.body)
            ) {
              report(node);
            }
          },
        };
      },
    },
    [RULE_NAME]: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          swallowed:
            "Item failures must propagate or produce a typed failure record surfaced by ingestion.",
          stale:
            "Remove {{entry}} from scripts/swallowed-item-error-ledger.json: the swallowed item error no longer exists.",
        },
      },
      createOnce(context) {
        let budget = new Set<string>();
        let seen = new Set<string>();
        let file = "";
        const record = (node: ESTree.CatchClause | ESTree.CallExpression) => {
          const owner = node.type === "CatchClause" ? node.parent : node;
          // Tokens preserve literal contents while ignoring formatting and comments.
          const tokens = context.sourceCode
            .getTokens(owner)
            .map((token) => token.value);
          const id = sha256Hex(JSON.stringify(tokens));
          const duplicate = seen.has(id);
          seen.add(id);
          if (!budget.has(id) || duplicate) {
            context.report({ node, messageId: "swallowed" });
          }
        };
        return {
          before() {
            budget = new Set();
            seen = new Set();
            file = "";
            const filename = filenameForContext(context);
            for (const [entryFile, entries] of ledgerByFile) {
              if (
                filename === entryFile ||
                filename.endsWith(`/${entryFile}`)
              ) {
                file = entryFile;
                budget = entries;
                break;
              }
            }
          },
          CatchClause(node) {
            if (insideItemLoop(node) && swallowedBody(node.body)) {
              record(node);
            }
          },
          CallExpression(node) {
            const callee = unwrapExpression(node.callee);
            const callback = unwrapExpression(node.arguments.at(0));
            if (
              isAstNode(callee) &&
              callee.type === "MemberExpression" &&
              memberPropertyName(callee) === "catch" &&
              isAstNode(callback) &&
              FUNCTION_TYPES.has(callback.type) &&
              insideItemLoop(node) &&
              swallowedBody(callback.body)
            ) {
              record(node);
            }
          },
          "Program:exit"(node) {
            for (const entry of budget) {
              if (!seen.has(entry)) {
                context.report({
                  node,
                  messageId: "stale",
                  data: { entry: `${file}::${entry}` },
                });
              }
            }
          },
        };
      },
    },
  },
});
