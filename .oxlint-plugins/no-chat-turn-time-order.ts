import { eslintCompatPlugin } from "@oxlint/plugins";
// A thread's turns are ordered by `chat_turns.ordinal`, the position the
// database gives a turn under the thread's lock. A turn's start time
// (`chat_turns.created_at`) is its transaction's start, so a transaction that
// started first and took the lock second stores the later turn with the
// earlier time, and a start read out at millisecond precision compares wrong
// against the stored one. "Newest turn" computed from starts was wrong both
// ways.
//
// `apps/api/src/lib/chat/turn-order.ts` states the order once. Everywhere
// else this rule reports `chatTurns.createdAt`:
//
// - as an argument of `asc(...)` or `desc(...)`, or of `.orderBy(...)`;
// - in a `sql` template where it is compared (`<`, `<=`, `>`, `>=`), opens a
//   row value (`(${chatTurns.createdAt}, ...)`), follows `ORDER BY`, or is
//   followed by `ASC` or `DESC`.
//
// Reading the start as a time (showing it, adding an interval to it) is not
// ordering and is not reported.

import { filenameForContext, isAstNode } from "./utils.ts";

const OWNER = "apps/api/src/lib/chat/turn-order.ts";
const FIXTURE =
  ".oxlint-plugins/__fixtures__/no-chat-turn-time-order.fixture.ts";

const isTurnStart = (node: unknown): boolean =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed !== true &&
  isAstNode(node.object) &&
  node.object.type === "Identifier" &&
  node.object.name === "chatTurns" &&
  isAstNode(node.property) &&
  node.property.type === "Identifier" &&
  node.property.name === "createdAt";

const rawOf = (quasi: unknown): string => {
  if (!isAstNode(quasi) || quasi.type !== "TemplateElement") {
    return "";
  }
  const value = quasi.value;
  return typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof value.raw === "string"
    ? value.raw
    : "";
};

// `->` and `->>` are JSON operators, not comparisons.
const COMPARED_BEFORE = /(?<!-)(?:<=?|>=?)\s*$/u;
const COMPARED_AFTER = /^\s*(?:<=?|>=?)(?!>)/u;
// A row value's parenthesis follows no name; a function call's does.
const OPENS_ROW_BEFORE = /(?:^|[^\w])\(\s*$/u;
const OPENS_ROW_AFTER = /^\s*,/u;
const ORDERED_BEFORE = /\bORDER\s+BY\s*$/iu;
const ORDERED_AFTER = /^\s*(?:ASC|DESC)\b/iu;

const ordersInSql = (before: string, after: string): boolean =>
  COMPARED_BEFORE.test(before) ||
  COMPARED_AFTER.test(after) ||
  (OPENS_ROW_BEFORE.test(before) && OPENS_ROW_AFTER.test(after)) ||
  ORDERED_BEFORE.test(before) ||
  ORDERED_AFTER.test(after);

const isSqlTag = (tag: unknown): boolean =>
  isAstNode(tag) && tag.type === "Identifier" && tag.name === "sql";

const calleeName = (callee: unknown): string | null => {
  if (!isAstNode(callee)) {
    return null;
  }
  if (callee.type === "Identifier" && typeof callee.name === "string") {
    return callee.name;
  }
  if (
    callee.type === "MemberExpression" &&
    callee.computed !== true &&
    isAstNode(callee.property) &&
    callee.property.type === "Identifier" &&
    typeof callee.property.name === "string"
  ) {
    return callee.property.name;
  }
  return null;
};

const ORDERING_CALLS = new Set(["asc", "desc", "orderBy"]);

export default eslintCompatPlugin({
  meta: { name: "no-chat-turn-time-order" },
  rules: {
    "no-chat-turn-time-order": {
      meta: {
        type: "problem",
        messages: {
          timeOrder:
            "A chat turn's start time does not order turns. Order with " +
            "NEWEST_CHAT_TURN_FIRST or OLDEST_CHAT_TURN_FIRST from " +
            "apps/api/src/lib/chat/turn-order.ts, which read the turn's " +
            "ordinal.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            return (
              (filename.includes("apps/api/src/") ||
                filename.endsWith(FIXTURE)) &&
              !filename.endsWith(OWNER)
            );
          },
          CallExpression(node) {
            const name = calleeName(node.callee);
            if (name === null || !ORDERING_CALLS.has(name)) {
              return;
            }
            const args: readonly unknown[] = node.arguments;
            for (const argument of args) {
              if (isAstNode(argument) && isTurnStart(argument)) {
                context.report({ node: argument, messageId: "timeOrder" });
              }
            }
          },
          TaggedTemplateExpression(node) {
            if (!isSqlTag(node.tag)) {
              return;
            }
            const template: unknown = node.quasi;
            if (
              !isAstNode(template) ||
              !Array.isArray(template.expressions) ||
              !Array.isArray(template.quasis)
            ) {
              return;
            }
            const quasis: readonly unknown[] = template.quasis;
            const expressions: readonly unknown[] = template.expressions;
            for (const [index, expression] of expressions.entries()) {
              if (
                isAstNode(expression) &&
                isTurnStart(expression) &&
                ordersInSql(
                  rawOf(quasis.at(index)),
                  rawOf(quasis.at(index + 1)),
                )
              ) {
                context.report({ node: expression, messageId: "timeOrder" });
              }
            }
          },
        };
      },
    },
  },
});
