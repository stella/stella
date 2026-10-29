import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ChatTurnTiming } from "@stll/api-contract/chat";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  chatMessages,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId } from "@/api/lib/branded-types";
import labels from "@/api/lib/case-law/withdrawn-decision-labels.gen.json";
import { createChatRunLog } from "@/api/lib/chat/run-log";
import { deleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("withdrawn replay timing (postgres)", () => {
  const { db, cleanUp } = openGatedTestDatabase(
    process.env["DATABASE_URL"] ??
      panic("Postgres fixture requires DATABASE_URL"),
  );
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const sourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  const scopedDb = createScopedDb(
    markRlsDatabase(db),
    [],
    organizationId,
    userId,
  );
  const timing = {
    status: "finished",
    durationMs: 4250,
  } satisfies ChatTurnTiming;
  const own = "My own note";
  const answer = "Decision summary";

  beforeAll(async () => {
    await db
      .insert(user)
      .values({
        id: userId,
        name: "Replay timing",
        email: `${userId}@example.test`,
      });
    await db
      .insert(organization)
      .values({
        id: organizationId,
        name: "Replay timing",
        slug: organizationId,
        createdAt: new Date(),
      });
    await db
      .insert(member)
      .values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
    await db
      .insert(caseLawSources)
      .values({
        id: sourceId,
        adapterKey: sourceId,
        name: "Replay timing",
        enabled: false,
      });
    await db
      .insert(caseLawDecisions)
      .values({
        id: decisionId,
        sourceId,
        sourceDocumentId: decisionId,
        caseNumber: "Fixture",
        country: "POL",
        court: "Fixture",
        language: "pl",
        fulltext: answer,
        contentHash: "fixture",
      });
  });
  cleanUp(async () => {
    await db
      .delete(chatThreads)
      .where(eq(chatThreads.organizationId, organizationId));
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId));
    await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    await db.delete(organization).where(eq(organization.id, organizationId));
    await db.delete(user).where(eq(user.id, userId));
  });

  test.each(["snapshot", "cursor"] as const)(
    "%s replay preserves END timing and authored text",
    async (mode) => {
      const threadId = createSafeId<"chatThread">();
      const incomingId = createSafeId<"chatMessage">();
      const assistantId = createSafeId<"chatMessage">();
      const execution = {
        id: createSafeId<"chatTurn">(),
        executionId: Bun.randomUUIDv7(),
      };
      const runId = Bun.randomUUIDv7();
      await scopedDb(async (tx) => {
        await tx
          .insert(chatThreads)
          .values({
            id: threadId,
            organizationId,
            userId,
            title: own,
            titleSource: "user",
            subjectDecisionId: decisionId,
          });
        await tx
          .insert(chatMessages)
          .values({
            id: incomingId,
            threadId,
            userId,
            role: "user",
            content: toPersistedChatMessageContentV3({
              data: [{ type: "text", content: own }],
            }),
          });
        await tx
          .insert(chatTurns)
          .values({
            id: execution.id,
            executionId: execution.executionId,
            organizationId,
            userId,
            threadId,
            userMessageId: incomingId,
            runId,
            status: "running",
            leaseExpiresAt: new Date(Date.now() + 60_000),
          });
      });
      const options = { organizationId, runId, execution, db: scopedDb };
      const writer = createChatRunLog(options);
      const end = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: assistantId,
        timestamp: 1_793_268_001_000,
        metadata: { turnTiming: timing },
      } satisfies StreamChunk;
      const authoredEnd = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: incomingId,
        metadata: { note: own },
      } satisfies StreamChunk;
      await writer.append([
        buildWireSnapshot([{ id: incomingId, role: "user", content: own }]),
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: incomingId,
          delta: own,
        },
        authoredEnd,
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId: assistantId,
          role: "assistant",
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistantId,
          delta: answer,
        },
        end,
        { type: EventType.RUN_FINISHED, threadId, runId },
      ]);
      await writer.close();
      const withdrawn = await redactCaseLawDecision({
        decisionId,
        scopedDb: asTestRaw<ScopedDb>(
          async <T>(read: (tx: Transaction) => Promise<T>) =>
            await db.transaction(async (tx) => await read(asTestRaw(tx))),
        ),
        sweepRaw: async () => ({ type: "swept", legacy: "none" }),
        deleteCorpus: async (keys, deletionOptions) =>
          await deleteCorpusDocument(keys, {
            ...deletionOptions,
            deleteObject: async () => undefined,
          }),
      });
      expect(withdrawn.isOk()).toBe(true);
      const entries = [];
      if (mode === "snapshot") {
        entries.push(...(await writer.snapshot()));
      } else {
        for await (const entry of createChatRunLog(options).read(
          "1",
          new AbortController().signal,
        )) {
          entries.push(entry);
        }
      }
      expect(
        entries
          .filter(({ chunk }) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)
          .map(({ chunk }) => chunk),
      ).toEqual([
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: incomingId,
          delta: own,
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: assistantId,
          delta: labels.en,
        },
      ]);
      expect(
        entries.find(
          ({ chunk }) =>
            chunk.type === EventType.TEXT_MESSAGE_END &&
            chunk.messageId === incomingId,
        )?.chunk,
      ).toEqual(authoredEnd);
      expect(
        entries.find(
          ({ chunk }) =>
            chunk.type === EventType.TEXT_MESSAGE_END &&
            chunk.messageId === assistantId,
        ),
      ).toEqual({ offset: "6", chunk: end });
    },
  );
});
