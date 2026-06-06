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
});
