import { EventType, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createChatRunLog,
  createChatRunLogReplay,
} from "@/api/lib/chat/run-log";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("chat delivery durability (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("chat delivery durability (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl, { max: 2 });
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const threadId = createSafeId<"chatThread">();
    const turnId = createSafeId<"chatTurn">();
    const messageId = createSafeId<"chatMessage">();
    const runId = Bun.randomUUIDv7();
    const executionId = Bun.randomUUIDv7();
    const scopedDb = createScopedDb(
      markRlsDatabase(db),
      [],
      organizationId,
      userId,
    );
    beforeAll(async () => {
      await db.insert(user).values({
        id: userId,
        name: "Delivery test",
        email: `${userId}@example.test`,
      });
      await db.insert(organization).values([
        {
          id: organizationId,
          name: "Delivery test",
          slug: organizationId,
          createdAt: new Date(),
        },
      ]);
      await db.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      ]);
      await db.insert(chatThreads).values({
        id: threadId,
        organizationId,
        userId,
        title: "Delivery test",
      });
      await db.insert(chatMessages).values({
        id: messageId,
        threadId,
        userId,
        role: "user",
        content: { version: 1, data: [{ type: "text", text: "Continue" }] },
      });
      await db.insert(chatTurns).values({
        id: turnId,
        organizationId,
        userId,
        threadId,
        userMessageId: messageId,
        runId,
        executionId,
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
    });
    cleanUp(async () => {
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    });

    test("keeps the producer alive after delivery disconnect and replays the exact remaining bytes across scoped sessions", async () => {
      const log = createChatRunLog({
        db: scopedDb,
        execution: { id: turnId, executionId },
        organizationId,
        runId,
      });
      const gate = Promise.withResolvers<undefined>();
      const closed = Promise.withResolvers<undefined>();
      const abortController = new AbortController();
      let providerCalls = 0;
      const chunks = ["First.", " Second.", " Third."].map(
        (delta) =>
          ({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta,
          }) satisfies StreamChunk,
      );
      const response = toServerSentEventsResponse(
        (async function* () {
          providerCalls += 1;
          yield chunks.at(0) ?? panic("Expected first chunk");
          await gate.promise;
          yield* chunks.slice(1);
        })(),
        {
          abortController,
          durability: {
            batch: 1,
            adapter: {
              ...log,
              close: async () => {
                await log.close();
                closed.resolve(undefined);
              },
            },
          },
        },
      );
      const reader =
        response.body?.getReader() ?? panic("Expected SSE delivery");
      const decoder = new TextDecoder();
      let prefix = "";
      while (!prefix.includes("First.")) {
        const read = await reader.read();
        if (read.done) {
          panic("Producer ended before disconnect");
        }
        prefix += decoder.decode(read.value);
      }
      const offset =
        prefix
          .match(/id: ([0-9]+)/gu)
          ?.at(-1)
          ?.slice(4) ?? panic("Missing durable offset");
      await reader.cancel();
      expect(abortController.signal.aborted).toBe(false);
      const replay =
        (await createChatRunLogReplay({
          db: scopedDb,
          organizationId,
          runId,
          resumeOffset: offset,
        })) ?? panic("Expected replay");
      const resumed = toServerSentEventsResponse(
        (async function* () {
          providerCalls += 1;
        })(),
        { durability: { adapter: replay } },
      ).text();
      gate.resolve(undefined);
      const tail = await resumed;
      await closed.promise;
      const delivered = (prefix + tail)
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      expect(delivered.slice(1)).toEqual(chunks);
      expect(providerCalls).toBe(1);
      expect(
        await createChatRunLogReplay({
          db: scopedDb,
          organizationId,
          runId,
          resumeOffset: offset,
        }),
      ).toBeNull();
    });
  });
}
