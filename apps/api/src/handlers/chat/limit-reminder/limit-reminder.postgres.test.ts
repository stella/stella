import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  chatLimitReminders,
  chatMessages,
  chatThreads,
  chatTurns,
  notifications,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { readLimitedLatestTurn } from "@/api/handlers/chat/limit-reminder/shared";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { takeDueChatLimitReminders } from "@/api/lib/scheduler/tasks/chat-limit-reminders";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const HOUR_MS = 60 * 60 * 1000;
const clock = createTestClock();
const now = new Date(clock.now());
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

type Owner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type SeededTurn = {
  status: "completed" | "failed";
  /** The reset time stored on the turn's answer; none for other failures. */
  limitResetsAt?: Date;
};

const suite = (
  database: GatedTestDb,
  cleanUp: (step: () => Promise<void>) => void,
) => {
  const seedOwner = async (): Promise<Owner> => {
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    await database.insert(organization).values({
      id: organizationId,
      name: "Limit reminder fixture",
      slug: organizationId,
    });
    await database.insert(organizationAccessStates).values({
      organizationId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    });
    await database.insert(user).values({
      email: `${userId}@example.test`,
      id: userId,
      name: "Limit reminder fixture",
    });
    await database.insert(member).values({
      id: mintAuthProviderIdValue(),
      organizationId,
      role: "member",
      userId,
    });
    cleanUp(async () => {
      await database
        .delete(notifications)
        .where(eq(notifications.organizationId, organizationId));
      await database
        .delete(chatThreads)
        .where(eq(chatThreads.organizationId, organizationId));
      await deleteOrganizationsForTest(database, [organizationId]);
      await database.delete(user).where(eq(user.id, userId));
    });
    return { organizationId, userId };
  };

  /** A chat of `owner` whose turns ran in this order, oldest first. */
  const seedThread = async (owner: Owner, turns: readonly SeededTurn[]) => {
    const threadId = createSafeId<"chatThread">();
    await database.insert(chatThreads).values({
      id: threadId,
      organizationId: owner.organizationId,
      title: "Limit reminder fixture",
      userId: owner.userId,
      workspaceId: null,
    });
    const turnIds: SafeId<"chatTurn">[] = [];
    const base = now.getTime() - 10 * HOUR_MS;
    for (const [index, turn] of turns.entries()) {
      const questionId = createSafeId<"chatMessage">();
      const answerId = createSafeId<"chatMessage">();
      await database.insert(chatMessages).values([
        {
          content: toPersistedChatMessageContentV3({
            data: [{ content: "Question", type: "text" }],
          }),
          createdAt: new Date(base + index * 2),
          id: questionId,
          role: "user",
          threadId,
          userId: owner.userId,
          workspaceId: null,
        },
        {
          content: toPersistedChatMessageContentV3({
            data: [],
            metadata: {
              turnOutcome:
                turn.status === "completed"
                  ? { type: "completed" }
                  : {
                      type: "failed",
                      error: "local_runner_limit_reached",
                      ...(turn.limitResetsAt === undefined
                        ? {}
                        : { limitResetsAt: turn.limitResetsAt.toISOString() }),
                    },
            },
          }),
          createdAt: new Date(base + index * 2 + 1),
          id: answerId,
          role: "assistant",
          threadId,
          userId: owner.userId,
          workspaceId: null,
        },
      ]);
      const turnId = createSafeId<"chatTurn">();
      await database.insert(chatTurns).values({
        assistantMessageId: answerId,
        createdAt: new Date(base + index * 2),
        id: turnId,
        organizationId: owner.organizationId,
        status: turn.status,
        threadId,
        userId: owner.userId,
        userMessageId: questionId,
        workspaceId: null,
      });
      turnIds.push(turnId);
    }
    return {
      firstTurnId: turnIds.at(0) ?? panic("A seeded chat has a turn"),
      threadId,
      turnIds,
    };
  };

  const remind = async (
    owner: Owner,
    threadId: SafeId<"chatThread">,
    turnId: SafeId<"chatTurn">,
    remindAt: Date,
  ) => {
    await database.insert(chatLimitReminders).values({
      organizationId: owner.organizationId,
      remindAt,
      threadId,
      turnId,
      userId: owner.userId,
    });
  };

  const filedFor = async (threadIds: readonly SafeId<"chatThread">[]) =>
    await database
      .select({ entityId: notifications.entityId, kind: notifications.kind })
      .from(notifications)
      .where(
        and(
          eq(notifications.entityType, "chat_thread"),
          inArray(notifications.entityId, [...threadIds]),
        ),
      );

  describe("which turn a reminder can be set for", () => {
    test("only a latest turn stopped by a limit that resets later", async () => {
      const owner = await seedOwner();
      const later = at(HOUR_MS);
      const limited = await seedThread(owner, [
        { status: "completed" },
        { limitResetsAt: later, status: "failed" },
      ]);
      const continued = await seedThread(owner, [
        { limitResetsAt: later, status: "failed" },
        { status: "completed" },
      ]);
      const otherFailure = await seedThread(owner, [{ status: "failed" }]);
      const alreadyReset = await seedThread(owner, [
        { limitResetsAt: at(-HOUR_MS), status: "failed" },
      ]);

      const read = async (threadId: SafeId<"chatThread">) =>
        await database.transaction(
          async (tx) => await readLimitedLatestTurn({ now, threadId, tx }),
        );

      const found = await read(limited.threadId);
      expect(found.isOk() && found.value).toEqual({
        resetsAt: later,
        turnId: limited.turnIds.at(1),
      });
      for (const { threadId } of [continued, otherFailure, alreadyReset]) {
        const refused = await read(threadId);
        expect(refused.isErr() && refused.error.status).toBe(409);
      }
    });
  });

  describe("the reminder sweep", () => {
    test("notifies a waiting chat once, skips a continued one and keeps one not yet due", async () => {
      const owner = await seedOwner();
      const past = at(-60 * 1000);
      const waiting = await seedThread(owner, [
        { limitResetsAt: past, status: "failed" },
      ]);
      const continued = await seedThread(owner, [
        { limitResetsAt: past, status: "failed" },
        { status: "completed" },
      ]);
      const notYet = await seedThread(owner, [
        { limitResetsAt: at(HOUR_MS), status: "failed" },
      ]);
      await remind(owner, waiting.threadId, waiting.firstTurnId, past);
      await remind(owner, continued.threadId, continued.firstTurnId, past);
      await remind(owner, notYet.threadId, notYet.firstTurnId, at(HOUR_MS));

      await takeDueChatLimitReminders({ database, now });
      // A second pass finds nothing left to take for these chats.
      await takeDueChatLimitReminders({ database, now });

      expect(
        await filedFor([waiting.threadId, continued.threadId, notYet.threadId]),
      ).toEqual([
        {
          entityId: waiting.threadId,
          kind: NOTIFICATION_KIND.LOCAL_RUN_LIMIT_RESET,
        },
      ]);
      const left = await database
        .select({ threadId: chatLimitReminders.threadId })
        .from(chatLimitReminders)
        .where(
          inArray(chatLimitReminders.threadId, [
            waiting.threadId,
            continued.threadId,
            notYet.threadId,
          ]),
        );
      expect(left).toEqual([{ threadId: notYet.threadId }]);
    });
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("chat limit reminders (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("chat limit reminders (postgres)", () => {
    const { cleanUp, db } = openGatedTestDatabase(databaseUrl);
    suite(db, cleanUp);
  });
}
