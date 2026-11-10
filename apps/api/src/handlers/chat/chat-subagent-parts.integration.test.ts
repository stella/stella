import { EventType } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { chatMessages, chatThreads } from "@/api/db/schema";
import {
  chatMessageFromPersisted,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { clientVisibleStreamChunk } from "@/api/handlers/chat/client-visible-chat-part";
import { clientMessageFromPageRow } from "@/api/handlers/chat/message-page";
import type {
  ChatPart,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { diffLiveAgainstReload } from "@/api/tests/helpers/chat-live-reload-invariants";
import {
  browsingChild,
  childPageId,
  rawPageIds,
  SUBAGENT_PARENT_CALL_ID,
} from "@/api/tests/helpers/subagent-part-fixtures";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A message holding tool-mode sub-agent parts, written to and read from the
// chat message table (PGlite, the real column codec), as the thread page
// serves it: what a stream snapshot showed is what the page reloads, and the
// stored row holds no page a finished child read.

let testDb: TestDatabase;
let ids: TestIds;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    // Cascade removes the seeded messages.
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const seedThread = async (): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Sub-agent parts",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  seededThreadIds.push(threadId);
  return threadId;
};

const readRow = async (id: SafeId<"chatMessage">) =>
  (
    await testDb
      .select({
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
        id: chatMessages.id,
        revision: chatMessages.revision,
        role: chatMessages.role,
        stored: sql<string>`${chatMessages.content}::text`,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, id))
  ).at(0) ?? panic("The message was not stored");

const parseJson = (text: string): unknown => {
  const parsed: unknown = JSON.parse(text);
  return parsed;
};

/**
 * `value` with each tool result's text read as the JSON it holds. A result
 * paired with its call's output is rebuilt from the stored output, and
 * Postgres `jsonb` does not keep object key order, so the text may order
 * keys differently while holding the same value.
 */
const withParsedResults = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withParsedResults);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = asTestRaw<Record<string, unknown>>(value);
  const entries = Object.entries(record).map(([key, inner]) => [
    key,
    key === "content" &&
    record["type"] === "tool-result" &&
    typeof inner === "string"
      ? parseJson(inner)
      : withParsedResults(inner),
  ]);
  return Object.fromEntries(entries);
};

describe("sub-agent parts in the chat message table", () => {
  test("the page reloads what a stream snapshot showed", async () => {
    const threadId = await seedThread();
    const id = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const parts: ChatPart[] = [
      { content: "Hledám.", type: "text" },
      browsingChild("finished", 3),
      browsingChild("suspended", 3),
    ];
    await testDb.insert(chatMessages).values({
      content: toPersistedChatMessageContentV3({ data: parts }),
      id,
      role: "assistant",
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    const row = await readRow(id);
    // A finished child stores none of its pages; a suspended one only the
    // newest, which its resume reads.
    for (const page of [0, 1, 2]) {
      expect(row.stored).not.toContain(
        `Stránka ${childPageId("finished", page)}`,
      );
    }
    for (const page of [0, 1]) {
      expect(row.stored).not.toContain(
        `Stránka ${childPageId("suspended", page)}`,
      );
    }
    expect(row.stored).toContain(`Stránka ${childPageId("suspended", 2)}`);

    const reloaded = clientMessageFromPageRow(row, new Map());
    expect(rawPageIds(reloaded.parts.at(1))).toEqual([]);
    expect(rawPageIds(reloaded.parts.at(2))).toEqual([
      childPageId("suspended", 2),
      childPageId("suspended", 2),
    ]);

    // Served page parts ride on the AG-UI assistant message.
    const answer = { content: "", id, parts, role: "assistant" as const };
    const snapshot = clientVisibleStreamChunk({
      messages: [answer],
      type: EventType.MESSAGES_SNAPSHOT,
    });
    if (snapshot.type !== EventType.MESSAGES_SNAPSHOT) {
      return panic("Expected a messages snapshot");
    }
    const live = asTestRaw<UIMessage>(snapshot.messages.at(0));
    expect(withParsedResults(reloaded.parts)).toEqual(
      withParsedResults(live.parts),
    );
    expect(
      diffLiveAgainstReload({
        live: [live],
        reload: [asTestRaw<UIMessage>(reloaded)],
      }),
    ).toEqual([]);
  });

  test("a child part a newer release stored survives a save by this one", async () => {
    const threadId = await seedThread();
    const id = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const newer = { later: "newer-release-secret", type: "later-part" };
    const storedPart = {
      subagent: {
        id: "child-1",
        messages: [
          {
            content: {
              data: [{ content: "Hotovo.", type: "text" }, newer],
              version: 3,
            },
            id: "child-answer",
            role: "assistant",
          },
        ],
        name: "browse",
        parentToolCallId: SUBAGENT_PARENT_CALL_ID,
        status: "finished",
      },
      type: "subagent",
    };
    const stored = { data: [storedPart], version: 3 };
    // Written as a newer release wrote it.
    await testDb.insert(chatMessages).values({
      content: asTestRaw<PersistedChatMessageContentV3>(stored),
      id,
      role: "assistant",
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    const row = await readRow(id);
    expect(
      JSON.stringify(clientMessageFromPageRow(row, new Map())),
    ).not.toContain(newer.later);

    // This release saves the message again, its sub-agent part edited: the
    // child part it cannot read is written back exactly as stored.
    const part = chatMessageFromPersisted({
      content: row.content,
      id,
      role: "assistant",
    }).parts.at(0);
    if (part?.type !== "subagent") {
      return panic("Expected the subagent part to be read");
    }
    await testDb
      .update(chatMessages)
      .set({
        content: toPersistedChatMessageContentV3({
          data: [
            {
              ...part,
              subagent: { ...part.subagent, description: "Edited." },
            },
          ],
        }),
      })
      .where(eq(chatMessages.id, id));

    expect(JSON.parse((await readRow(id)).stored)).toEqual({
      ...stored,
      data: [
        {
          ...storedPart,
          subagent: { ...storedPart.subagent, description: "Edited." },
        },
      ],
    });
  });
});
