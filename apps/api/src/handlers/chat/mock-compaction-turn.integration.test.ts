import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  agentSkills,
  chatMessages,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createMockTextAdapter } from "@/api/dev/register-mock-ai";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { planChatCompaction } from "@/api/handlers/chat/compaction";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveChatCompactionBudget } from "@/api/lib/chat/compaction-budget";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import {
  SKILL_SUMMARY_SECRET,
  skillSummaryMessage,
} from "@/api/tests/helpers/skill-summary-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { withQueryLogger } from "@/api/tests/security/test-utils";

const organizationAIConfig = {
  providers: [{ provider: "openai", apiKey: "mock-compaction-test-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-4o-mini" },
    fast: { provider: "openai", modelId: "gpt-4o-mini" },
    pdf: { provider: "openai", modelId: "gpt-4o-mini" },
    reasoning: { provider: "openai", modelId: "gpt-4o-mini" },
  },
  decision: null,
} satisfies OrgAIConfig;

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const threadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (threadIds.length > 0) {
    await testDb.delete(chatThreads).where(inArray(chatThreads.id, threadIds));
  }
  await releaseRlsFixture();
});

test("accepted matter scope is resolved once and filters historical skills before compaction", async () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const skillId = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  threadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Skill context before compaction",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    dataWorkspaceIds: [ids.wsA1],
  });
  await testDb.insert(agentSkills).values({
    id: skillId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    scope: "private",
    origin: "authored",
    slug: `summary-${Bun.randomUUIDv7()}`,
    name: "Summary fixture",
    description: "Summary boundary fixture",
    body: SKILL_SUMMARY_SECRET,
    contentHash: "a".repeat(64),
    metadata: {},
    boundWorkspaceId: ids.wsA1,
  });
  const historical = skillSummaryMessage({
    id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
    skillId,
  });
  await testDb.insert(chatMessages).values({
    id: historical.id,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    threadId,
    role: historical.role,
    content: chatMessageContentFromMessage(
      toPersistableChatMessage(historical),
    ),
  });
  const queries: string[] = [];
  const counted = withQueryLogger(testDb, {
    logQuery: (query) => {
      queries.push(query);
    },
  });
  const countedScoped = asTestRaw<ScopedDb>(
    createScopedDb(counted, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  let compactions = 0;
  const harness = createApprovalHarness({
    ids,
    organizationAIConfig,
    safeDb: toSafeDbMock(countedScoped),
    scopedDb: countedScoped,
    sources: { contextMatterIds: [ids.wsA2] },
    workspaceId: ids.wsA1,
    testDb,
    textAdapterFactory: createMockTextAdapter,
    compactMessages: async ({ messages }) => {
      compactions += 1;
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain(SKILL_SUMMARY_SECRET);
      expect(serialized).toContain("skill-unavailable");
      expect(serialized).toContain("ORDINARY OUTCOME");
      return Result.ok({ messages, notice: null });
    },
  });
  try {
    const response = await harness.sendUnchecked(
      harness.sendContext({
        message: {
          id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
          role: "user",
          parts: [{ type: "text", content: "Continue in both matters" }],
        },
        runId: `run-${Bun.randomUUIDv7()}`,
        threadId,
      }),
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      throw new TypeError("Expected the admitted chat response");
    }
    expect(response.ok).toBe(true);
    await response.text();
    expect(await harness.awaitSettledTurns(threadId)).toEqual([]);
    expect(compactions).toBe(1);
    expect(
      queries.filter((query) =>
        /^select (?:"workspaces"\.)?"client_id", (?:"workspaces"\.)?"id" from "workspaces"/u.test(
          query,
        ),
      ),
    ).toHaveLength(1);
    const stored = await testDb
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.id, historical.id));
    expect(JSON.stringify(stored)).toContain(SKILL_SUMMARY_SECRET);
  } finally {
    await harness.close();
    await testDb.delete(agentSkills).where(eq(agentSkills.id, skillId));
  }
});

// timeout: the stalled provider case exercises the production compaction deadline before the second turn can settle.
test.each(["completed", "stalled"] as const)(
  "a second mock turn settles after %s compaction",
  async (summary) => {
    let summaries = 0;
    let modelStepSummaries = 0;
    const stalledSummary = Promise.withResolvers<undefined>();
    const harness = createApprovalHarness({
      ids,
      organizationAIConfig,
      safeDb,
      scopedDb,
      testDb,
      textAdapterFactory: (modelId) => {
        const adapter = createMockTextAdapter(modelId);
        return {
          ...adapter,
          async *chatStream(options) {
            if (
              JSON.stringify(options.messages).includes(
                "Compact the earlier model-step transcript below.",
              )
            ) {
              modelStepSummaries += 1;
            }
            if (
              JSON.stringify(options.messages).includes(
                "Compact the earlier conversation transcript below.",
              )
            ) {
              summaries += 1;
              if (summary === "stalled") {
                // Ignore cancellation as an uncooperative provider can.
                await stalledSummary.promise;
              }
            }
            yield* adapter.chatStream(options);
          },
        };
      },
    });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    threadIds.push(threadId);
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      title: "Compaction turns",
      userId: ids.userA1,
      workspaceId: null,
    });
    const budget = resolveChatCompactionBudget({
      orgAIConfig: organizationAIConfig,
      organizationId: ids.orgA,
      modelTier: MANAGED_MODEL_TIER.standard,
    });
    const message = (turn: number) => ({
      id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
      role: "user" as const,
      parts: [
        {
          type: "text" as const,
          content: `Journey turn ${String(turn)}. ${"Clause ".repeat(25_000)}`,
        },
      ],
    });
    const first = message(1);
    const second = message(2);
    expect(planChatCompaction({ messages: [first], ...budget }).type).toBe(
      "none",
    );
    expect(
      planChatCompaction({ messages: [first, second], ...budget }).type,
    ).toBe("compact");
    try {
      for (const posted of [first, second]) {
        const response = await withTimeout(
          async () =>
            await harness.sendUnchecked(
              harness.sendContext({
                message: posted,
                runId: `run-${Bun.randomUUIDv7()}`,
                threadId,
              }),
            ),
          { label: "mock chat response", timeoutMs: 35_000 },
        );
        expect(response).toBeInstanceOf(Response);
        if (!(response instanceof Response)) {
          return;
        }
        expect(response.ok).toBe(true);
        const body = await withTimeout(async () => await response.text(), {
          label: "mock chat stream completion",
          timeoutMs: 35_000,
        });
        expect(body).toContain("RUN_FINISHED");
        expect(await harness.awaitSettledTurns(threadId)).toEqual([]);
      }
      expect(summaries).toBe(1);
      expect(modelStepSummaries).toBe(summary === "stalled" ? 1 : 0);
      const turns = await testDb
        .select({ status: chatTurns.status })
        .from(chatTurns)
        .where(eq(chatTurns.threadId, threadId));
      expect(turns).toEqual([{ status: "completed" }, { status: "completed" }]);
      const assistants = (await harness.readThreadMessages(threadId)).filter(
        ({ role }) => role === "assistant",
      );
      expect(assistants).toHaveLength(2);
      const notice = assistants.at(-1)?.metadata?.contextNotice;
      if (summary === "stalled") {
        expect(notice).toEqual({ type: "history-trimmed" });
      } else {
        expect(notice).toBeUndefined();
      }
    } finally {
      await harness.close();
    }
  },
  60_000,
);
