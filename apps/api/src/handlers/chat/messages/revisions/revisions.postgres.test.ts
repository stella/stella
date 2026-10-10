import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import { CHAT_MESSAGE_EDIT_TYPE } from "@stll/api-contract/chat-message-revisions";
import { sha256Hex } from "@stll/sha256/bun";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  auditLogs,
  chatMessages,
  chatMessageRevisions,
  chatThreadCompactions,
  chatThreads,
  chatTurns,
  workspaces,
  workspaceMembers,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import {
  normalizePersistedChatMessageContent,
  toChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { readChatRevisionContextChanges } from "@/api/handlers/chat/chat-revision-context";
import { cacheThreadRecapOnTx } from "@/api/handlers/chat/get-thread-recap";
import { loadWindowedThreadMessages } from "@/api/handlers/chat/history-window";
import { readChatMessageRevisionsOnTx } from "@/api/handlers/chat/messages/revisions/list";
import { writeChatMessageRevisionOnTx } from "@/api/handlers/chat/messages/revisions/revision-on-tx";
import type { ChatMessageRevisionChange } from "@/api/handlers/chat/messages/revisions/revision-on-tx";
import type { ChatMessageMetadata } from "@/api/handlers/chat/types";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { chatMessageCursorCodec } from "@/api/lib/chat/message-cursor";
import { decodePaginationCursor } from "@/api/lib/pagination";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { EMPTY_SUMMARY } from "@/api/tests/helpers/chat-compaction-checkpoint";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const emptyRecap = {
  recapText: null,
  recapMessageId: null,
  recapPromptVersion: null,
  recapGeneratedAt: null,
} as const;

const original = toPersistedChatMessageContentV3({
  data: [{ type: "text", content: "Original answer: café\n\nNext paragraph." }],
});
const edited = toPersistedChatMessageContentV3({
  data: [
    { type: "text", content: "**Original** answer: café\n\nNext paragraph." },
  ],
});
const acceptedChange = {
  type: "accept",
  baseRevision: 0,
  selectedTextHash: sha256Hex("Original"),
  content: edited,
  edit: {
    type: CHAT_MESSAGE_EDIT_TYPE.format,
    format: "bold",
    start: 0,
    end: 8,
  },
} as const satisfies ChatMessageRevisionChange;

const seedFixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const threadId = createSafeId<"chatThread">();
  const messageId = createSafeId<"chatMessage">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Revision fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await db.insert(user).values({
    id: userId,
    name: "Revision fixture member",
    email: `${userId}@example.test`,
  });
  await db.insert(member).values([
    {
      id: mintAuthProviderIdValue(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    },
  ]);
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Revision fixture matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  await db.insert(chatThreads).values({
    id: threadId,
    organizationId,
    userId,
    workspaceId,
    title: "Revision fixture",
  });
  await db.insert(chatMessages).values({
    id: messageId,
    threadId,
    userId,
    workspaceId,
    role: "assistant",
    content: original,
  });
  const recordAuditEvent = createAuditRecorder({
    organizationId,
    userId,
    workspaceId,
    request: new Request("https://example.test/chat-revisions"),
    server: null,
  });
  const scoped = (database: GatedTestDb) =>
    createScopedDb(
      markRlsDatabase(database),
      [workspaceId],
      organizationId,
      userId,
    );
  const write = async (
    database: GatedTestDb,
    change: ChatMessageRevisionChange,
  ) =>
    await scoped(database)(
      async (tx) =>
        await writeChatMessageRevisionOnTx({
          tx,
          threadId,
          messageId,
          userId,
          organizationId,
          getWorkspaceAccess: async (id) => ({ id, status: "active" }),
          change,
          recordAuditEvent,
        }),
    );
  const contextChanges = async () =>
    await scoped(db)(
      async (tx) =>
        await readChatRevisionContextChanges({
          tx,
          threadId,
          messages: [{ id: messageId, role: "assistant" }],
        }),
    );
  const observe = async () => ({
    messages: await db
      .select({
        content: chatMessages.content,
        revision: chatMessages.revision,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId)),
    revisions: await db
      .select()
      .from(chatMessageRevisions)
      .where(eq(chatMessageRevisions.messageId, messageId))
      .orderBy(chatMessageRevisions.revision),
    threads: await db
      .select({
        epoch: chatThreads.compactionEpoch,
        recapText: chatThreads.recapText,
        recapMessageId: chatThreads.recapMessageId,
        recapPromptVersion: chatThreads.recapPromptVersion,
        recapGeneratedAt: chatThreads.recapGeneratedAt,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId)),
    audits: await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, messageId),
          eq(auditLogs.organizationId, organizationId),
        ),
      )
      .orderBy(auditLogs.createdAt),
  });
  const cleanUp = async () => {
    await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  };
  return {
    organizationId,
    userId,
    workspaceId,
    threadId,
    messageId,
    scoped,
    write,
    observe,
    cleanUp,
    recordAuditEvent,
    contextChanges,
  };
};

if (!databaseUrl || !runPostgres) {
  describe.skip("chat message revisions on the migrated schema (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () =>
      expect(true).toBe(true));
  });
} else {
  describe("chat message revisions on the migrated schema (postgres)", () => {
    test.each([1, 2] as const)(
      "accept preserves normalized v%i metadata in the snapshot and edited message",
      async (version) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const db = openClient().db;
          const fixture = await seedFixture(db);
          try {
            const metadata = {
              anonRestorations: {
                pairs: [
                  { placeholder: "[PERSON_1]", original: "Ada Lovelace" },
                ],
              },
              mentions: {
                mentions: [
                  {
                    category: "workspace",
                    id: fixture.workspaceId,
                    label: "Matter",
                    resource: resourceRef({
                      type: RESOURCE_TYPE.WORKSPACE,
                      id: fixture.workspaceId,
                    }),
                  },
                ],
              },
              sourceDocuments: [
                {
                  entityId: "source-memo",
                  kind: "document",
                  mimeType: "application/pdf",
                  title: "Source memo",
                  workspaceId: fixture.workspaceId,
                },
              ],
            } satisfies ChatMessageMetadata;
            const content =
              version === 1
                ? {
                    version: 1 as const,
                    data: [
                      {
                        type: "text",
                        text: "Original answer: café\n\nNext paragraph.",
                      },
                      {
                        type: "data-stella-anon-restorations",
                        data: metadata.anonRestorations,
                      },
                      { type: "data-stella-mentions", data: metadata.mentions },
                      {
                        type: "data-stella-source-document",
                        data: metadata.sourceDocuments.at(0),
                      },
                    ],
                  }
                : toChatMessageContent({
                    version,
                    data: normalizePersistedChatMessageContent(original).parts,
                    metadata,
                  });
            await db
              .update(chatMessages)
              .set({ content })
              .where(eq(chatMessages.id, fixture.messageId));
            expect(
              normalizePersistedChatMessageContent(content).metadata,
            ).toEqual(metadata);
            const candidate = toPersistedChatMessageContentV3({
              data: normalizePersistedChatMessageContent(edited).parts,
              metadata,
            });
            expect(
              await fixture.write(db, {
                ...acceptedChange,
                content: candidate,
              }),
            ).toEqual({
              type: "ok",
              revision: 1,
              edited: true,
            });
            const observed = await fixture.observe();
            expect(observed.messages).toEqual([
              { content: candidate, revision: 1 },
            ]);
            expect(observed.revisions.at(0)?.content).toEqual(content);
            const snapshot = observed.revisions.at(0);
            if (!snapshot) {
              panic("Expected original revision snapshot");
            }
            expect(
              normalizePersistedChatMessageContent(snapshot.content).metadata,
            ).toEqual(metadata);
          } finally {
            await fixture.cleanUp();
          }
        });
      },
    );

    test("accept snapshots replaced content, advances the epoch, and writes a content-free audit atomically", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          expect(await fixture.contextChanges()).toEqual(Result.ok([]));
          expect(await fixture.write(db, acceptedChange)).toEqual({
            type: "ok",
            revision: 1,
            edited: true,
          });
          const observed = await fixture.observe();
          expect(observed.messages).toEqual([{ content: edited, revision: 1 }]);
          expect(observed.revisions).toHaveLength(1);
          expect(observed.revisions.at(0)).toMatchObject({
            content: original,
            revision: 0,
            edit: acceptedChange.edit,
            createdBy: fixture.userId,
            messageId: fixture.messageId,
            workspaceId: fixture.workspaceId,
          });
          expect(observed.threads).toEqual([{ epoch: 1, ...emptyRecap }]);
          expect(observed.audits).toHaveLength(1);
          expect(observed.audits.at(0)).toMatchObject({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
            resourceId: fixture.messageId,
            userId: fixture.userId,
            metadata: { editType: CHAT_MESSAGE_EDIT_TYPE.format, revision: 1 },
          });
          expect(JSON.stringify(observed.audits)).not.toContain("Original");
          expect(JSON.stringify(observed.audits)).not.toContain("café");
          expect(await fixture.contextChanges()).toEqual(
            Result.ok([
              {
                messageId: fixture.messageId,
                revision: 1,
                before: "Original answer: café\n\nNext paragraph.",
                after: "**Original** answer: café\n\nNext paragraph.",
              },
            ]),
          );
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("stale accepts leave message, snapshots, epoch and audits unchanged; revert restores exact stored bytes", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          const unedited = await fixture.observe();
          expect(
            await fixture.write(db, {
              ...acceptedChange,
              selectedTextHash: sha256Hex("Changed selection"),
            }),
          ).toEqual({ type: "stale" });
          expect(await fixture.observe()).toEqual(unedited);
          await fixture.write(db, acceptedChange);
          const before = await fixture.observe();
          const originalBytes = await db.execute<{ bytes: string }>(
            sql`SELECT content::text AS bytes FROM chat_message_revisions WHERE message_id = ${fixture.messageId} AND revision = 0`,
          );
          expect(await fixture.write(db, acceptedChange)).toEqual({
            type: "stale",
          });
          expect(await fixture.observe()).toEqual(before);
          expect(
            await fixture.write(db, {
              type: "revert",
              baseRevision: 1,
              toRevision: 0,
            }),
          ).toEqual({ type: "ok", revision: 2, edited: true });
          const restoredBytes = await db.execute<{ bytes: string }>(
            sql`SELECT content::text AS bytes FROM chat_messages WHERE id = ${fixture.messageId}`,
          );
          expect(restoredBytes).toEqual(originalBytes);
          const after = await fixture.observe();
          expect(after.messages).toEqual([{ content: original, revision: 2 }]);
          expect(
            after.revisions.map(({ revision, content, edit }) => ({
              revision,
              content,
              edit,
            })),
          ).toEqual([
            { revision: 0, content: original, edit: acceptedChange.edit },
            {
              revision: 1,
              content: edited,
              edit: { type: CHAT_MESSAGE_EDIT_TYPE.revert, toRevision: 0 },
            },
          ]);
          expect(after.threads).toEqual([{ epoch: 2, ...emptyRecap }]);
          expect(after.audits).toHaveLength(2);
          expect(await fixture.contextChanges()).toEqual(
            Result.ok([
              {
                messageId: fixture.messageId,
                revision: 2,
                before: "**Original** answer: café\n\nNext paragraph.",
                after: "Original answer: café\n\nNext paragraph.",
              },
              {
                messageId: fixture.messageId,
                revision: 1,
                before: "Original answer: café\n\nNext paragraph.",
                after: "**Original** answer: café\n\nNext paragraph.",
              },
            ]),
          );
          const page = await fixture.scoped(db)(
            async (tx) =>
              await readChatMessageRevisionsOnTx({
                tx,
                threadId: fixture.threadId,
                messageId: fixture.messageId,
                userId: fixture.userId,
                organizationId: fixture.organizationId,
                getWorkspaceAccess: async (id) => ({ id, status: "active" }),
                limit: 1,
              }),
          );
          expect(page?.items.map(({ revision }) => revision)).toEqual([1]);
          expect(page?.nextCursor).toBeString();
          if (!page?.nextCursor) {
            throw new TypeError("Expected a revision page cursor");
          }
          const beforeRevision = decodePaginationCursor(page.nextCursor)?.at(0);
          if (typeof beforeRevision !== "number") {
            throw new TypeError("Expected a numeric revision cursor");
          }
          const older = await fixture.scoped(db)(
            async (tx) =>
              await readChatMessageRevisionsOnTx({
                tx,
                threadId: fixture.threadId,
                messageId: fixture.messageId,
                userId: fixture.userId,
                organizationId: fixture.organizationId,
                getWorkspaceAccess: async (id) => ({ id, status: "active" }),
                limit: 1,
                before: beforeRevision,
              }),
          );
          expect(older?.items.map(({ revision }) => revision)).toEqual([0]);
          expect(older?.nextCursor).toBeNull();
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("concurrent accepts from the same revision commit exactly one replacement", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const first = openClient({
          connection: { statement_timeout: 10_000, lock_timeout: 5000 },
        }).db;
        const second = openClient({
          connection: { statement_timeout: 10_000, lock_timeout: 5000 },
        }).db;
        const fixture = await seedFixture(first);
        try {
          const outcomes = await Promise.all([
            fixture.write(first, acceptedChange),
            fixture.write(second, acceptedChange),
          ]);
          expect(outcomes.map(({ type }) => type).toSorted()).toEqual([
            "ok",
            "stale",
          ]);
          const observed = await fixture.observe();
          expect(observed.messages).toEqual([{ content: edited, revision: 1 }]);
          expect(observed.revisions).toHaveLength(1);
          expect(observed.audits).toHaveLength(1);
          expect(observed.threads).toEqual([{ epoch: 1, ...emptyRecap }]);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("editing an answer after an active compaction preserves its checkpoint and advances the epoch", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          const summarizedMessageId = createSafeId<"chatMessage">();
          await db.insert(chatMessages).values({
            id: summarizedMessageId,
            threadId: fixture.threadId,
            workspaceId: fixture.workspaceId,
            userId: fixture.userId,
            role: "assistant",
            content: toPersistedChatMessageContentV3({
              data: [{ type: "text", content: "Earlier answer" }],
            }),
            createdAt: new Date(Date.now() - 60_000),
          });
          const boundary = (
            await db
              .select({ cursor: chatMessageCursorCodec.cursorValue })
              .from(chatMessages)
              .where(eq(chatMessages.id, summarizedMessageId))
          ).at(0);
          if (!boundary) {
            throw new TypeError("Expected the summarized message boundary");
          }
          const checkpointId = createSafeId<"chatThreadCompaction">();
          await db
            .update(chatThreads)
            .set({
              recapText: "Original answer recap",
              recapMessageId: summarizedMessageId,
              recapPromptVersion: 1,
              recapGeneratedAt: new Date(),
            })
            .where(eq(chatThreads.id, fixture.threadId));
          await db.insert(chatThreadCompactions).values({
            id: checkpointId,
            threadId: fixture.threadId,
            summary: EMPTY_SUMMARY,
            summaryMarkdown: "Original answer summary",
            firstSummarizedMessageId: summarizedMessageId,
            lastSummarizedMessageId: summarizedMessageId,
            firstKeptMessageId: fixture.messageId,
            summarizedMessageCount: 1,
            totalSummarizedMessageCount: 1,
            deltaCursor: chatMessageCursorCodec.encode(
              boundary.cursor,
              summarizedMessageId,
            ),
            totalTokens: 100,
            preservedTokens: 10,
            promptVersion: 1,
          });
          expect(await fixture.write(db, acceptedChange)).toEqual({
            type: "ok",
            revision: 1,
            edited: true,
          });
          expect(
            await db
              .select({ status: chatThreadCompactions.status })
              .from(chatThreadCompactions)
              .where(eq(chatThreadCompactions.id, checkpointId)),
          ).toEqual([{ status: "active" }]);
          expect((await fixture.observe()).threads).toEqual([
            { epoch: 1, ...emptyRecap },
          ]);
          const historyAfter = await fixture.scoped(db)(
            async (tx) =>
              await loadWindowedThreadMessages({
                tx,
                threadId: fixture.threadId,
              }),
          );
          expect(historyAfter.isOk()).toBe(true);
          if (!historyAfter.isOk()) {
            throw new TypeError(
              "Expected history after editing the unsummarized tail",
            );
          }
          expect(historyAfter.value.map(({ id }) => id)).toEqual([
            fixture.messageId,
          ]);
          expect(historyAfter.value.at(0)?.content.data).toEqual(
            normalizePersistedChatMessageContent(edited).parts,
          );
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("editing an answer inside an active compaction retires its summary and returns the edited answer to next-turn history", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          const keptMessageId = createSafeId<"chatMessage">();
          await db.insert(chatMessages).values({
            id: keptMessageId,
            threadId: fixture.threadId,
            workspaceId: fixture.workspaceId,
            userId: fixture.userId,
            role: "user",
            content: toPersistedChatMessageContentV3({
              data: [{ type: "text", content: "Continue" }],
            }),
            createdAt: new Date(Date.now() + 60_000),
          });
          const boundary = (
            await db
              .select({ cursor: chatMessageCursorCodec.cursorValue })
              .from(chatMessages)
              .where(eq(chatMessages.id, fixture.messageId))
          ).at(0);
          if (!boundary) {
            throw new TypeError("Expected the summarized message boundary");
          }
          const checkpointId = createSafeId<"chatThreadCompaction">();
          await db
            .update(chatThreads)
            .set({
              recapText: "Original answer recap",
              recapMessageId: keptMessageId,
              recapPromptVersion: 1,
              recapGeneratedAt: new Date(),
            })
            .where(eq(chatThreads.id, fixture.threadId));
          await db.insert(chatThreadCompactions).values({
            id: checkpointId,
            threadId: fixture.threadId,
            summary: EMPTY_SUMMARY,
            summaryMarkdown: "Original answer summary",
            firstSummarizedMessageId: fixture.messageId,
            lastSummarizedMessageId: fixture.messageId,
            firstKeptMessageId: keptMessageId,
            summarizedMessageCount: 1,
            totalSummarizedMessageCount: 1,
            deltaCursor: chatMessageCursorCodec.encode(
              boundary.cursor,
              fixture.messageId,
            ),
            totalTokens: 100,
            preservedTokens: 10,
            promptVersion: 1,
          });
          const historyBefore = await fixture.scoped(db)(
            async (tx) =>
              await loadWindowedThreadMessages({
                tx,
                threadId: fixture.threadId,
              }),
          );
          expect(historyBefore.isOk()).toBe(true);
          if (historyBefore.isOk()) {
            expect(historyBefore.value.map(({ id }) => id)).toEqual([
              keptMessageId,
            ]);
          }

          expect(await fixture.write(db, acceptedChange)).toEqual({
            type: "ok",
            revision: 1,
            edited: true,
          });
          const checkpoint = await db
            .select({ status: chatThreadCompactions.status })
            .from(chatThreadCompactions)
            .where(eq(chatThreadCompactions.id, checkpointId));
          expect(checkpoint).toEqual([{ status: "stale" }]);
          const historyAfter = await fixture.scoped(db)(
            async (tx) =>
              await loadWindowedThreadMessages({
                tx,
                threadId: fixture.threadId,
              }),
          );
          expect(historyAfter.isOk()).toBe(true);
          if (!historyAfter.isOk()) {
            throw new TypeError(
              "Expected next-turn history after an accepted edit",
            );
          }
          expect(historyAfter.value.map(({ id }) => id)).toEqual([
            fixture.messageId,
            keptMessageId,
          ]);
          expect(historyAfter.value.at(0)?.content.data).toEqual(
            normalizePersistedChatMessageContent(edited).parts,
          );
          const note = await fixture.scoped(db)(
            async (tx) =>
              await readChatRevisionContextChanges({
                tx,
                threadId: fixture.threadId,
                messages: historyAfter.value,
              }),
          );
          expect(note).toEqual(
            Result.ok([
              {
                messageId: fixture.messageId,
                revision: 1,
                before: "Original answer: café\n\nNext paragraph.",
                after: "**Original** answer: café\n\nNext paragraph.",
              },
            ]),
          );
          expect((await fixture.observe()).threads).toEqual([
            { epoch: 1, ...emptyRecap },
          ]);
          const staleRecap = await fixture.scoped(db)(
            async (tx) =>
              await cacheThreadRecapOnTx({
                tx,
                threadId: fixture.threadId,
                userId: fixture.userId,
                compactionEpoch: 0,
                lastMessageId: keptMessageId,
                recap: "Original answer recap",
              }),
          );
          expect(staleRecap).toEqual([]);
          expect((await fixture.observe()).threads).toEqual([
            { epoch: 1, ...emptyRecap },
          ]);
          const currentRecap = await fixture.scoped(db)(
            async (tx) =>
              await cacheThreadRecapOnTx({
                tx,
                threadId: fixture.threadId,
                userId: fixture.userId,
                compactionEpoch: 1,
                lastMessageId: keptMessageId,
                recap: "Edited answer recap",
              }),
          );
          expect(currentRecap).toEqual([{ id: fixture.threadId }]);
          expect((await fixture.observe()).threads.at(0)).toMatchObject({
            epoch: 1,
            recapText: "Edited answer recap",
            recapMessageId: keptMessageId,
          });
          expect(
            await fixture.write(db, {
              type: "revert",
              baseRevision: 1,
              toRevision: 0,
            }),
          ).toEqual({ type: "ok", revision: 2, edited: true });
          expect((await fixture.observe()).threads).toEqual([
            { epoch: 2, ...emptyRecap },
          ]);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("invalid metadata, non-text parts, shapes, counts and spans leave every revision side effect unchanged", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          const rich = toPersistedChatMessageContentV3({
            data: [
              { type: "text", content: "Original answer" },
              { type: "thinking", content: "Stored reasoning" },
            ],
            metadata: {
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            },
          });
          await db
            .update(chatMessages)
            .set({ content: rich })
            .where(eq(chatMessages.id, fixture.messageId));
          const before = await fixture.observe();
          const invalid = [
            {
              content: {
                ...rich,
                metadata: {
                  usage: {
                    promptTokens: 1,
                    completionTokens: 3,
                    totalTokens: 4,
                  },
                },
              },
              edit: acceptedChange.edit,
              expected: "invalid-content" as const,
            },
            {
              content: {
                ...rich,
                data: [
                  { type: "text", content: "Original answer" },
                  { type: "thinking", content: "Changed reasoning" },
                ],
              },
              edit: acceptedChange.edit,
              expected: "invalid-content" as const,
            },
            {
              content: {
                ...rich,
                data: [{ type: "text", content: 42 }, ...rich.data.slice(1)],
              },
              edit: acceptedChange.edit,
              expected: "invalid-content" as const,
            },
            {
              content: {
                ...rich,
                data: [...rich.data, { type: "text", content: "Extra" }],
              },
              edit: acceptedChange.edit,
              expected: "invalid-content" as const,
            },
            ...[
              { content: "Changed **answer**", start: 9, end: 15 },
              { content: "**Original** changed", start: 0, end: 8 },
            ].map(({ content, start, end }) => ({
              content: {
                ...rich,
                data: [{ type: "text", content }, ...rich.data.slice(1)],
              },
              edit: { ...acceptedChange.edit, start, end },
              expected: "invalid-edit" as const,
            })),
            {
              content: rich,
              edit: { ...acceptedChange.edit, end: 99 },
              expected: "invalid-edit" as const,
            },
          ];
          for (const candidate of invalid) {
            expect(
              await fixture.write(db, {
                type: "accept",
                baseRevision: 0,
                selectedTextHash: sha256Hex(
                  "Original answer".slice(
                    candidate.edit.start,
                    candidate.edit.end,
                  ),
                ),
                content: candidate.content,
                edit: candidate.edit,
              }),
            ).toEqual({ type: candidate.expected });
            expect(await fixture.observe()).toEqual(before);
          }
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("denied matter access prevents revision reads and writes without mutation", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          const before = await fixture.observe();
          for (const getWorkspaceAccess of [
            async () => null,
            async () => ({
              id: fixture.workspaceId,
              status: "deleting" as const,
            }),
          ]) {
            const write = await fixture.scoped(db)(
              async (tx) =>
                await writeChatMessageRevisionOnTx({
                  tx,
                  threadId: fixture.threadId,
                  messageId: fixture.messageId,
                  userId: fixture.userId,
                  organizationId: fixture.organizationId,
                  getWorkspaceAccess,
                  change: acceptedChange,
                  recordAuditEvent: async () => {
                    throw new TypeError("Denied write reached audit");
                  },
                }),
            );
            expect(write).toEqual({ type: "not-found" });
            const page = await fixture.scoped(db)(
              async (tx) =>
                await readChatMessageRevisionsOnTx({
                  tx,
                  threadId: fixture.threadId,
                  messageId: fixture.messageId,
                  userId: fixture.userId,
                  organizationId: fixture.organizationId,
                  getWorkspaceAccess,
                  limit: 1,
                }),
            );
            expect(page).toBeNull();
            expect(await fixture.observe()).toEqual(before);
          }
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("an audit failure rolls back content, revision snapshots and compaction epoch", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          await db
            .update(chatThreads)
            .set({
              recapText: "Original answer recap",
              recapMessageId: fixture.messageId,
              recapPromptVersion: 1,
              recapGeneratedAt: new Date(),
            })
            .where(eq(chatThreads.id, fixture.threadId));
          const before = await fixture.observe();
          const failure = new TypeError("Revision audit sink failed");
          const result = await Result.tryPromise(
            async () =>
              await fixture.scoped(db)(
                async (tx) =>
                  await writeChatMessageRevisionOnTx({
                    tx,
                    threadId: fixture.threadId,
                    messageId: fixture.messageId,
                    userId: fixture.userId,
                    organizationId: fixture.organizationId,
                    getWorkspaceAccess: async (id) => ({
                      id,
                      status: "active",
                    }),
                    change: acceptedChange,
                    recordAuditEvent: async () => {
                      throw failure;
                    },
                  }),
              ),
          );
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(result.error.cause).toBe(failure);
          }
          expect(await fixture.observe()).toEqual(before);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("rejects user messages and unsettled turns without changing revision state", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          await db
            .update(chatMessages)
            .set({ role: "user" })
            .where(eq(chatMessages.id, fixture.messageId));
          const beforeUser = await fixture.observe();
          expect(await fixture.write(db, acceptedChange)).toEqual({
            type: "not-assistant",
          });
          expect(await fixture.observe()).toEqual(beforeUser);
          await db
            .update(chatMessages)
            .set({ role: "assistant" })
            .where(eq(chatMessages.id, fixture.messageId));
          await db
            .update(chatMessages)
            .set({
              content: toChatMessageContent({
                version: 2,
                data: [
                  { type: "text", content: "Draft answer" },
                  {
                    type: "tool-call",
                    id: "partial-call",
                    name: "mcp__external__search",
                    state: "input-streaming",
                    arguments: '{"query":"partial',
                  },
                ],
              }),
            })
            .where(eq(chatMessages.id, fixture.messageId));
          const beforePartial = await fixture.observe();
          expect(await fixture.write(db, acceptedChange)).toEqual({
            type: "unsettled",
          });
          expect(await fixture.observe()).toEqual(beforePartial);
          await db
            .update(chatMessages)
            .set({ content: original })
            .where(eq(chatMessages.id, fixture.messageId));
          const userMessageId = createSafeId<"chatMessage">();
          await db.insert(chatMessages).values({
            id: userMessageId,
            threadId: fixture.threadId,
            workspaceId: fixture.workspaceId,
            userId: fixture.userId,
            role: "user",
            content: original,
          });
          await db.insert(chatTurns).values({
            threadId: fixture.threadId,
            workspaceId: fixture.workspaceId,
            organizationId: fixture.organizationId,
            userId: fixture.userId,
            userMessageId,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          });
          const beforeActive = await fixture.observe();
          expect(await fixture.write(db, acceptedChange)).toEqual({
            type: "unsettled",
          });
          expect(await fixture.observe()).toEqual(beforeActive);
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test("edits preserve text-part boundaries around a settled tool call", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const fixture = await seedFixture(db);
        try {
          const content = toPersistedChatMessageContentV3({
            data: [
              { type: "text", content: "Hello" },
              {
                type: "tool-call",
                id: "settled-call",
                name: "mcp__external__search",
                arguments: '{"query":"answer"}',
                state: "complete",
                output: { answer: "Found" },
              },
              { type: "text", content: "World" },
            ],
          });
          await db
            .update(chatMessages)
            .set({ content })
            .where(eq(chatMessages.id, fixture.messageId));
          const before = await fixture.observe();
          const edit = {
            type: CHAT_MESSAGE_EDIT_TYPE.aiSpan,
            instruction: "Expand the selected letter",
            model: "fixture-model",
            keySource: "instance",
            start: 0,
            end: 1,
          } as const;
          const redistributed = {
            ...content,
            data: content.data.map((part, index) => {
              if (part.type !== "text") {
                return part;
              }
              return { ...part, content: index === 0 ? "Hi" : "elloWorld" };
            }),
          };
          expect(
            await fixture.write(db, {
              type: "accept",
              baseRevision: 0,
              selectedTextHash: sha256Hex("H"),
              content: redistributed,
              edit,
            }),
          ).toEqual({ type: "invalid-edit" });
          expect(await fixture.observe()).toEqual(before);

          const candidate = {
            ...content,
            data: content.data.map((part, index) =>
              part.type === "text" && index === 0
                ? { ...part, content: "Haello" }
                : part,
            ),
          };
          expect(
            await fixture.write(db, {
              type: "accept",
              baseRevision: 0,
              selectedTextHash: sha256Hex("H"),
              content: candidate,
              edit,
            }),
          ).toEqual({ type: "ok", revision: 1, edited: true });
          const observed = await fixture.observe();
          expect(observed.messages).toEqual([
            { content: candidate, revision: 1 },
          ]);
          expect(observed.messages.at(0)?.content.data.slice(1)).toEqual(
            content.data.slice(1),
          );
          expect(observed.revisions.at(0)).toMatchObject({
            revision: 0,
            content,
          });
        } finally {
          await fixture.cleanUp();
        }
      });
    });

    test.each([
      {
        outcome: "denied approval",
        toolCall: {
          type: "tool-call",
          id: "denied-call",
          name: "mcp__external__search",
          arguments: '{"query":"answer"}',
          state: "approval-responded",
          approval: {
            id: "denied-approval",
            needsApproval: true,
            approved: false,
          },
        },
      },
      {
        outcome: "failed tool call",
        toolCall: {
          type: "tool-call",
          id: "failed-call",
          name: "mcp__external__search",
          arguments: '{"query":"answer"}',
          state: "error",
          output: { error: "Search unavailable" },
        },
      },
    ] as const)(
      "editing an answer after a $outcome preserves its settled tool part",
      async ({ toolCall }) => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const db = openClient().db;
          const fixture = await seedFixture(db);
          try {
            const content = toPersistedChatMessageContentV3({
              data: [
                ...normalizePersistedChatMessageContent(original).parts,
                toolCall,
              ],
            });
            const candidate = {
              ...content,
              data: [...edited.data, ...content.data.slice(1)],
            };
            expect(content.data.at(1)).toMatchObject({
              type: "tool-call",
              state: toolCall.state,
              ...(toolCall.state === "approval-responded"
                ? { approval: toolCall.approval }
                : { output: { value: toolCall.output } }),
            });
            await db
              .update(chatMessages)
              .set({ content })
              .where(eq(chatMessages.id, fixture.messageId));

            expect(
              await fixture.write(db, {
                ...acceptedChange,
                content: candidate,
              }),
            ).toEqual({ type: "ok", revision: 1, edited: true });
            const observed = await fixture.observe();
            expect(observed.messages).toEqual([
              { content: candidate, revision: 1 },
            ]);
            expect(observed.messages.at(0)?.content.data.at(1)).toEqual(
              content.data.at(1),
            );
            expect(observed.revisions.at(0)).toMatchObject({
              revision: 0,
              content,
            });
            expect(observed.threads).toEqual([{ epoch: 1, ...emptyRecap }]);
            expect(observed.audits).toHaveLength(1);
          } finally {
            await fixture.cleanUp();
          }
        });
      },
    );
  });
}
