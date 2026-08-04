import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createGeneratedDocumentActiveDraftContext,
  hasPersistedGeneratedDocumentActiveDraftContext,
} from "@/api/lib/chat/active-draft-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));
}, 120_000);

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
}, 120_000);

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

describe("persisted generated-document draft chat binding", () => {
  test("matches only the exact server-stamped origin tuple", async () => {
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const originChatMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const originChatThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    const generatedDraft = {
      originChatMessageId,
      originChatThreadId,
      toolCallId: "create-document-bound",
    };
    seededThreadIds.push(threadId);

    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      title: "Bound generated document draft",
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });
    await testDb.insert(chatMessages).values({
      content: chatMessageContentFromMessage(
        toPersistableChatMessage({
          id: messageId,
          metadata: {
            activeDraftContext:
              createGeneratedDocumentActiveDraftContext(generatedDraft),
          },
          parts: [{ content: "Revise this draft", type: "text" }],
          role: "user",
        }),
      ),
      id: messageId,
      role: "user",
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    const exact = unwrap(
      await safeDb(
        async (tx) =>
          await hasPersistedGeneratedDocumentActiveDraftContext({
            generatedDraft,
            organizationId: ids.orgA,
            threadId,
            tx,
            userId: ids.userA1,
          }),
      ),
    );
    const differentToolCall = unwrap(
      await safeDb(
        async (tx) =>
          await hasPersistedGeneratedDocumentActiveDraftContext({
            generatedDraft: {
              ...generatedDraft,
              toolCallId: "create-document-other",
            },
            organizationId: ids.orgA,
            threadId,
            tx,
            userId: ids.userA1,
          }),
      ),
    );

    expect(exact).toBe(true);
    expect(differentToolCall).toBe(false);
  });
});
