import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import type { ChatTurnInteractionType } from "@stll/api-contract/chat";

import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import listActiveChatRuns from "@/api/handlers/chat/runs/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { ChatTurnStatus } from "@/api/lib/chat/turn-status";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

/** One chat turn to seed, on a thread of its own. */
export type SeededChatTurn = {
  createdAt: Date;
  /** The start of the turn's current active span; null when it has none. */
  activeStartedAt?: Date | null | undefined;
  /** What an `awaiting-user` turn waits on; defaults to an approval. */
  interactionType?: ChatTurnInteractionType | undefined;
  organizationId: SafeId<"organization">;
  status: ChatTurnStatus;
  title: string;
  /** Defaults to `createdAt`. */
  updatedAt?: Date | undefined;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace"> | null;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * The columns each status must carry (`chat_turns_state_payload_check`), with
 * every other state column null.
 */
const statePayload = (
  status: ChatTurnStatus,
  {
    assistantMessageId,
    createdAt,
    interactionType = "approval",
  }: {
    assistantMessageId: SafeId<"chatMessage">;
    createdAt: Date;
    interactionType?: ChatTurnInteractionType | undefined;
  },
) => {
  const lease = new Date(createdAt.getTime() + HOUR_MS);
  const settledAt = new Date(createdAt.getTime() + 1000);
  switch (status) {
    case "accepted":
      return { leaseExpiresAt: lease };
    case "running":
      return { executionId: Bun.randomUUIDv7(), leaseExpiresAt: lease };
    case "awaiting-user":
      return {
        assistantMessageId,
        interactionToolCallId: "call-1",
        interactionType,
      };
    case "completed":
      return { assistantMessageId, settledAt };
    case "failed":
      return {
        assistantMessageId,
        failureCode: "provider-error" as const,
        failureRetryable: true,
        settledAt,
      };
    case "cancelled":
      return { cancellationReason: "user-stop" as const, settledAt };
    case "interrupted":
      return { interruptionReason: "owner-lost" as const, settledAt };
    default:
      status satisfies never;
      return panic(`Unhandled chat turn status: ${String(status)}`);
  }
};

/**
 * Seed each turn on its own thread, with the user message it answers and, for
 * a status that owns one, its assistant message: three statements whatever
 * the count. Returns the thread ids in input order and a cleanup.
 */
export const seedChatTurns = async (
  database: TestDatabase,
  turns: readonly SeededChatTurn[],
) => {
  const rows = turns.map((turn) => ({
    ...turn,
    assistantMessageId: createSafeId<"chatMessage">(),
    threadId: createSafeId<"chatThread">(),
    turnId: createSafeId<"chatTurn">(),
    userMessageId: createSafeId<"chatMessage">(),
  }));
  if (rows.length === 0) {
    return { threadIds: [], cleanup: async () => await Promise.resolve() };
  }
  await database.insert(chatThreads).values(
    rows.map((row) => ({
      id: row.threadId,
      organizationId: row.organizationId,
      title: row.title,
      userId: row.userId,
      workspaceId: row.workspaceId,
    })),
  );
  await database.insert(chatMessages).values(
    rows.flatMap((row) => [
      {
        content: toPersistedChatMessageContentV3({
          data: [{ content: "Draft it", type: "text" }],
        }),
        createdAt: row.createdAt,
        id: row.userMessageId,
        role: "user" as const,
        threadId: row.threadId,
        userId: row.userId,
        workspaceId: row.workspaceId,
      },
      {
        content: toPersistedChatMessageContentV3({
          data: [{ content: "Drafted", type: "text" }],
        }),
        createdAt: row.createdAt,
        id: row.assistantMessageId,
        role: "assistant" as const,
        threadId: row.threadId,
        userId: row.userId,
        workspaceId: row.workspaceId,
      },
    ]),
  );
  await database.insert(chatTurns).values(
    rows.map((row) => ({
      ...statePayload(row.status, row),
      activeStartedAt: row.activeStartedAt ?? null,
      createdAt: row.createdAt,
      id: row.turnId,
      organizationId: row.organizationId,
      status: row.status,
      threadId: row.threadId,
      updatedAt: row.updatedAt ?? row.createdAt,
      userId: row.userId,
      userMessageId: row.userMessageId,
      workspaceId: row.workspaceId,
    })),
  );
  const threadIds = rows.map((row) => row.threadId);
  return {
    threadIds,
    cleanup: async () => {
      await database
        .delete(chatThreads)
        .where(inArray(chatThreads.id, threadIds));
    },
  };
};

/** The member's unfinished runs: the page, the same at every size. */
export const ACTIVE_RUNS_PAGE = 10;

const SEED_EPOCH_MS = Date.parse("2026-10-01T08:00:00.000Z");

type SeedOptions = {
  organizationId: SafeId<"organization">;
  otherUserId: SafeId<"user">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  /** The member's settled turns, and the other member's unfinished ones. */
  size: number;
};

/**
 * Seeds the member's ten unfinished runs beside `size` settled turns of
 * theirs and `size` unfinished runs of a colleague, so the population the
 * read must not walk grows while the page stays ten rows long.
 */
export const seedChatActiveRunsScaling = async (
  database: TestDatabase,
  { organizationId, otherUserId, userId, workspaceId, size }: SeedOptions,
) => {
  const at = (index: number) => new Date(SEED_EPOCH_MS + index * 1000);
  const activeStatuses = ["accepted", "running", "awaiting-user"] as const;
  const settledStatuses = [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ] as const;
  const seeded = await seedChatTurns(database, [
    ...Array.from({ length: ACTIVE_RUNS_PAGE }, (_, index) => ({
      createdAt: at(index),
      organizationId,
      status: activeStatuses[index % activeStatuses.length] ?? "running",
      title: `Active run ${String(index).padStart(4, "0")}`,
      userId,
      workspaceId,
    })),
    ...Array.from({ length: size }, (_, index) => ({
      createdAt: at(index),
      organizationId,
      status: settledStatuses[index % settledStatuses.length] ?? "completed",
      title: `Settled run ${String(index).padStart(4, "0")}`,
      userId,
      workspaceId,
    })),
    ...Array.from({ length: size }, (_, index) => ({
      createdAt: at(index),
      organizationId,
      status: activeStatuses[index % activeStatuses.length] ?? "running",
      title: `Colleague run ${String(index).padStart(4, "0")}`,
      userId: otherUserId,
      workspaceId,
    })),
  ]);
  return {
    cleanup: seeded.cleanup,
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
    workspaceId,
  };
};

type ChatActiveRunsFixture = Awaited<
  ReturnType<typeof seedChatActiveRunsScaling>
>;

export const chatActiveRunsScalingScenario = {
  name: "chat active runs",
  definition: listActiveChatRuns,
  measure: async (fixture: ChatActiveRunsFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await listActiveChatRuns.handler(
        asTestRaw<Parameters<typeof listActiveChatRuns.handler>[0]>({
          query: { limit: ACTIVE_RUNS_PAGE },
          request: new Request("https://example.test/v1/chat/runs/active"),
          route: "/v1/chat/runs/active",
          safeDb: createSafeDb(
            fixture.database,
            [fixture.workspaceId],
            fixture.organizationId,
            fixture.userId,
          ),
          session: { activeOrganizationId: fixture.organizationId },
          user: { id: fixture.userId },
          memberRole: sessionMemberRole("member"),
        }),
      );
      if (response instanceof HttpStatusResponse || !("items" in response)) {
        return panic("Chat active runs scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.items.length,
      };
    }),
};
