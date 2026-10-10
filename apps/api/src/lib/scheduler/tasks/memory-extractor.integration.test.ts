/**
 * The memory extractor acts for each compaction's thread owner as they stand
 * when it runs: an owner who left the organization has nothing read or
 * suggested, and an owner who left the matter gets no matter memory from it.
 * Driven against a real (PGlite) database; the model is a fake.
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
  aiMemories,
  chatMessages,
  chatThreadCompactions,
  chatThreads,
  organizationSettings,
  workspaceMembers,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import * as aiConfigLoader from "@/api/lib/ai-config-loader";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import * as compactionTranscript from "@/api/lib/memory/compaction-transcript";
import * as memoryDedup from "@/api/lib/memory/memory-dedup";
import { logger } from "@/api/lib/observability/logger";
import { createMemoryExtractorTask } from "@/api/lib/scheduler/tasks/memory-extractor";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import * as tanstackGenerate from "@/api/lib/tanstack-ai-generate";
import { seedActiveChatCompaction } from "@/api/tests/helpers/chat-compaction-checkpoint";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

setDefaultTimeout(120_000);

const { testDb, ids } = await getRlsFixture();
const database = asTestRaw<RlsDatabase<Transaction>>(testDb);
const extractMemories = createMemoryExtractorTask({ database });

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
const originalSettings = (
  await testDb
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, ids.orgA))
    .limit(1)
).at(0);
if (
  !originalOrganizationMember ||
  originalMatterMembers.length === 0 ||
  !originalSettings
) {
  panic("Memory extractor fixture is incomplete");
}

const USER_TRANSCRIPT = "Always draft memos in plain English.";
const MATTER_TRANSCRIPT = "The landlord agreed to waive the deposit.";
const PREFERENCE = "Prefers memos in plain English.";
const MATTER_FACT = "The landlord waived the deposit.";

const userThreadId = createSafeId<"chatThread">();
const matterThreadId = createSafeId<"chatThread">();
const userMessageId = createSafeId<"chatMessage">();
const matterMessageId = createSafeId<"chatMessage">();
const threadIds = [userThreadId, matterThreadId];
const messageIds = [userMessageId, matterMessageId];

const settingsSpy = spyOn(aiConfigLoader, "loadOrgAISettings");
const generateSpy = spyOn(tanstackGenerate, "generateTanStackObjectForRole");
const transcriptSpy = spyOn(compactionTranscript, "loadCompactionTranscript");
const warnSpy = spyOn(logger, "warn");
const dedupSpy = spyOn(memoryDedup, "createMemoryDedupIdentity");
const originalFeature = env.FEATURE_AI_MEMORY;

/** The model's reply, after `beforeReply` runs while the call is in flight. */
const fakeExtraction = (beforeReply?: () => Promise<void>) =>
  asTestRaw<typeof tanstackGenerate.generateTanStackObjectForRole>(async () => {
    await beforeReply?.();
    return {
      candidates: [
        { kind: "preference", content: PREFERENCE },
        { kind: "fact", content: MATTER_FACT },
      ],
    };
  });

const runExtractor = async (db: typeof testDb = testDb) => {
  await extractMemories(
    asTestRaw<SchedulerTaskContext>({
      db,
      logger,
      signal: new AbortController().signal,
    }),
  );
};

const seedThread = async ({
  messageId,
  text,
  threadId,
  workspaceId,
}: {
  messageId: SafeId<"chatMessage">;
  text: string;
  threadId: SafeId<"chatThread">;
  workspaceId: SafeId<"workspace"> | null;
}) => {
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "Memory extraction",
    workspaceId,
    dataWorkspaceIds: workspaceId === null ? [] : [workspaceId],
  });
  await testDb.insert(chatMessages).values({
    id: messageId,
    threadId,
    userId: ids.userA1,
    workspaceId,
    role: "user",
    content: { version: 1, data: [{ type: "text", text }] },
  });
  const compactionId = await seedActiveChatCompaction({
    firstKeptMessageId: messageId,
    firstSummarizedMessageId: messageId,
    lastSummarizedMessageId: messageId,
    summarizedMessageCount: 1,
    testDb,
    threadId,
  });
  return { compactionId, workspaceId };
};

const readCompactions = async () =>
  await testDb
    .select({
      threadId: chatThreadCompactions.threadId,
      memoryExtractedAt: chatThreadCompactions.memoryExtractedAt,
    })
    .from(chatThreadCompactions)
    .where(inArray(chatThreadCompactions.threadId, threadIds));

const readSuggestions = async () =>
  await testDb
    .select({
      content: aiMemories.content,
      createdBy: aiMemories.createdBy,
      scope: aiMemories.scope,
      status: aiMemories.status,
      userId: aiMemories.userId,
      workspaceId: aiMemories.workspaceId,
    })
    .from(aiMemories)
    .where(inArray(aiMemories.sourceMessageId, messageIds));

const transcriptThreads = () =>
  transcriptSpy.mock.calls.map(([options]) => options.threadId);

const accessLossWarnings = () =>
  warnSpy.mock.calls.filter(
    ([event]) => event === "scheduler.memory_extractor_owner_access_lost",
  );

beforeEach(async () => {
  env.FEATURE_AI_MEMORY = true;
  settingsSpy.mockReset();
  generateSpy.mockReset();
  transcriptSpy.mockClear();
  warnSpy.mockClear();
  dedupSpy.mockClear();
  settingsSpy.mockImplementation(async () =>
    Result.ok({
      orgAIConfig: null,
      promptCachingEnabled: false,
      managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
    }),
  );
  generateSpy.mockImplementation(fakeExtraction());

  const enabledAt = new Date(Date.now() - 60_000);
  await testDb
    .update(organizationSettings)
    .set({
      memoryExtractionEnabled: true,
      memoryExtractionEnabledAt: enabledAt,
      memoryExtractionScheduledAt: enabledAt,
    })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  const seeded = [
    await seedThread({
      messageId: userMessageId,
      text: USER_TRANSCRIPT,
      threadId: userThreadId,
      workspaceId: null,
    }),
    await seedThread({
      messageId: matterMessageId,
      text: MATTER_TRANSCRIPT,
      threadId: matterThreadId,
      workspaceId: ids.wsA1,
    }),
  ];
  for (const { compactionId, workspaceId } of seeded) {
    await testDb
      .update(chatThreadCompactions)
      .set({
        memoryExtractionOrganizationId: ids.orgA,
        memoryExtractionConsentAt: enabledAt,
        memoryExtractionDataWorkspaceIds:
          workspaceId === null ? [] : [workspaceId],
      })
      .where(eq(chatThreadCompactions.id, compactionId));
  }
});

afterEach(async () => {
  env.FEATURE_AI_MEMORY = originalFeature;
  await testDb
    .delete(aiMemories)
    .where(inArray(aiMemories.sourceMessageId, messageIds));
  await testDb
    .delete(chatThreadCompactions)
    .where(inArray(chatThreadCompactions.threadId, threadIds));
  await testDb.delete(chatMessages).where(inArray(chatMessages.id, messageIds));
  await testDb.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  await testDb
    .update(organizationSettings)
    .set({
      memoryExtractionEnabled: originalSettings.memoryExtractionEnabled,
      memoryExtractionEnabledAt: originalSettings.memoryExtractionEnabledAt,
      memoryExtractionScheduledAt: originalSettings.memoryExtractionScheduledAt,
    })
    .where(eq(organizationSettings.organizationId, ids.orgA));
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
  generateSpy.mockRestore();
  transcriptSpy.mockRestore();
  warnSpy.mockRestore();
  dedupSpy.mockRestore();
  await releaseRlsFixture();
});

describe("memory extraction for a compaction's owner", () => {
  test("suggests user and matter memories while the owner keeps access", async () => {
    await runExtractor();

    expect(new Set(transcriptThreads())).toEqual(new Set(threadIds));
    const prompts = generateSpy.mock.calls.map(([options]) => options.prompt);
    expect(prompts.some((prompt) => prompt?.includes(USER_TRANSCRIPT))).toBe(
      true,
    );
    expect(prompts.some((prompt) => prompt?.includes(MATTER_TRANSCRIPT))).toBe(
      true,
    );
    const suggestions = await readSuggestions();
    expect(suggestions).toHaveLength(2);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        {
          content: PREFERENCE,
          createdBy: ids.userA1,
          scope: "user",
          status: "suggested",
          userId: ids.userA1,
          workspaceId: null,
        },
        {
          content: MATTER_FACT,
          createdBy: ids.userA1,
          scope: "workspace",
          status: "suggested",
          userId: null,
          workspaceId: ids.wsA1,
        },
      ]),
    );
    const compactions = await readCompactions();
    expect(compactions).toHaveLength(2);
    expect(compactions.every((row) => row.memoryExtractedAt !== null)).toBe(
      true,
    );
    expect(accessLossWarnings()).toEqual([]);
  });

  test("settles without reading when the owner has left the organization", async () => {
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));

    await runExtractor();

    expect(transcriptSpy).not.toHaveBeenCalled();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(await readSuggestions()).toEqual([]);
    const compactions = await readCompactions();
    expect(compactions).toHaveLength(2);
    expect(compactions.every((row) => row.memoryExtractedAt !== null)).toBe(
      true,
    );
    expect(
      accessLossWarnings().map(
        ([, attributes]) => attributes?.["owner.access"],
      ),
    ).toEqual(["not_organization_member", "not_organization_member"]);
  });

  test("suggests no matter memory once the owner has left the matter", async () => {
    await testDb
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.id, ids.memberA1wsA1));

    await runExtractor();

    expect(transcriptThreads()).toEqual([userThreadId]);
    const prompts = generateSpy.mock.calls.map(([options]) => options.prompt);
    expect(prompts.some((prompt) => prompt?.includes(MATTER_TRANSCRIPT))).toBe(
      false,
    );
    expect(await readSuggestions()).toEqual([
      {
        content: PREFERENCE,
        createdBy: ids.userA1,
        scope: "user",
        status: "suggested",
        userId: ids.userA1,
        workspaceId: null,
      },
    ]);
    const compactions = await readCompactions();
    expect(compactions.every((row) => row.memoryExtractedAt !== null)).toBe(
      true,
    );
    expect(
      accessLossWarnings().map(
        ([, attributes]) => attributes?.["owner.access"],
      ),
    ).toEqual(["matter_access_lost"]);
  });

  test("writes nothing when the owner leaves during the model call", async () => {
    generateSpy.mockImplementation(
      fakeExtraction(async () => {
        await testDb.delete(member).where(eq(member.id, ids.memberA1org));
      }),
    );

    await runExtractor();

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(await readSuggestions()).toEqual([]);
    // Settled: the owner's access decides the outcome, so a retry would not
    // change it.
    const compactions = await readCompactions();
    expect(compactions.every((row) => row.memoryExtractedAt !== null)).toBe(
      true,
    );
    expect(
      accessLossWarnings().map(
        ([, attributes]) => attributes?.["owner.access"],
      ),
    ).toContain("not_organization_member");
  });

  test("sends nothing when the owner is removed after the run's first access check", async () => {
    // Thread RLS checks a thread outside any matter against the organization
    // id only, so the owner's handle alone would still read it. The settings
    // load runs after the first check and the transcript read, before the
    // send check.
    settingsSpy.mockImplementation(async () => {
      await testDb.delete(member).where(eq(member.id, ids.memberA1org));
      return Result.ok({
        orgAIConfig: null,
        promptCachingEnabled: false,
        managedAIResidency: DEFAULT_MANAGED_AI_RESIDENCY,
      });
    });

    await runExtractor();

    expect(settingsSpy).toHaveBeenCalled();
    expect(transcriptSpy).toHaveBeenCalled();
    expect(generateSpy).not.toHaveBeenCalled();
    expect(await readSuggestions()).toEqual([]);
  });

  test("a failure after a compaction is stamped leaves it to be offered again, and the retry writes its suggestions once", async () => {
    // The first suggestion row built fails, after the compaction's stamp and
    // before its inserts. From then on the run behaves as if its process had
    // died: no later write on the scheduler connection lands, so nothing can
    // undo a stamp that was already committed.
    let crashed = false;
    const crashingSchedulerDb = new Proxy(testDb, {
      get: (target, property, receiver) =>
        crashed && property === "update"
          ? () => {
              throw new Error("scheduler connection lost");
            }
          : Reflect.get(target, property, receiver),
    });
    dedupSpy.mockImplementationOnce(() => {
      crashed = true;
      throw new Error("injected suggestion build failure");
    });

    await runExtractor(crashingSchedulerDb);
    expect(crashed).toBe(true);

    const afterFailure = await readCompactions();
    expect(
      afterFailure.filter((row) => row.memoryExtractedAt === null),
    ).toHaveLength(1);
    const written = await readSuggestions();
    expect(written).toHaveLength(1);

    await runExtractor();

    const compactions = await readCompactions();
    expect(compactions.every((row) => row.memoryExtractedAt !== null)).toBe(
      true,
    );
    const suggestions = await readSuggestions();
    expect(suggestions).toHaveLength(2);
    expect(suggestions.map(({ content }) => content).toSorted()).toEqual(
      [MATTER_FACT, PREFERENCE].toSorted(),
    );

    // A third pass finds nothing left: each suggestion exists once.
    await runExtractor();
    expect(await readSuggestions()).toHaveLength(2);
  });
});
