import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { withTimeout } from "@stll/concurrency/with-timeout";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { createMockTextAdapter } from "@/api/dev/register-mock-ai";
import { planChatCompaction } from "@/api/handlers/chat/compaction";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveChatCompactionBudget } from "@/api/lib/chat/compaction-budget";
import { MANAGED_MODEL_TIER } from "@/api/lib/usage/managed-model-tier";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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
