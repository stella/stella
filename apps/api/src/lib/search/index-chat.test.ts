import { beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import {
  clearRootDbMocks,
  rootDbChatThreadFindFirstMock,
  rootDbExecuteMock,
} from "@/api/tests/helpers/mock-root-db";

/** Drive the keyset page read: the first `execute` (the message-page
 *  SELECT) returns one page of messages, every later page returns
 *  empty so pagination terminates. Thread- and message-document
 *  upserts (also `execute`) fall through to the default empty result. */
const mockMessagePage = (
  messages: readonly Record<string, unknown>[],
): void => {
  let pageReads = 0;
  rootDbExecuteMock.mockImplementation(async (query: SQL) => {
    const isPageRead = new PgDialect()
      .sqlToQuery(query)
      .sql.includes("FROM chat_messages");
    if (isPageRead) {
      pageReads += 1;
      return await Promise.resolve(pageReads === 1 ? [...messages] : []);
    }
    return await Promise.resolve([]);
  });
};

beforeEach(() => {
  clearRootDbMocks();
  rootDbChatThreadFindFirstMock.mockImplementation(
    async () =>
      await Promise.resolve({
        id: toSafeId<"chatThread">("thread_1"),
        title: "Contract review",
        updatedAt: new Date("2026-06-06T08:00:00.000Z"),
      }),
  );
  mockMessagePage([
    {
      id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
      role: "user",
      createdAt: new Date("2026-06-06T07:55:00.000Z"),
      content: {
        version: 1 as const,
        data: [
          {
            type: "text" as const,
            text: "Review the termination clause.",
          },
        ],
      },
    },
  ]);
});

/** Find the first executed query whose compiled SQL contains `needle`.
 *  Lets assertions target a query by content rather than a brittle
 *  call index, so the keyset page read interleaved with the upserts
 *  does not shift fixed positions. */
const findExecutedQuery = (needle: string): string | undefined => {
  const dialect = new PgDialect();
  for (const [query] of rootDbExecuteMock.mock.calls) {
    const compiled = dialect.sqlToQuery(query).sql;
    if (compiled.includes(needle)) {
      return compiled;
    }
  }
  return undefined;
};

describe("chat search indexing", () => {
  test("does not let stale upserts overwrite a newer search document", async () => {
    const { upsertChatThreadSearchDocument } = await import("./index-chat");

    await upsertChatThreadSearchDocument(toSafeId<"chatThread">("thread_1"));

    const sqlText = findExecutedQuery(
      "INSERT INTO chat_thread_search_documents",
    );
    expect(sqlText).toContain(
      "WHERE EXCLUDED.updated_at >= chat_thread_search_documents.updated_at",
    );
  });

  test("does not let stale upserts overwrite newer message search documents", async () => {
    const { upsertChatThreadSearchDocument } = await import("./index-chat");

    await upsertChatThreadSearchDocument(toSafeId<"chatThread">("thread_1"));

    const sqlText = findExecutedQuery(
      "INSERT INTO chat_message_search_documents",
    );
    expect(sqlText).toContain("INSERT INTO chat_message_search_documents");
    expect(sqlText).toContain(
      "WHERE EXCLUDED.updated_at >= chat_message_search_documents.updated_at",
    );
  });

  test("indexes malformed source-document parts without throwing", async () => {
    rootDbChatThreadFindFirstMock.mockImplementation(
      async () =>
        await Promise.resolve({
          id: toSafeId<"chatThread">("thread_1"),
          title: "Contract review",
          updatedAt: new Date("2026-06-06T08:00:00.000Z"),
        }),
    );
    mockMessagePage([
      {
        id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
        role: "assistant",
        createdAt: new Date("2026-06-06T07:55:00.000Z"),
        content: {
          version: 1 as const,
          data: [{ type: "data-stella-source-document" }],
        },
      },
    ]);
    const { upsertChatThreadSearchDocument } = await import("./index-chat");

    await upsertChatThreadSearchDocument(toSafeId<"chatThread">("thread_1"));

    expect(
      findExecutedQuery("INSERT INTO chat_message_search_documents"),
    ).toBeDefined();
    expect(
      findExecutedQuery("INSERT INTO chat_thread_search_documents"),
    ).toBeDefined();
  });

  test("backfills threads missing per-message search documents", async () => {
    const { backfillChatThreadSearchIndex } = await import("./index-chat");

    await backfillChatThreadSearchIndex();

    const query = rootDbExecuteMock.mock.calls.at(0)?.[0];
    expect(query).toBeDefined();
    if (query === undefined) {
      return;
    }

    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("LEFT JOIN chat_thread_search_documents");
    expect(compiled.sql).toContain("LEFT JOIN chat_message_search_documents");
    expect(compiled.sql).toContain("md.message_id IS NULL");
  });
});
