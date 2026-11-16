import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import {
  CHAT_LIMIT_RESET_ACTION,
  type ChatLimitResetAction,
} from "@stll/api-contract/chat-limit-reminder";
import { CHAT_QUEUE_HOLD_REASON } from "@stll/api-contract/chat-queue";
import { NOTIFICATION_KIND } from "@stll/api-contract/notifications";
import { compareCodeUnit } from "@stll/collation";
import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import { discardChatLimitResume } from "@/api/db/root";
import {
  chatLimitReminders,
  chatMessages,
  chatQueueHolds,
  chatThreads,
  chatTurns,
  notifications,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  PROFESSIONAL_USE_ACCEPTANCE_SOURCE,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { resumeChatAfterLimit } from "@/api/handlers/chat/limit-reminder/limit-resume";
import { readLimitedLatestTurn } from "@/api/handlers/chat/limit-reminder/shared";
import { recordAccountProfessionalUse } from "@/api/lib/auth/professional-use";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type ChatLimitResumeEnd,
  endChatLimitResumeOnTx,
} from "@/api/lib/chat/limit-reset-notification";
import { lockChatThreadForTurnOnTx } from "@/api/lib/db/aggregate-lock";
import {
  CHAT_LIMIT_RESUME_WINDOW_MS,
  readDueChatLimitResumesOnTx,
} from "@/api/lib/db/chat-limit-reminder-system";
import { takeChatLimitResumeOnTx } from "@/api/lib/db/chat-limit-resume";
import { takeDueChatLimitReminders } from "@/api/lib/scheduler/tasks/chat-limit-reminders";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { chatLimitReminderScalingScenario } from "@/api/tests/read-scaling/chat-limit-reminder";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

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
      createdAt: now,
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
      createdAt: now,
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
      // A settled turn: a failed one carries why it failed, as the turn
      // state CHECK requires.
      await database.insert(chatTurns).values({
        assistantMessageId: answerId,
        createdAt: new Date(base + index * 2),
        ...(turn.status === "failed"
          ? { failureCode: "provider-error", failureRetryable: false }
          : {}),
        id: turnId,
        organizationId: owner.organizationId,
        settledAt: new Date(base + index * 2 + 1),
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
    onReset: ChatLimitResetAction = CHAT_LIMIT_RESET_ACTION.notify,
  ) => {
    await database.insert(chatLimitReminders).values({
      organizationId: owner.organizationId,
      remindAt,
      threadId,
      turnId,
      userId: owner.userId,
      onReset,
    });
  };

  const remindersOf = async (threadIds: readonly SafeId<"chatThread">[]) =>
    await database
      .select({
        threadId: chatLimitReminders.threadId,
        onReset: chatLimitReminders.onReset,
      })
      .from(chatLimitReminders)
      .where(inArray(chatLimitReminders.threadId, [...threadIds]));

  /** The resumed turn's acceptance taking the request, under the thread lock. */
  const takeResume = async (
    threadId: SafeId<"chatThread">,
    failedTurnId: SafeId<"chatTurn">,
  ) =>
    await database.transaction(async (tx) => {
      expect(await lockChatThreadForTurnOnTx({ threadId, tx })).toBe(true);
      return await takeChatLimitResumeOnTx({ failedTurnId, threadId, tx });
    });

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
        turnId:
          limited.turnIds.at(1) ?? panic("The limited chat has two turns"),
      });
      for (const { threadId } of [continued, otherFailure, alreadyReset]) {
        const refused = await read(threadId);
        expect(refused.isErr() && refused.error.status).toBe(409);
      }
    });
  });

  describe("the reminder read", () => {
    test("reads one chat's reminder with the same work however many chats wait on one", async () => {
      const later = at(HOUR_MS);
      const measureAt = async (size: number) => {
        const owner = await seedOwner();
        const waiting = async () => {
          const chat = await seedThread(owner, [
            { limitResetsAt: later, status: "failed" },
          ]);
          await remind(owner, chat.threadId, chat.firstTurnId, later);
          return chat;
        };
        const measured = await waiting();
        for (let index = 0; index < size; index += 1) {
          // db-await-in-loop: seeds the member's other waiting chats, one reminder each, before the measured read.
          await waiting();
        }
        return await chatLimitReminderScalingScenario.measure({
          database,
          organizationId: owner.organizationId,
          threadId: measured.threadId,
          userId: owner.userId,
        });
      };
      const at10 = await measureAt(10);
      const at200 = await measureAt(200);
      console.info(
        "handler-scaling",
        JSON.stringify({ name: "chat limit reminder", at10, at200 }),
      );
      expect(at10.statements).toBeGreaterThan(0);
      expect(readScalingViolations({ small: at10, large: at200 })).toEqual([]);
    });
  });

  describe("continuing a chat once its limit reset", () => {
    test("the resumed turn takes the request once, while the stopped turn is the latest, and frees the held queue", async () => {
      const owner = await seedOwner();
      const chat = await seedThread(owner, [
        { limitResetsAt: at(-60 * 1000), status: "failed" },
      ]);
      await remind(
        owner,
        chat.threadId,
        chat.firstTurnId,
        at(-60 * 1000),
        CHAT_LIMIT_RESET_ACTION.continue,
      );
      await database.insert(chatQueueHolds).values({
        organizationId: owner.organizationId,
        reason: CHAT_QUEUE_HOLD_REASON.turnFailed,
        threadId: chat.threadId,
        turnId: chat.firstTurnId,
        userId: owner.userId,
        workspaceId: null,
      });

      expect(await takeResume(chat.threadId, chat.firstTurnId)).toBe("taken");
      expect(await takeResume(chat.threadId, chat.firstTurnId)).toBe("not-due");

      expect(await remindersOf([chat.threadId])).toEqual([]);
      const holds = await database
        .select({ threadId: chatQueueHolds.threadId })
        .from(chatQueueHolds)
        .where(eq(chatQueueHolds.threadId, chat.threadId));
      expect(holds).toEqual([]);
    });

    test("a newer turn cancels it, and a request to be notified is never taken", async () => {
      const owner = await seedOwner();
      const continued = await seedThread(owner, [
        { limitResetsAt: at(-60 * 1000), status: "failed" },
        { status: "completed" },
      ]);
      const notifyOnly = await seedThread(owner, [
        { limitResetsAt: at(-60 * 1000), status: "failed" },
      ]);
      await remind(
        owner,
        continued.threadId,
        continued.firstTurnId,
        at(-60 * 1000),
        CHAT_LIMIT_RESET_ACTION.continue,
      );
      await remind(
        owner,
        notifyOnly.threadId,
        notifyOnly.firstTurnId,
        at(-60 * 1000),
      );

      expect(await takeResume(continued.threadId, continued.firstTurnId)).toBe(
        "not-due",
      );
      expect(
        await takeResume(notifyOnly.threadId, notifyOnly.firstTurnId),
      ).toBe("not-due");
      // Neither was the resume's to take; the reminder sweep settles both.
      expect(
        (await remindersOf([continued.threadId, notifyOnly.threadId])).length,
      ).toBe(2);
    });

    test("two API tasks resuming the same chat at once start one turn", async () => {
      const owner = await seedOwner();
      const chat = await seedThread(owner, [
        { limitResetsAt: at(-60 * 1000), status: "failed" },
      ]);
      await remind(
        owner,
        chat.threadId,
        chat.firstTurnId,
        at(-60 * 1000),
        CHAT_LIMIT_RESET_ACTION.continue,
      );

      const taken = await Promise.all([
        takeResume(chat.threadId, chat.firstTurnId),
        takeResume(chat.threadId, chat.firstTurnId),
      ]);

      expect(taken.toSorted(compareCodeUnit)).toEqual(["not-due", "taken"]);
    });

    test("the resumer tries a request only within its window; the reminder sweep notifies the rest", async () => {
      const owner = await seedOwner();
      const seedArmed = async (
        remindAt: Date,
        onReset: ChatLimitResetAction,
      ) => {
        const chat = await seedThread(owner, [
          { limitResetsAt: remindAt, status: "failed" },
        ]);
        await remind(owner, chat.threadId, chat.firstTurnId, remindAt, onReset);
        return chat.threadId;
      };
      const continueNow = await seedArmed(
        at(-60 * 1000),
        CHAT_LIMIT_RESET_ACTION.continue,
      );
      const continueOverdue = await seedArmed(
        at(-CHAT_LIMIT_RESUME_WINDOW_MS - 60 * 1000),
        CHAT_LIMIT_RESET_ACTION.continue,
      );
      const continueLater = await seedArmed(
        at(HOUR_MS),
        CHAT_LIMIT_RESET_ACTION.continue,
      );
      const notifyNow = await seedArmed(
        at(-60 * 1000),
        CHAT_LIMIT_RESET_ACTION.notify,
      );
      const all = [continueNow, continueOverdue, continueLater, notifyNow];

      const tried = await database.transaction(
        async (tx) =>
          await readDueChatLimitResumesOnTx({ limit: 1000, now, tx }),
      );
      expect(
        tried
          .map(({ threadId }) => threadId)
          .filter((threadId) => all.includes(threadId)),
      ).toEqual([continueNow]);

      await takeDueChatLimitReminders({ database, now });

      expect(
        (await filedFor(all))
          .flatMap(({ entityId }) => (entityId === null ? [] : [entityId]))
          .toSorted(compareCodeUnit),
      ).toEqual([continueOverdue, notifyNow].toSorted(compareCodeUnit));
      expect(
        (await remindersOf(all))
          .map(({ threadId }) => threadId)
          .toSorted(compareCodeUnit),
      ).toEqual([continueNow, continueLater].toSorted(compareCodeUnit));
    });

    test("a request that will not start notifies once, and one for a member who cannot act notifies nothing", async () => {
      const owner = await seedOwner();
      const away = await seedThread(owner, [
        { limitResetsAt: at(-60 * 1000), status: "failed" },
      ]);
      const gone = await seedThread(owner, [
        { limitResetsAt: at(-60 * 1000), status: "failed" },
      ]);
      for (const chat of [away, gone]) {
        // db-await-in-loop: two fixture rows.
        await remind(
          owner,
          chat.threadId,
          chat.firstTurnId,
          at(-60 * 1000),
          CHAT_LIMIT_RESET_ACTION.continue,
        );
      }
      const end = async (
        chat: {
          threadId: SafeId<"chatThread">;
          firstTurnId: SafeId<"chatTurn">;
        },
        how: ChatLimitResumeEnd,
      ) =>
        await database.transaction(
          async (tx) =>
            await endChatLimitResumeOnTx({
              end: how,
              threadId: chat.threadId,
              turnId: chat.firstTurnId,
              tx,
            }),
        );

      expect((await end(away, "notify")).length).toBeGreaterThan(0);
      // Once ended, a second task's end finds nothing to tell.
      expect(await end(away, "notify")).toEqual([]);
      expect(await end(gone, "discard")).toEqual([]);

      expect(await filedFor([away.threadId, gone.threadId])).toEqual([
        {
          entityId: away.threadId,
          kind: NOTIFICATION_KIND.LOCAL_RUN_LIMIT_RESET,
        },
      ]);
      expect(await remindersOf([away.threadId, gone.threadId])).toEqual([]);
    });

    test("a computer away at the reset ends the request in the notification, starting no turn", async () => {
      const owner = await seedOwner();
      const accepted = await recordAccountProfessionalUse({
        userId: owner.userId,
        source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
      });
      expect(accepted.isOk()).toBe(true);
      const chat = await seedThread(owner, [
        { limitResetsAt: at(-60 * 1000), status: "failed" },
      ]);
      await database
        .update(chatThreads)
        .set({
          chatLocalRunTarget: {
            kind: "local",
            harness: "codex",
            model: "gpt-5.5",
            approvals: "ask",
            reasoningEffort: null,
          },
        })
        .where(eq(chatThreads.id, chat.threadId));
      await remind(
        owner,
        chat.threadId,
        chat.firstTurnId,
        at(-60 * 1000),
        CHAT_LIMIT_RESET_ACTION.continue,
      );
      const routed: unknown[] = [];

      const outcome = await resumeChatAfterLimit({
        dependencies: {
          discard: discardChatLimitResume,
          now: () => now,
          routeLocalRun: async ({ target }) => {
            routed.push(target);
            return Result.ok({ type: "no_computer" });
          },
          send: async () => panic("A computer that is away gets no turn"),
          signal: new AbortController().signal,
        },
        due: {
          organizationId: owner.organizationId,
          threadId: chat.threadId,
          turnId: chat.firstTurnId,
          userId: owner.userId,
        },
      });

      expect(outcome).toEqual({ type: "ended", end: "notify" });
      // It asked for the computer the stopped turn ran on.
      expect(routed).toEqual([
        expect.objectContaining({ harness: "codex", model: "gpt-5.5" }),
      ]);
      expect(await filedFor([chat.threadId])).toEqual([
        {
          entityId: chat.threadId,
          kind: NOTIFICATION_KIND.LOCAL_RUN_LIMIT_RESET,
        },
      ]);
      expect(await remindersOf([chat.threadId])).toEqual([]);
      const turns = await database
        .select({ id: chatTurns.id })
        .from(chatTurns)
        .where(eq(chatTurns.threadId, chat.threadId));
      expect(turns).toEqual([{ id: chat.firstTurnId }]);
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
