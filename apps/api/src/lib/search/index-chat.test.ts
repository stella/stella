import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";

const rootDbExecuteMock = mock(async (_query: SQL) => []);
const rootDbChatThreadFindFirstMock = mock(async () => ({
  id: toSafeId<"chatThread">("thread_1"),
  title: "Contract review",
  updatedAt: new Date("2026-06-06T08:00:00.000Z"),
  messages: [
    {
      content: {
        version: 1 as const,
        data: [
          { type: "text" as const, text: "Review the termination clause." },
        ],
      },
    },
  ],
}));

// eslint-disable-next-line typescript-eslint/no-floating-promises -- Bun mock.module is sync for registration
mock.module("@/api/db/root", () => ({
  rootDb: {
    execute: rootDbExecuteMock,
    query: {
      chatThreads: {
        findFirst: rootDbChatThreadFindFirstMock,
      },
    },
  },
}));

beforeEach(() => {
  rootDbExecuteMock.mockClear();
  rootDbChatThreadFindFirstMock.mockClear();
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
