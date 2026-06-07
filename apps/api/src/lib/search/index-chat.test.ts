import { beforeEach, describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import {
  clearRootDbMocks,
  rootDbChatThreadFindFirstMock,
  rootDbExecuteMock,
} from "@/api/tests/helpers/mock-root-db";

beforeEach(() => {
  clearRootDbMocks();
  rootDbChatThreadFindFirstMock.mockImplementation(
    async () =>
      await Promise.resolve({
        id: toSafeId<"chatThread">("thread_1"),
        title: "Contract review",
        updatedAt: new Date("2026-06-06T08:00:00.000Z"),
        messages: [
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
        ],
      }),
  );
});

describe("chat search indexing", () => {
  test("does not let stale upserts overwrite a newer search document", async () => {
    const { upsertChatThreadSearchDocument } = await import("./index-chat");

    await upsertChatThreadSearchDocument(toSafeId<"chatThread">("thread_1"));

    const query = rootDbExecuteMock.mock.calls.at(0)?.[0];
    expect(query).toBeDefined();
    if (query === undefined) {
      return;
    }

    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain(
      "WHERE EXCLUDED.updated_at >= chat_thread_search_documents.updated_at",
    );
  });

  test("does not let stale upserts overwrite newer message search documents", async () => {
    const { upsertChatThreadSearchDocument } = await import("./index-chat");

    await upsertChatThreadSearchDocument(toSafeId<"chatThread">("thread_1"));

    const query = rootDbExecuteMock.mock.calls.at(1)?.[0];
    expect(query).toBeDefined();
    if (query === undefined) {
      return;
    }

    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("INSERT INTO chat_message_search_documents");
    expect(compiled.sql).toContain(
      "WHERE EXCLUDED.updated_at >= chat_message_search_documents.updated_at",
    );
  });
});
