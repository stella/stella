import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, asc, countDistinct, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  chatMessages,
  chatQueuedMessages,
  chatQueueHolds,
  chatThreads,
  chatTurns,
  entityDeletionCleanupRequests,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  userFiles,
} from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import type { QueuedChatSend } from "@/api/handlers/chat/chat-schema";
import {
  CHAT_QUEUE_AFTER_TURN,
  holdChatQueueAfterTurnOnTx,
  stopChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import {
  enqueueChatMessageOnTx,
  lockOwnQueueThreadOnTx,
  moveQueuedChatMessageOnTx,
  readChatQueueOnTx,
  replaceQueuedChatMessageOnTx,
} from "@/api/handlers/chat/queue/chat-queue-store";
import type { ChatTurnOutcome } from "@/api/handlers/chat/types";
import { deleteChatFilesOnTx } from "@/api/handlers/chat/upload-files";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { withChatRunPings } from "@/api/lib/chat/chat-run-pings";
import {
  admitMemberMessageOnTx,
  holdChatQueueOnTx,
  holdDueChatQueueOnTx,
  releaseChatQueueOnTx,
  removeQueuedChatMessageOnTx,
  takeQueuedChatMessageOnTx,
} from "@/api/lib/db/chat-queue-gate";
import { sweepThreadsWithDueQueueOnTx } from "@/api/lib/db/chat-queue-system";
import { createUserFileKey } from "@/api/lib/file-key";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { chatQueueReadScalingScenario } from "@/api/tests/read-scaling/chat-queue";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

const clock = createTestClock();
const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type Owner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type TurnStatus =
  | "none"
  | "accepted"
  | "running"
  | "awaiting-user"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

const ACTIVE: ReadonlySet<TurnStatus> = new Set([
  "accepted",
  "running",
  "awaiting-user",
]);

/** A plain model of one thread's queue and its newest turn. */
type Model = {
  queue: { id: SafeId<"chatMessage">; revision: number; text: string }[];
  held: boolean;
  turn: TurnStatus;
  sent: SafeId<"chatMessage">[];
  cancelled: Set<SafeId<"chatMessage">>;
};

const sendOf = (id: SafeId<"chatMessage">, text: string): QueuedChatSend => ({
  sendMode: "anonymized",
  message: { id, role: "user", parts: [{ type: "text", content: text }] },
});

/** The model's answer to a member's new message on a thread no turn runs. */
const expectedAdmission = (model: Model) => {
  if (model.turn === "awaiting-user") {
    return "turn-awaiting-member";
  }
  return model.queue.length > 0 && !model.held ? "queued-ahead" : "admitted";
};

type TerminalOutcome = Exclude<ChatTurnOutcome["type"], "awaiting-user">;

const TERMINAL_STATUS = {
  completed: "completed",
  paused: "completed",
  cancelled: "cancelled",
  failed: "failed",
  interrupted: "interrupted",
} as const satisfies Record<TerminalOutcome, TurnStatus>;

type Operation =
  | { type: "enqueue"; text: string }
  | { type: "replace"; slot: number; stale: boolean; text: string }
  | { type: "cancel"; slot: number }
  | { type: "move"; slot: number; before: number | null }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "member-send" }
  | { type: "run" }
  | { type: "wait" }
  | { type: "answer" }
  | { type: "end"; outcome: TerminalOutcome }
  | { type: "take"; stale: boolean };

const operation: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({ type: fc.constant("enqueue"), text: fc.string() }),
  fc.record({
    type: fc.constant("replace"),
    slot: fc.nat(6),
    stale: fc.boolean(),
    text: fc.string(),
  }),
  fc.record({ type: fc.constant("cancel"), slot: fc.nat(6) }),
  fc.record({
    type: fc.constant("move"),
    slot: fc.nat(6),
    before: fc.option(fc.nat(6), { nil: null }),
  }),
  fc.record({ type: fc.constant("pause") }),
  fc.record({ type: fc.constant("resume") }),
  fc.record({ type: fc.constant("member-send") }),
  fc.record({ type: fc.constant("run") }),
  fc.record({ type: fc.constant("wait") }),
  fc.record({ type: fc.constant("answer") }),
  fc.record({
    type: fc.constant("end"),
    outcome: fc.constantFrom<TerminalOutcome>(
      "completed",
      "paused",
      "cancelled",
      "failed",
      "interrupted",
    ),
  }),
  fc.record({ type: fc.constant("take"), stale: fc.boolean() }),
);

const suite = (
  database: GatedTestDb,
  cleanUp: (step: () => Promise<void>) => void,
) => {
  const seedOwner = async (): Promise<Owner> => {
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    await database.insert(organization).values({
      createdAt: new Date(clock.now()),
      id: organizationId,
      name: "Chat queue fixture",
      slug: organizationId,
    });
    await database.insert(organizationAccessStates).values({
      organizationId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    });
    await database.insert(user).values({
      email: `${userId}@example.test`,
      id: userId,
      name: "Chat queue fixture",
    });
    await database.insert(member).values({
      createdAt: new Date(clock.now()),
      id: mintAuthProviderIdValue(),
      organizationId,
      role: "member",
      userId,
    });
    cleanUp(async () => {
      await database
        .delete(chatThreads)
        .where(eq(chatThreads.organizationId, organizationId));
      await deleteOrganizationsForTest(database, [organizationId]);
      await database.delete(user).where(eq(user.id, userId));
    });
    return { organizationId, userId };
  };

  const seedThread = async (owner: Owner): Promise<SafeId<"chatThread">> => {
    const threadId = createSafeId<"chatThread">();
    await database.insert(chatThreads).values({
      id: threadId,
      organizationId: owner.organizationId,
      title: "Chat queue fixture",
      userId: owner.userId,
      workspaceId: null,
    });
    return threadId;
  };

  const insertMessage = async ({
    id,
    owner,
    role,
    threadId,
    tx,
  }: {
    id: SafeId<"chatMessage">;
    owner: Owner;
    role: "user" | "assistant";
    threadId: SafeId<"chatThread">;
    tx: Transaction;
  }) => {
    await tx.insert(chatMessages).values({
      content: toPersistedChatMessageContentV3({
        data: [{ content: role, type: "text" }],
      }),
      id,
      role,
      threadId,
      userId: owner.userId,
      workspaceId: null,
    });
  };

  /** Accept a new turn for `messageId`; the caller made sure none is active. */
  const acceptTurnOnTx = async ({
    messageId,
    owner,
    threadId,
    tx,
  }: {
    messageId: SafeId<"chatMessage">;
    owner: Owner;
    threadId: SafeId<"chatThread">;
    tx: Transaction;
  }) => {
    await insertMessage({ id: messageId, owner, role: "user", threadId, tx });
    await tx.insert(chatTurns).values({
      id: createSafeId<"chatTurn">(),
      leaseExpiresAt: sql`now() + interval '1 minute'`,
      organizationId: owner.organizationId,
      status: "accepted",
      threadId,
      userId: owner.userId,
      userMessageId: messageId,
      workspaceId: null,
    });
  };

  const activeTurnId = async (threadId: SafeId<"chatThread">) =>
    (
      await database
        .select({ id: chatTurns.id })
        .from(chatTurns)
        .where(
          and(
            eq(chatTurns.threadId, threadId),
            inArray(chatTurns.status, ["accepted", "running", "awaiting-user"]),
          ),
        )
    ).at(0)?.id ?? panic("The model has an active turn the store lacks");

  /** Move the active turn to `status` with the payload its CHECK demands. */
  const setTurnStatus = async ({
    owner,
    status,
    threadId,
  }: {
    owner: Owner;
    status: Exclude<TurnStatus, "none" | "accepted">;
    threadId: SafeId<"chatThread">;
  }) => {
    const turnId = await activeTurnId(threadId);
    await database.transaction(async (tx) => {
      const assistantMessageId = createSafeId<"chatMessage">();
      const needsAnswer =
        status === "awaiting-user" ||
        status === "completed" ||
        status === "failed";
      if (needsAnswer) {
        await insertMessage({
          id: assistantMessageId,
          owner,
          role: "assistant",
          threadId,
          tx,
        });
      }
      const cleared = {
        assistantMessageId: null,
        cancellationReason: null,
        executionId: null,
        failureCode: null,
        failureRetryable: null,
        interactionToolCallId: null,
        interactionType: null,
        interruptionReason: null,
        leaseExpiresAt: null,
        settledAt: null,
      } as const;
      const values = (() => {
        switch (status) {
          case "running":
            return {
              ...cleared,
              executionId: Bun.randomUUIDv7(),
              leaseExpiresAt: sql<Date>`now() + interval '1 minute'`,
            };
          case "awaiting-user":
            return {
              ...cleared,
              assistantMessageId,
              interactionToolCallId: "call-1",
              interactionType: "approval" as const,
            };
          case "completed":
            return {
              ...cleared,
              assistantMessageId,
              settledAt: sql<Date>`now()`,
            };
          case "failed":
            return {
              ...cleared,
              assistantMessageId,
              failureCode: "internal" as const,
              failureRetryable: true,
              settledAt: sql<Date>`now()`,
            };
          case "cancelled":
            return {
              ...cleared,
              cancellationReason: "user-stop" as const,
              settledAt: sql<Date>`now()`,
            };
          case "interrupted":
            return {
              ...cleared,
              interruptionReason: "owner-lost" as const,
              settledAt: sql<Date>`now()`,
            };
          default:
            status satisfies never;
            return panic("Unhandled turn status");
        }
      })();
      await tx
        .update(chatTurns)
        .set({ ...values, status })
        .where(eq(chatTurns.id, turnId));
      return turnId;
    });
    return turnId;
  };

  const withLock = async <T>(
    threadId: SafeId<"chatThread">,
    owner: Owner,
    run: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    await database.transaction(async (tx) => {
      const thread = await lockOwnQueueThreadOnTx({
        organizationId: owner.organizationId,
        threadId,
        tx,
        userId: owner.userId,
      });
      if (thread === undefined) {
        return panic("The fixture thread is not locked");
      }
      return await run(tx);
    });

  /** Take the head the way acceptance does: take, then store it as sent. */
  const takeAndAccept = async ({
    id,
    owner,
    revision,
    threadId,
  }: {
    id: SafeId<"chatMessage">;
    owner: Owner;
    revision: number;
    threadId: SafeId<"chatThread">;
  }) =>
    await withLock(threadId, owner, async (tx) => {
      const taken = await takeQueuedChatMessageOnTx({
        id,
        revision,
        threadId,
        tx,
      });
      if (taken === "taken") {
        await acceptTurnOnTx({ messageId: id, owner, threadId, tx });
      }
      return taken;
    });

  const gateOpen = (model: Model) => !model.held && !ACTIVE.has(model.turn);

  const assertMatchesModel = async (
    threadId: SafeId<"chatThread">,
    model: Model,
  ) => {
    const rows = await database
      .select({
        id: chatQueuedMessages.id,
        position: chatQueuedMessages.position,
        revision: chatQueuedMessages.revision,
      })
      .from(chatQueuedMessages)
      .where(eq(chatQueuedMessages.threadId, threadId))
      .orderBy(asc(chatQueuedMessages.position));
    expect(rows).toEqual(
      model.queue.map(({ id, revision }, index) => ({
        id,
        position: index + 1,
        revision,
      })),
    );
    const holds = await database
      .select({ threadId: chatQueueHolds.threadId })
      .from(chatQueueHolds)
      .where(eq(chatQueueHolds.threadId, threadId));
    expect(holds.length).toBe(model.held ? 1 : 0);
    // A hold exists only while something is queued.
    expect(holds.length === 0 || rows.length > 0).toBe(true);
    // Every sent id is one stored message with one turn, and is not queued.
    const sentMessages = await database
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.role, "user"),
          inArray(chatMessages.id, [...model.sent, ...model.cancelled]),
        ),
      );
    expect(new Set(sentMessages.map(({ id }) => id))).toEqual(
      new Set(model.sent),
    );
    for (const id of [...model.sent, ...model.cancelled]) {
      expect(rows.some((row) => row.id === id)).toBe(false);
    }
    // At most one active turn, ever.
    const active = await database
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.threadId, threadId),
          inArray(chatTurns.status, ["accepted", "running", "awaiting-user"]),
        ),
      );
    expect(active.length).toBe(ACTIVE.has(model.turn) ? 1 : 0);
  };

  const apply = async ({
    model,
    op,
    owner,
    threadId,
  }: {
    model: Model;
    op: Operation;
    owner: Owner;
    threadId: SafeId<"chatThread">;
  }) => {
    switch (op.type) {
      case "enqueue": {
        const id = createSafeId<"chatMessage">();
        const enqueued = await withLock(
          threadId,
          owner,
          async (tx) =>
            await enqueueChatMessageOnTx({
              id,
              send: sendOf(id, op.text),
              threadId,
              tx,
              uploadedFileIds: [],
            }),
        );
        if (model.queue.length >= 20) {
          expect(enqueued.type).toBe("full");
          return;
        }
        expect(enqueued.type).toBe("queued");
        model.queue.push({ id, revision: 0, text: op.text });
        return;
      }
      case "replace": {
        const item = model.queue.at(op.slot);
        if (item === undefined) {
          return;
        }
        const replaced = await withLock(
          threadId,
          owner,
          async (tx) =>
            await replaceQueuedChatMessageOnTx({
              expectedRevision: op.stale ? item.revision + 1 : item.revision,
              id: item.id,
              send: sendOf(item.id, op.text),
              threadId,
              tx,
            }),
        );
        if (op.stale) {
          expect(replaced.type).toBe("stale");
          return;
        }
        expect(replaced.type).toBe("changed");
        item.revision += 1;
        item.text = op.text;
        return;
      }
      case "cancel": {
        const item = model.queue.at(op.slot);
        if (item === undefined) {
          return;
        }
        // A removal that read an older or newer revision leaves it queued.
        const stale = await withLock(
          threadId,
          owner,
          async (tx) =>
            await removeQueuedChatMessageOnTx({
              id: item.id,
              revision: item.revision + 1,
              threadId,
              tx,
            }),
        );
        expect(stale.type).toBe("changed");
        const removed = await withLock(
          threadId,
          owner,
          async (tx) =>
            await removeQueuedChatMessageOnTx({
              id: item.id,
              revision: item.revision,
              threadId,
              tx,
            }),
        );
        expect(removed.type).toBe("removed");
        model.queue.splice(op.slot, 1);
        model.cancelled.add(item.id);
        if (model.queue.length === 0) {
          model.held = false;
        }
        // Cancelling again is idempotent and never reads as sent.
        const again = await withLock(
          threadId,
          owner,
          async (tx) =>
            await removeQueuedChatMessageOnTx({
              id: item.id,
              revision: item.revision,
              threadId,
              tx,
            }),
        );
        expect(again.type).toBe("not-found");
        return;
      }
      case "move": {
        const item = model.queue.at(op.slot);
        const before = op.before === null ? null : model.queue.at(op.before);
        if (item === undefined || before === undefined || before === item) {
          return;
        }
        const moved = await withLock(
          threadId,
          owner,
          async (tx) =>
            await moveQueuedChatMessageOnTx({
              beforeId: before?.id ?? null,
              id: item.id,
              threadId,
              tx,
            }),
        );
        expect(moved).toBe("moved");
        const rest = model.queue.filter((queued) => queued !== item);
        const at = before === null ? rest.length : rest.indexOf(before);
        model.queue = [...rest.slice(0, at), item, ...rest.slice(at)];
        return;
      }
      case "pause":
        await withLock(threadId, owner, async (tx) => {
          await holdChatQueueOnTx({
            hold: { reason: "member" },
            threadId,
            tx,
          });
        });
        model.held = model.queue.length > 0;
        return;
      case "resume":
        await withLock(threadId, owner, async (tx) => {
          await releaseChatQueueOnTx({ threadId, tx });
        });
        model.held = false;
        return;
      case "member-send": {
        // A turn that runs refuses it before admission (`turn-running`).
        if (model.turn === "accepted" || model.turn === "running") {
          return;
        }
        // A member's new message never replaces a turn waiting on them and
        // never goes ahead of a queue nothing holds; admitted, it releases
        // a held queue, as acceptance does.
        const admission = await withLock(threadId, owner, async (tx) => {
          const admitted = await admitMemberMessageOnTx({ threadId, tx });
          if (admitted === "admitted") {
            await acceptTurnOnTx({
              messageId: createSafeId<"chatMessage">(),
              owner,
              threadId,
              tx,
            });
          }
          return admitted;
        });
        expect(admission).toBe(expectedAdmission(model));
        if (admission === "admitted") {
          model.held = false;
          model.turn = "accepted";
        }
        return;
      }
      case "run":
        if (model.turn !== "accepted") {
          return;
        }
        await setTurnStatus({ owner, status: "running", threadId });
        model.turn = "running";
        return;
      case "wait":
        if (model.turn !== "running") {
          return;
        }
        await setTurnStatus({ owner, status: "awaiting-user", threadId });
        model.turn = "awaiting-user";
        return;
      case "answer":
        if (model.turn !== "awaiting-user") {
          return;
        }
        await setTurnStatus({ owner, status: "running", threadId });
        model.turn = "running";
        return;
      case "end": {
        if (model.turn !== "running") {
          return;
        }
        const turnId = await setTurnStatus({
          owner,
          status: TERMINAL_STATUS[op.outcome],
          threadId,
        });
        await withLock(threadId, owner, async (tx) => {
          await holdChatQueueAfterTurnOnTx({
            outcome: op.outcome,
            threadId,
            turnId,
            tx,
          });
        });
        model.turn = TERMINAL_STATUS[op.outcome];
        if (
          CHAT_QUEUE_AFTER_TURN[op.outcome].type === "hold" &&
          model.queue.length > 0
        ) {
          model.held = true;
        }
        return;
      }
      case "take": {
        const head = model.queue.at(0);
        if (head === undefined) {
          return;
        }
        const revision = op.stale ? head.revision + 1 : head.revision;
        // Two senders race for the same head; acceptance takes it once.
        const outcomes = await Promise.all([
          takeAndAccept({ id: head.id, owner, revision, threadId }),
          takeAndAccept({ id: head.id, owner, revision, threadId }),
        ]);
        const taken = outcomes.filter((outcome) => outcome === "taken").length;
        if (op.stale || !gateOpen(model)) {
          expect(taken).toBe(0);
          return;
        }
        expect(taken).toBe(1);
        model.queue.shift();
        model.sent.push(head.id);
        model.turn = "accepted";
        if (model.queue.length === 0) {
          model.held = false;
        }
        return;
      }
      default:
        op satisfies never;
        panic("Unhandled queue operation");
    }
  };

  describe("chat queue (postgres)", () => {
    // timeout: 25 generated runs of up to 40 database steps, with two concurrent takes per step.
    test("chat-queue-exactly-once", async () => {
      const owner = await seedOwner();
      await assertProperty(
        "chat-queue-exactly-once",
        fc.asyncProperty(
          fc.array(operation, { minLength: 5, maxLength: 40 }),
          async (operations) => {
            const threadId = await seedThread(owner);
            const model: Model = {
              queue: [],
              held: false,
              turn: "none",
              sent: [],
              cancelled: new Set(),
            };
            for (const op of operations) {
              // db-await-in-loop: each step is checked against the model before the next
              await apply({ model, op, owner, threadId });
              // db-await-in-loop: each step is checked against the model before the next
              await assertMatchesModel(threadId, model);
            }
            const read = await withLock(
              threadId,
              owner,
              async (tx) => await readChatQueueOnTx({ threadId, tx }),
            );
            expect(
              read.items.map(({ id, preview }) => ({ id, preview })),
            ).toEqual(
              model.queue.map(({ id, text }) => ({ id, preview: text.trim() })),
            );
          },
        ),
        { numRuns: 25 },
      );
    }, 180_000);

    test("a waiting turn keeps the queue until Send now ends it", async () => {
      const owner = await seedOwner();
      const threadId = await seedThread(owner);
      const id = createSafeId<"chatMessage">();
      await withLock(threadId, owner, async (tx) => {
        await enqueueChatMessageOnTx({
          id,
          send: sendOf(id, "next"),
          threadId,
          tx,
          uploadedFileIds: [],
        });
        await acceptTurnOnTx({
          messageId: createSafeId<"chatMessage">(),
          owner,
          threadId,
          tx,
        });
      });
      await setTurnStatus({ owner, status: "running", threadId });
      const turnId = await setTurnStatus({
        owner,
        status: "awaiting-user",
        threadId,
      });
      expect(await takeAndAccept({ id, owner, revision: 0, threadId })).toBe(
        "not-due",
      );
      // Send now ends the wait in its own transaction, so the message is due
      // to whichever sender comes next, ring or sweep.
      await withChatRunPings(
        async (pings) =>
          await withLock(threadId, owner, async (tx) => {
            await stopChatTurnOnTx({ pings, threadId, tx, turnId });
          }),
      );
      expect(await takeAndAccept({ id, owner, revision: 0, threadId })).toBe(
        "taken",
      );
    });

    test("a refusal the sender met outside the lock holds only a head still due", async () => {
      const owner = await seedOwner();
      const threadId = await seedThread(owner);
      const id = createSafeId<"chatMessage">();
      await withLock(threadId, owner, async (tx) => {
        await enqueueChatMessageOnTx({
          id,
          send: sendOf(id, "next"),
          threadId,
          tx,
          uploadedFileIds: [],
        });
      });
      const holdAway = async (revision: number) =>
        await database.transaction(
          async (tx) =>
            await holdDueChatQueueOnTx({
              head: { id, revision },
              hold: { reason: "computer-away" },
              threadId,
              tx,
            }),
        );
      const holdReason = async () =>
        (
          await database
            .select({ reason: chatQueueHolds.reason })
            .from(chatQueueHolds)
            .where(eq(chatQueueHolds.threadId, threadId))
        ).at(0)?.reason;
      // The member paused after the sender read the head: the pause stands.
      await withLock(threadId, owner, async (tx) => {
        await holdChatQueueOnTx({ hold: { reason: "member" }, threadId, tx });
      });
      expect(await holdAway(0)).toBe("not-due");
      expect(await holdReason()).toBe("member");
      // The member edited it since: the refusal was about an older body.
      await withLock(threadId, owner, async (tx) => {
        await releaseChatQueueOnTx({ threadId, tx });
        await replaceQueuedChatMessageOnTx({
          expectedRevision: 0,
          id,
          send: sendOf(id, "edited"),
          threadId,
          tx,
        });
      });
      expect(await holdAway(0)).toBe("not-due");
      expect(await holdReason()).toBeUndefined();
      expect(await holdAway(1)).toBe("held");
      expect(await holdReason()).toBe("computer-away");
    });

    test("reading a chat's queue costs the same however many chats have messages waiting", async () => {
      const owner = await seedOwner();
      const queueIn = async (threadId: SafeId<"chatThread">) => {
        const id = createSafeId<"chatMessage">();
        await withLock(threadId, owner, async (tx) => {
          await enqueueChatMessageOnTx({
            id,
            send: sendOf(id, "waiting"),
            threadId,
            tx,
            uploadedFileIds: [],
          });
        });
      };
      const measureAt = async (others: number) => {
        const threadId = await seedThread(owner);
        await queueIn(threadId);
        for (let index = 0; index < others; index += 1) {
          // db-await-in-loop: seeds the member's other chats with a waiting message before the measured read.
          await queueIn(await seedThread(owner));
        }
        return await chatQueueReadScalingScenario.measure({
          database,
          organizationId: owner.organizationId,
          threadId,
          userId: owner.userId,
        });
      };
      const at10 = await measureAt(10);
      const at200 = await measureAt(200);
      console.info(
        "handler-scaling",
        JSON.stringify({ name: "chat queue read", at10, at200 }),
      );
      expect(at10.statements).toBeGreaterThan(0);
      expect(readScalingViolations({ small: at10, large: at200 })).toEqual([]);
    });

    test("removing a queued message deletes the files its enqueue stored, and only those", async () => {
      const owner = await seedOwner();
      const threadId = await seedThread(owner);
      const seedFile = async () => {
        const id = createSafeId<"userFile">();
        await database.insert(userFiles).values({
          fileName: "lease.pdf",
          id,
          mimeType: "application/pdf",
          s3Key: createUserFileKey({
            fileId: id,
            mimeType: "application/pdf",
            organizationId: owner.organizationId,
          }),
          sha256Hex: "0".repeat(64),
          sizeBytes: 1,
          threadId,
          userId: owner.userId,
        });
        return id;
      };
      // One file the enqueue stored, one stored before (a sent message's).
      const stored = await seedFile();
      const earlier = await seedFile();
      const queuedId = createSafeId<"chatMessage">();
      await withLock(threadId, owner, async (tx) => {
        await enqueueChatMessageOnTx({
          id: queuedId,
          send: sendOf(queuedId, "with files"),
          threadId,
          tx,
          uploadedFileIds: [stored],
        });
      });
      const deletion = await withLock(threadId, owner, async (tx) => {
        const removed = await removeQueuedChatMessageOnTx({
          id: queuedId,
          threadId,
          tx,
        });
        if (removed.type !== "removed") {
          return panic("The queued message was not removed");
        }
        expect(removed.uploadedFileIds).toEqual([stored]);
        return await deleteChatFilesOnTx({
          fileIds: removed.uploadedFileIds,
          organizationId: owner.organizationId,
          recordAuditEvent: async () => undefined,
          threadId,
          tx,
          userId: owner.userId,
          workspaceId: null,
        });
      });
      const left = await database
        .select({ id: userFiles.id })
        .from(userFiles)
        .where(eq(userFiles.threadId, threadId));
      expect(left.map(({ id }) => id)).toEqual([earlier]);
      // The thread holds no legal hold, so the stored file was deleted.
      const cleanup =
        deletion.type === "deleted"
          ? deletion.cleanup
          : panic("The thread holds no legal hold, yet nothing was deleted");
      expect(cleanup).toHaveLength(1);
      const [request] = await database
        .select({ s3Keys: entityDeletionCleanupRequests.s3Keys })
        .from(entityDeletionCleanupRequests)
        .where(inArray(entityDeletionCleanupRequests.id, cleanup));
      expect(request?.s3Keys).toEqual([
        createUserFileKey({
          fileId: stored,
          mimeType: "application/pdf",
          organizationId: owner.organizationId,
        }),
      ]);
      // A thread's chat files hold its deletion back (RESTRICT): the
      // fixture's own cleanup removes the thread after them.
      await database.delete(userFiles).where(eq(userFiles.threadId, threadId));
    });

    test("a bounded sweep reaches every due queue in turn", async () => {
      const owner = await seedOwner();
      const threads = [await seedThread(owner), await seedThread(owner)];
      for (const threadId of threads) {
        const id = createSafeId<"chatMessage">();
        // db-await-in-loop: two fixture threads
        await withLock(threadId, owner, async (tx) => {
          await enqueueChatMessageOnTx({
            id,
            send: sendOf(id, "next"),
            threadId,
            tx,
            uploadedFileIds: [],
          });
        });
      }
      const sweepOne = async () =>
        (
          await database.transaction(
            async (tx) => await sweepThreadsWithDueQueueOnTx({ limit: 1, tx }),
          )
        ).filter((threadId) => threads.includes(threadId));
      // Other queues may share the database: within as many sweeps as there
      // are queues, both of this test's threads come up, neither twice.
      const [{ queues } = { queues: 0 }] = await database
        .select({ queues: countDistinct(chatQueuedMessages.threadId) })
        .from(chatQueuedMessages);
      const seen: SafeId<"chatThread">[] = [];
      for (let sweep = 0; sweep < queues && seen.length < 2; sweep += 1) {
        // db-await-in-loop: each sweep orders the next one
        const [picked] = await sweepOne();
        if (picked !== undefined) {
          expect(seen).not.toContain(picked);
          seen.push(picked);
        }
      }
      expect(new Set(seen)).toEqual(new Set(threads));
    });
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("chat queue (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  const { cleanUp, db } = openGatedTestDatabase(databaseUrl, { max: 4 });
  suite(db, cleanUp);
}
