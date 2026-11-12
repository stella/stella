import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { CHAT_THREAD_PIN_STATE } from "@stll/api-contract/chat";

import { chatThreads } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import getThreads from "@/api/handlers/chat/threads/list";
import type { SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { seedChatTurns } from "@/api/tests/read-scaling/chat-active-runs";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

/** The reader's pinned chats: the page, the same at every size. */
export const PINNED_THREADS_PAGE = 10;

const SEED_EPOCH_MS = Date.parse("2026-10-01T08:00:00.000Z");

type SeedOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
  /** The reader's answered, unpinned chats beside the pinned page. */
  size: number;
};

/**
 * Seeds the reader's ten pinned, answered chats beside `size` answered chats
 * they did not pin, so the history the pinned read must not walk grows while
 * the page stays ten rows long. Every chat carries a settled answer, so each
 * row's read state is derived from a turn.
 */
export const seedChatThreadsScaling = async (
  database: TestDatabase,
  { organizationId, userId, workspaceId, size }: SeedOptions,
) => {
  const at = (index: number) => new Date(SEED_EPOCH_MS + index * 1000);
  const answered = (title: string, index: number) => ({
    createdAt: at(index),
    organizationId,
    status: "completed" as const,
    title,
    userId,
    workspaceId,
  });
  const seeded = await seedChatTurns(database, [
    ...Array.from({ length: PINNED_THREADS_PAGE }, (_, index) =>
      answered(`Pinned chat ${String(index).padStart(4, "0")}`, index),
    ),
    ...Array.from({ length: size }, (_, index) =>
      answered(`Unpinned chat ${String(index).padStart(4, "0")}`, index),
    ),
  ]);
  await database
    .update(chatThreads)
    .set({ pinnedAt: at(0) })
    .where(
      inArray(chatThreads.id, seeded.threadIds.slice(0, PINNED_THREADS_PAGE)),
    );
  return {
    cleanup: seeded.cleanup,
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
    workspaceId,
  };
};

type ChatThreadsFixture = Awaited<ReturnType<typeof seedChatThreadsScaling>>;

export const chatPinnedThreadsScalingScenario = {
  name: "chat pinned threads",
  definition: getThreads,
  measure: async (fixture: ChatThreadsFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await getThreads.handler(
        asTestRaw<Parameters<typeof getThreads.handler>[0]>({
          query: {
            limit: PINNED_THREADS_PAGE,
            pinState: CHAT_THREAD_PIN_STATE.pinned,
          },
          request: new Request("https://example.test/v1/chat/threads"),
          route: "/v1/chat/threads",
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
      if (!("workspaces" in response)) {
        return panic(
          "Chat pinned threads scaling requires a successful response",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows:
          response.global.length +
          response.workspaces.reduce(
            (count, group) => count + group.threads.length,
            0,
          ),
      };
    }),
};
