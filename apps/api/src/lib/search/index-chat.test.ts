import { beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import {
  clearRootDbMocks,
  rootDbChatThreadFindFirstMock,
  rootDbExecuteMock,
  rootDbTestDouble,
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
    const compiled = new PgDialect().sqlToQuery(query).sql;
    const isPageRead = compiled.includes("FROM chat_messages");
    if (isPageRead) {
      pageReads += 1;
      return await Promise.resolve(pageReads === 1 ? [...messages] : []);
    }
    if (compiled.includes("INSERT INTO chat_thread_search_documents")) {
      return await Promise.resolve([
        { threadId: toSafeId<"chatThread">("thread_1") },
      ]);
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
  test("normalizes legacy text and source-document parts for search", async () => {
    const { extractMessageSearchText } = await import("./index-chat");

    expect(
      extractMessageSearchText({
        version: 1,
        data: [
          { type: "text", text: "Review the termination clause." },
          {
            type: "data-stella-source-document",
            data: {
              kind: "document",
              mention: "@agreement",
              title: "Agreement.pdf",
            },
          },
        ],
      }),
    ).toBe("Review the termination clause. Agreement.pdf @agreement document");
  });

  test("indexes citation labels without their link targets", async () => {
    const { extractMessageSearchText } = await import("./index-chat");
    const workspaceId = "db9b500f-aa40-4bee-bd7e-624ef4be6193";
    const entityId = "6d0f4b21-5c7e-4a0e-9f31-1b3a7c2d8e55";

    const indexed = extractMessageSearchText({
      version: 2,
      data: [
        {
          type: "text",
          content: [
            `The matter **[FlightOps Cloud - IT & SaaS](#stella-workspace=${workspaceId})**`,
            `holds [the retainer](#stella-entity=${workspaceId}:${entityId})`,
            "and its [public filing](https://example.com/filing 'Filing').",
          ].join(" "),
        },
      ],
    });

    expect(indexed).toBe(
      "The matter **FlightOps Cloud - IT & SaaS** holds the retainer and its public filing.",
    );
    expect(indexed).not.toContain(workspaceId);
    expect(indexed).not.toContain("#stella-");
    expect(indexed).not.toContain("https://");
  });

  test("indexes only source-document metadata that previews can display", async () => {
    const { extractMessageSearchText } = await import("./index-chat");

    expect(
      extractMessageSearchText({
        version: 2,
        data: [],
        metadata: {
          sourceDocuments: [
            {
              entityId: "entity_1",
              entityRef: "internal-entity-reference",
              kind: "document",
              matterRef: "internal-matter-reference",
              mention: "@closing-memo",
              mimeType: "application/pdf",
              title: "Closing memorandum",
              workspaceId: "workspace_1",
            },
          ],
        },
      }),
    ).toBe("Closing memorandum @closing-memo document");
  });

  test("filters malformed version 2 source-document metadata", async () => {
    const { normalizeSearchableChatMessageContent } =
      await import("./index-chat");
    const validSource = {
      entityId: "entity-1",
      kind: "document",
      mimeType: "application/pdf",
      title: "Agreement.pdf",
      workspaceId: "workspace-1",
    };

    expect(
      normalizeSearchableChatMessageContent({
        version: 2,
        data: [],
        metadata: { sourceDocuments: [null, validSource] },
      }),
    ).toMatchObject({
      metadata: { sourceDocuments: [validSource] },
    });
  });

  test("indexes version 3 text and metadata", async () => {
    const { normalizeSearchableChatMessageContent } =
      await import("./index-chat");

    expect(
      normalizeSearchableChatMessageContent({
        version: 3,
        data: [{ type: "text", content: "Canonical text" }],
        metadata: {
          sourceDocuments: [{ kind: "document", title: "Agreement.pdf" }],
        },
      }),
    ).toEqual({
      metadata: {
        sourceDocuments: [{ kind: "document", title: "Agreement.pdf" }],
      },
      parts: [{ type: "text", content: "Canonical text" }],
    });
  });

  test("does not let stale upserts overwrite a newer search document", async () => {
    const { upsertChatThreadSearchDocument } = await import("./index-chat");

    await upsertChatThreadSearchDocument(
      toSafeId<"chatThread">("thread_1"),
      rootDbTestDouble,
    );

    const sqlText = findExecutedQuery(
      "INSERT INTO chat_thread_search_documents",
    );
    expect(sqlText).toContain(
      "WHERE EXCLUDED.updated_at >= chat_thread_search_documents.updated_at",
    );
    expect(sqlText).toContain("preview_generation = NULL");
    expect(
      findExecutedQuery("INSERT INTO chat_thread_search_preview_passages"),
    ).toBeUndefined();
    const generationSql = findExecutedQuery("SET preview_generation =");
    expect(generationSql).toContain("WHERE thread_id =");
    expect(generationSql).toContain("AND updated_at =");
  });

  test("does not let stale upserts overwrite newer message search documents", async () => {
    const { upsertChatThreadSearchDocument } = await import("./index-chat");

    await upsertChatThreadSearchDocument(
      toSafeId<"chatThread">("thread_1"),
      rootDbTestDouble,
    );

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

    await upsertChatThreadSearchDocument(
      toSafeId<"chatThread">("thread_1"),
      rootDbTestDouble,
    );

    expect(
      findExecutedQuery("INSERT INTO chat_message_search_documents"),
    ).toBeDefined();
    expect(
      findExecutedQuery("INSERT INTO chat_thread_search_documents"),
    ).toBeDefined();
  });

  test("backfills threads missing per-message search documents", async () => {
    const { backfillChatThreadSearchIndex } = await import("./index-chat");

    await backfillChatThreadSearchIndex({ database: rootDbTestDouble });

    const query = rootDbExecuteMock.mock.calls.at(0)?.[0];
    expect(query).toBeDefined();
    if (query === undefined) {
      return;
    }

    const compiled = new PgDialect().sqlToQuery(query);
    expect(compiled.sql).toContain("LEFT JOIN chat_thread_search_documents");
    expect(compiled.sql).toContain("LEFT JOIN chat_message_search_documents");
    expect(compiled.sql).toContain("md.message_id IS NULL");
    expect(compiled.sql).toContain("d.preview_generation IS DISTINCT FROM");
    expect(compiled.sql).not.toContain("chat_thread_search_preview_passages");
  });
});
