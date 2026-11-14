import { eslintCompatPlugin } from "@oxlint/plugins";
// The database gives a chat turn its position (`chat_turns.ordinal`) and
// keeps the thread's counter (`chat_threads.last_turn_ordinal`), in the
// insert trigger `assign_chat_turn_ordinal`, under the thread's lock. The
// trigger keeps a position a row arrives with, so that rows copied with their
// numbers keep their order; application code that supplied one would decide a
// turn's place itself, outside that lock.
//
// So no product code writes either column: this rule reports `ordinal` in the
// object given to `.insert(chatTurns).values(...)` or
// `.update(chatTurns).set(...)`, and `lastTurnOrdinal` in the object given to
// `.insert(chatThreads).values(...)` or `.update(chatThreads).set(...)`.
// Tests are not checked: they insert rows as a restore does.

import { filenameForContext, isAstNode } from "./utils.ts";

const FIXTURE =
  ".oxlint-plugins/__fixtures__/no-chat-turn-ordinal-write.fixture.ts";

/** The column no code writes, by the table of the write. */
const ASSIGNED_COLUMN = new Map([
  ["chatTurns", "ordinal"],
  ["chatThreads", "lastTurnOrdinal"],
]);
/** The call that takes the row, by the call that names the table. */
const ROW_CALL = new Map([
  ["insert", "values"],
  ["update", "set"],
]);

const memberName = (callee: unknown): string | null =>
  isAstNode(callee) &&
  callee.type === "MemberExpression" &&
  callee.computed !== true &&
  isAstNode(callee.property) &&
  callee.property.type === "Identifier" &&
  typeof callee.property.name === "string"
    ? callee.property.name
    : null;

/** The column a `.values(...)` or `.set(...)` call must not carry, if any. */
const assignedColumnOf = (callee: unknown): string | null => {
  const rowCall = memberName(callee);
  if (rowCall === null || !isAstNode(callee)) {
    return null;
  }
  const tableCall: unknown = callee.object;
  if (!isAstNode(tableCall) || tableCall.type !== "CallExpression") {
    return null;
  }
  const write = memberName(tableCall.callee);
  if (write === null || ROW_CALL.get(write) !== rowCall) {
    return null;
  }
  const args: unknown = tableCall.arguments;
  const table: unknown = Array.isArray(args) ? args.at(0) : undefined;
  return isAstNode(table) &&
    table.type === "Identifier" &&
    typeof table.name === "string"
    ? (ASSIGNED_COLUMN.get(table.name) ?? null)
    : null;
};

const rowsOf = (argument: unknown): readonly unknown[] => {
  if (!isAstNode(argument)) {
    return [];
  }
  if (argument.type === "ArrayExpression" && Array.isArray(argument.elements)) {
    return argument.elements;
  }
  return [argument];
};

const propertiesOf = (row: unknown): readonly unknown[] =>
  isAstNode(row) &&
  row.type === "ObjectExpression" &&
  Array.isArray(row.properties)
    ? row.properties
    : [];

const namesColumn = (property: unknown, column: string): boolean => {
  if (
    !isAstNode(property) ||
    property.type !== "Property" ||
    property.computed === true ||
    !isAstNode(property.key)
  ) {
    return false;
  }
  const { key } = property;
  return (
    (key.type === "Identifier" && key.name === column) ||
    (key.type === "Literal" && key.value === column)
  );
};

export default eslintCompatPlugin({
  meta: { name: "no-chat-turn-ordinal-write" },
  rules: {
    "no-chat-turn-ordinal-write": {
      meta: {
        type: "problem",
        messages: {
          ordinalWrite:
            "The database assigns a chat turn's position and the thread's " +
            "counter (assign_chat_turn_ordinal). Leave `{{column}}` out of " +
            "this write.",
        },
      },
      createOnce(context) {
        return {
          before() {
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE)) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !filename.includes("/tests/") &&
              !/\.test\.tsx?$/u.test(filename)
            );
          },
          CallExpression(node) {
            const column = assignedColumnOf(node.callee);
            if (column === null) {
              return;
            }
            const args: readonly unknown[] = node.arguments;
            for (const row of rowsOf(args.at(0))) {
              for (const property of propertiesOf(row)) {
                if (isAstNode(property) && namesColumn(property, column)) {
                  context.report({
                    node: property,
                    messageId: "ordinalWrite",
                    data: { column },
                  });
                }
              }
            }
          },
        };
      },
    },
  },
});
