/**
 * The compactor summarizes a thread for its owner under the owner's current
 * organization and matter membership, so nothing from a matter the owner can
 * no longer open reaches the model. Driven against a real (PGlite) database;
 * the model, the AI settings and the budget are fakes.
 */

import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import * as aiConfigLoader from "@/api/lib/ai-config-loader";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import * as compactionBudget from "@/api/lib/chat/compaction-budget";
import { logger } from "@/api/lib/observability/logger";
import type {
  SchedulerDb,
  SchedulerTaskContext,
} from "@/api/lib/scheduler/types";
import * as modelTransport from "@/api/lib/tanstack-ai-generate";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import {
  createChatThreadCompactor,
  OWNER_ACCESS_LOST_REASON,
} from "./chat-thread-compactor";

setDefaultTimeout(120_000);

const { testDb, ids } = await getRlsFixture();
const compactChatThreads = createChatThreadCompactor({
  database: asTestRaw<RlsDatabase<Transaction>>(testDb),
});

const originalOrganizationMember = (
  await testDb
    .select()
    .from(member)
    .where(eq(member.id, ids.memberA1org))
    .limit(1)
).at(0);
const originalMatterMembers = await testDb.query.workspaceMembers.findMany({
  where: { userId: { eq: ids.userA1 } },
});
if (!originalOrganizationMember || originalMatterMembers.length === 0) {
  panic("Compactor fixture is incomplete");
}

const SUMMARY_MARKDOWN = [
  "## Goal",
  "Continue the matter.",
  "",
  "## Constraints",
  "- None",
  "",
  "## Progress",
  "### Done",
  "- Reviewed the transcript",
  "### In Progress",
  "- None",
  "### Blocked",
  "- None",
  "",
  "## Key Decisions",
  "- None",
  "",
  "## Next Steps",
  "- Continue",
  "",
  "## Critical Context",
  "- None",
  "",
  "<read-files>",
  "</read-files>",
  "<modified-files>",
  "</modified-files>",
].join("\n");

const settingsSpy = spyOn(aiConfigLoader, "loadOrgAISettings");
const budgetSpy = spyOn(compactionBudget, "resolveChatCompactionBudget");
const modelSpy = spyOn(modelTransport, "generateTanStackTextForRole");
const logs = installRecordingLogger();
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeEach(() => {
  settingsSpy.mockReset();
  budgetSpy.mockReset();
  modelSpy.mockReset();
  logs.records.length = 0;
  settingsSpy.mockImplementation(async () =>
    Result.ok({
      orgAIConfig: null,
      promptCachingEnabled: false,
      managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
    }),
  );
  budgetSpy.mockImplementation(() => ({ preserveTokens: 1, triggerTokens: 1 }));
  modelSpy.mockImplementation(async () => SUMMARY_MARKDOWN);
});

afterEach(async () => {
  if (seededThreadIds.length > 0) {
    // Cascades to the seeded messages and checkpoints.
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
    seededThreadIds.length = 0;
  }
  await testDb
    .insert(member)
    .values(originalOrganizationMember)
    .onConflictDoNothing();
  await testDb
    .insert(workspaceMembers)
    .values(originalMatterMembers)
    .onConflictDoNothing();
});

afterAll(async () => {
  settingsSpy.mockRestore();
  budgetSpy.mockRestore();
  modelSpy.mockRestore();
  logs.restore();
  await releaseRlsFixture();
});

/** Seed a thread owned by `userA1`, due for compaction, with messages naming
 *  the thread so a test can tell which thread reached the model. */
const seedDueThread = async (
  dataWorkspaceIds: SafeId<"workspace">[],
  workspaceId: SafeId<"workspace"> | null = ids.wsA1,
): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "Compactor test thread",
    workspaceId,
    dataWorkspaceIds,
    compactionScheduledAt: new Date(Date.now() - 60_000),
  });
  seededThreadIds.push(threadId);
  const base = Date.parse("2026-03-01T00:00:00.000Z");
  await testDb.insert(chatMessages).values(
    Array.from({ length: 6 }, (_, index) => ({
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      threadId,
      userId: ids.userA1,
      workspaceId,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: {
        version: 1 as const,
        data: [{ type: "text" as const, text: `${threadId} message ${index}` }],
      },
      createdAt: new Date(base + index),
    })),
  );
  return threadId;
};

const runCompactor = async () => {
  await compactChatThreads(
    asTestRaw<SchedulerTaskContext>({
      db: asTestRaw<SchedulerDb>(testDb),
      logger,
      signal: new AbortController().signal,
    }),
  );
};

const promptsSentToModel = (): string[] =>
  modelSpy.mock.calls.flatMap(([{ prompt }]) =>
    prompt === undefined ? [] : [prompt],
  );

const readThread = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({ compactionScheduledAt: chatThreads.compactionScheduledAt })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId))
      .limit(1)
  ).at(0);

const readCheckpoints = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({ status: chatThreadCompactions.status })
    .from(chatThreadCompactions)
    .where(eq(chatThreadCompactions.threadId, threadId));

const accessLostLogs = () =>
  logs
    .at("WARN")
    .filter(
      (record) =>
        record.message === "scheduler.chat_compactor_owner_access_lost",
    );

describe("chat thread compactor", () => {
  test("a thread is compacted while its owner keeps access", async () => {
    const threadId = await seedDueThread([ids.wsA1, ids.wsA2]);

    await runCompactor();

    expect(await readCheckpoints(threadId)).toEqual([{ status: "active" }]);
    expect(
      promptsSentToModel().filter((prompt) => prompt.includes(threadId)),
    ).toHaveLength(1);
    expect(await readThread(threadId)).toEqual({
      compactionScheduledAt: null,
    });
    expect(accessLostLogs()).toEqual([]);
  });

  test("a thread is not compacted when its owner has left the organization", async () => {
    const threadId = await seedDueThread([ids.wsA1]);
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));

    await runCompactor();

    expect(await readCheckpoints(threadId)).toEqual([]);
    expect(
      promptsSentToModel().filter((prompt) => prompt.includes(threadId)),
    ).toEqual([]);
    // Settled as drained, so the claim does not select it again until the
    // owner's next send marks it due.
    expect(await readThread(threadId)).toEqual({
      compactionScheduledAt: null,
    });
    expect(accessLostLogs()).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "thread.id": threadId,
          "thread.skip_reason": OWNER_ACCESS_LOST_REASON.ORGANIZATION,
        }),
      }),
    );
  });

  test("a thread is not compacted when its owner no longer has access to one of its matters", async () => {
    const revokedThreadId = await seedDueThread([ids.wsA1, ids.wsA2]);
    const keptThreadId = await seedDueThread([ids.wsA1]);
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA2));

    await runCompactor();

    expect(await readCheckpoints(revokedThreadId)).toEqual([]);
    expect(
      promptsSentToModel().filter((prompt) => prompt.includes(revokedThreadId)),
    ).toEqual([]);
    expect(await readThread(revokedThreadId)).toEqual({
      compactionScheduledAt: null,
    });
    expect(accessLostLogs()).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "thread.id": revokedThreadId,
          "thread.skip_reason": OWNER_ACCESS_LOST_REASON.THREAD,
        }),
      }),
    );

    // A thread whose matters all stay readable still compacts in the same run.
    expect(await readCheckpoints(keptThreadId)).toEqual([{ status: "active" }]);
    expect(
      promptsSentToModel().filter((prompt) => prompt.includes(keptThreadId)),
    ).toHaveLength(1);
  });

  test("an owner removed after the access check is not compacted, even on a thread outside any matter", async () => {
    // Thread RLS checks a thread outside any matter against the organization
    // id only, so the owner's handle alone would still read it.
    const threadId = await seedDueThread([], null);
    // The settings load runs after the run's first access check and before
    // the transcript is read.
    settingsSpy.mockImplementation(async () => {
      await testDb.delete(member).where(eq(member.id, ids.memberA1org));
      return Result.ok({
        orgAIConfig: null,
        promptCachingEnabled: false,
        managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
      });
    });

    await runCompactor();

    expect(settingsSpy).toHaveBeenCalled();
    expect(modelSpy).not.toHaveBeenCalled();
    expect(await readCheckpoints(threadId)).toEqual([]);
    expect(await readThread(threadId)).toEqual({
      compactionScheduledAt: null,
    });
    expect(accessLostLogs()).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "thread.id": threadId,
          "thread.skip_reason": OWNER_ACCESS_LOST_REASON.ORGANIZATION,
        }),
      }),
    );
  });

  test("an owner removed while the summary is generated gets no checkpoint", async () => {
    const threadId = await seedDueThread([], null);
    modelSpy.mockImplementation(async () => {
      await testDb.delete(member).where(eq(member.id, ids.memberA1org));
      return SUMMARY_MARKDOWN;
    });

    await runCompactor();

    expect(
      promptsSentToModel().filter((prompt) => prompt.includes(threadId)),
    ).toHaveLength(1);
    expect(await readCheckpoints(threadId)).toEqual([]);
    expect(accessLostLogs()).toContainEqual(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "thread.id": threadId,
          "thread.skip_reason": OWNER_ACCESS_LOST_REASON.ORGANIZATION,
        }),
      }),
    );
  });
});
