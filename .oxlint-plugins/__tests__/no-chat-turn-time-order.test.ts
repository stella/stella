// oxlint-disable no-template-curly-in-string -- these strings are the linted source, not templates.
import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lintAt = async (lines: readonly string[], sourcePath: string) =>
  await lintSingleRule("no-chat-turn-time-order", [...lines, ""].join("\n"), {
    sourcePath,
  });

const lint = async (lines: readonly string[]) =>
  await lintAt(lines, "apps/api/src/handlers/chat/message-page.ts");

const preamble = [
  'import { asc, desc, sql } from "drizzle-orm";',
  'import { chatMessages, chatTurns } from "@/api/db/schema";',
  "declare const query: { orderBy: (...columns: unknown[]) => unknown };",
  "declare const turnId: string;",
];
const lineAfterPreamble = (offset: number) => preamble.length + offset;

describe.serial("no-chat-turn-time-order", () => {
  test("reports a turn's start as a sort key", async () => {
    expect(
      await lint([
        ...preamble,
        "export const a = [",
        "  query.orderBy(desc(chatTurns.createdAt), desc(chatTurns.id)),",
        "  asc(chatTurns.createdAt),",
        "  query.orderBy(chatTurns.createdAt),",
        "];",
      ]),
    ).toEqual([2, 3, 4].map(lineAfterPreamble));
  });

  test("reports a turn's start compared or ordered in SQL", async () => {
    expect(
      await lint([
        ...preamble,
        "export const b = [",
        "  sql`(${chatTurns.createdAt}, ${chatTurns.id}) > (select t.created_at, t.id from chat_turns t where t.id = ${turnId})`,",
        "  sql`${chatTurns.createdAt} >= now()`,",
        "  sql`now() < ${chatTurns.createdAt}`,",
        "  sql`ORDER BY ${chatTurns.createdAt}`,",
        "  sql`${chatTurns.createdAt} DESC NULLS LAST`,",
        "];",
      ]),
    ).toEqual([2, 3, 4, 5, 6].map(lineAfterPreamble));
  });

  test("accepts the start read as a time and other tables' starts", async () => {
    expect(
      await lint([
        ...preamble,
        "export const c = [",
        "  sql`${chatTurns.createdAt} + interval '1 millisecond'`,",
        "  sql<Date>`coalesce(${chatTurns.activeStartedAt}, ${chatTurns.createdAt})`,",
        "  sql`${chatTurns.assistantMessageId} -> ${chatTurns.createdAt}`,",
        "  query.orderBy(desc(chatMessages.createdAt), desc(chatMessages.id)),",
        "  query.orderBy(desc(chatTurns.id)),",
        "];",
      ]),
    ).toEqual([]);
  });

  test("leaves the module that states the order alone", async () => {
    expect(
      await lintAt(
        [
          ...preamble,
          "export const NEWEST = [desc(chatTurns.createdAt), desc(chatTurns.id)];",
        ],
        "apps/api/src/lib/chat/turn-order.ts",
      ),
    ).toEqual([]);
  });
});
