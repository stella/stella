import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lintAt = async (lines: readonly string[], sourcePath: string) =>
  await lintSingleRule(
    "no-chat-turn-ordinal-write",
    [...lines, ""].join("\n"),
    { sourcePath },
  );

const lint = async (lines: readonly string[]) =>
  await lintAt(lines, "apps/api/src/handlers/chat/chat-turn-persistence.ts");

const preamble = [
  'import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";',
  "type Write = { values: (row: unknown) => unknown; set: (row: unknown) => unknown };",
  "declare const tx: { insert: (table: unknown) => Write; update: (table: unknown) => Write };",
  "declare const turn: { id: string };",
];
const lineAfterPreamble = (offset: number) => preamble.length + offset;

describe.serial("no-chat-turn-ordinal-write", () => {
  test("reports a supplied turn position and thread counter", async () => {
    expect(
      await lint([
        ...preamble,
        "export const a = [",
        "  tx.insert(chatTurns).values({ ...turn, ordinal: 3 }),",
        "  tx.insert(chatTurns).values([turn, { ...turn, ordinal: 4 }]),",
        "  tx.update(chatTurns).set({ ordinal: 5 }),",
        '  tx.update(chatTurns).set({ "ordinal": 5 }),',
        "  tx.insert(chatThreads).values({ lastTurnOrdinal: 0 }),",
        "  tx.update(chatThreads).set({ lastTurnOrdinal: 5 }),",
        "];",
      ]),
    ).toEqual([2, 3, 4, 5, 6, 7].map(lineAfterPreamble));
  });

  test("accepts writes that leave both columns out, and other tables", async () => {
    expect(
      await lint([
        ...preamble,
        "export const b = [",
        "  tx.insert(chatTurns).values({ ...turn }),",
        '  tx.update(chatThreads).set({ title: "Renamed" }),',
        "  tx.insert(chatMessages).values({ ordinal: 1 }),",
        "  tx.update(chatTurns).set({ lastTurnOrdinal: 1 }),",
        "];",
      ]),
    ).toEqual([]);
  });

  test("does not check tests, which insert rows as a restore does", async () => {
    const lines = [
      ...preamble,
      "export const c = tx.insert(chatTurns).values({ ...turn, ordinal: 3 });",
    ];
    expect(
      await lintAt(lines, "apps/api/src/db/chat-turn-ordinal.db.test.ts"),
    ).toEqual([]);
    expect(
      await lintAt(lines, "apps/api/src/tests/helpers/chat-fixtures.ts"),
    ).toEqual([]);
  });
});
