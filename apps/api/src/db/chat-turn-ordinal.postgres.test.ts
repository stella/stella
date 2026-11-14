/**
 * A chat turn's position under concurrent senders, on PostgreSQL with one
 * session per sender: positions follow the order the thread's lock was taken
 * in, never the order the senders' transactions started in.
 */

import { panic } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { waitForExternalState } from "@stll/property-testing/external-state";

import { member, organization, user } from "@/api/db/auth-schema";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { NEWEST_CHAT_TURN_FIRST } from "@/api/lib/chat/turn-order";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const BORN = new Date("2026-01-01T00:00:00.000Z");

if (!databaseUrl || !runPostgresTests) {
  describe.skip("chat turn positions under concurrent senders (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("chat turn positions under concurrent senders (postgres)", () => {
    // Two senders and the session that watches them.
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl, { max: 3 });
    type Sender = Parameters<Parameters<typeof db.transaction>[0]>[0];
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const threadIds: SafeId<"chatThread">[] = [];

    beforeAll(async () => {
      await db.insert(user).values({
        id: userId,
        name: "Turn position test",
        email: `${userId}@example.test`,
      });
      await db.insert(organization).values({
        id: organizationId,
        name: "Turn position test",
        slug: organizationId,
        createdAt: BORN,
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: BORN,
      });
    });
    cleanUp(async () => {
      await db.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
      await deleteOrganizationsForTest(db, [organizationId]);
      await db.delete(user).where(eq(user.id, userId));
    });

    const newThread = async () => {
      const id = createSafeId<"chatThread">();
      threadIds.push(id);
      await db.insert(chatThreads).values({
        id,
        organizationId,
        userId,
        title: "Turn positions",
      });
      return id;
    };

    /** Stores a settled turn of the thread, as a sender's transaction does. */
    const storeTurn = async (
      sender: Sender,
      threadId: SafeId<"chatThread">,
    ) => {
      const userMessageId = createSafeId<"chatMessage">();
      await sender.insert(chatMessages).values({
        id: userMessageId,
        threadId,
        userId,
        role: "user",
        content: toPersistedChatMessageContentV3({
          data: [{ type: "text", content: "Question" }],
        }),
      });
      const id = createSafeId<"chatTurn">();
      await sender.insert(chatTurns).values({
        id,
        organizationId,
        userId,
        threadId,
        userMessageId,
        status: "cancelled",
        cancellationReason: "user-stop",
        // After any start this test stores; the row's own start is `now()`.
        settledAt: sql`now() + interval '1 day'`,
      });
      return id;
    };

    const readTurns = async (threadId: SafeId<"chatThread">) =>
      await db
        .select({
          id: chatTurns.id,
          ordinal: chatTurns.ordinal,
          /** The turn's place by its stored start, the order read until now. */
          storedPosition: sql<string>`row_number() OVER (ORDER BY created_at, id)::text`,
        })
        .from(chatTurns)
        .where(eq(chatTurns.threadId, threadId))
        .orderBy(...NEWEST_CHAT_TURN_FIRST);

    test("a sender whose transaction started first but took the thread's lock second gets the later position", async () => {
      const threadId = await newThread();
      const firstStarted = Promise.withResolvers<undefined>();
      const secondCommitted = Promise.withResolvers<undefined>();

      const early = db.transaction(async (sender) => {
        // The transaction's start, and so its turn's stored start, is fixed
        // here; the pause keeps the other sender's start measurably later.
        await sender.execute(sql`SELECT now(), pg_sleep(0.02)`);
        firstStarted.resolve(undefined);
        await secondCommitted.promise;
        return await storeTurn(sender, threadId);
      });
      await firstStarted.promise;
      const lateTurn = await db.transaction(
        async (sender) => await storeTurn(sender, threadId),
      );
      secondCommitted.resolve(undefined);
      const earlyTurn = await early;

      const turns = await readTurns(threadId);
      const positionOf = (id: string) =>
        turns.find((turn) => turn.id === id) ?? panic("the turn is gone");
      // The fixture reaches the fault: by stored start the turn accepted
      // second sorts first.
      expect(positionOf(earlyTurn).storedPosition).toBe("1");
      expect(positionOf(lateTurn).storedPosition).toBe("2");
      // Positions follow the lock.
      expect(positionOf(lateTurn).ordinal).toBe(1);
      expect(positionOf(earlyTurn).ordinal).toBe(2);
      expect(turns.at(0)?.id).toBe(earlyTurn);
    });

    test("two senders storing a turn at once get distinct, consecutive positions", async () => {
      const threadId = await newThread();
      const firstStored = Promise.withResolvers<undefined>();
      const releaseFirst = Promise.withResolvers<undefined>();

      const first = db.transaction(async (sender) => {
        const id = await storeTurn(sender, threadId);
        firstStored.resolve(undefined);
        await releaseFirst.promise;
        return id;
      });
      await firstStored.promise;
      // Blocks in the trigger on the thread's row until the first commits.
      const second = db.transaction(
        async (sender) => await storeTurn(sender, threadId),
      );
      await waitForExternalState({
        description: "the second sender waiting on the thread's row lock",
        read: async () => {
          const waiting = await db.execute(
            sql`SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple') LIMIT 1`,
          );
          return waiting.at(0) !== undefined;
        },
      });
      releaseFirst.resolve(undefined);
      const [firstTurn, secondTurn] = await Promise.all([first, second]);

      const turns = await readTurns(threadId);
      expect(turns.map(({ id, ordinal }) => ({ id, ordinal }))).toEqual([
        { id: secondTurn, ordinal: 2 },
        { id: firstTurn, ordinal: 1 },
      ]);
      const [thread] = await db
        .select({ lastTurnOrdinal: chatThreads.lastTurnOrdinal })
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId));
      expect(thread?.lastTurnOrdinal).toBe(2);
    });
  });
}
