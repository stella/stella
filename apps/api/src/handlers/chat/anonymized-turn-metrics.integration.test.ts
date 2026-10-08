import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import {
  CHAT_SEND_MODE,
  CHAT_TRANSPORT_ERROR_CODE,
} from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  getAwaitingUserInteractions,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  reapOwnerlessChatTurnOnTx,
  stopChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import { ChatSendLifecycle } from "@/api/handlers/chat/send-message";
import { createLazyExternalMcpToolsLoader } from "@/api/handlers/chat/tools/external-mcp-tools";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { isRecord } from "@/api/lib/type-guards";
import {
  createApprovalHarness,
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  HARNESS_CHAT_MODEL_ID,
} from "@/api/tests/helpers/chat-approval-harness";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A chat turn the anonymized boundary refuses is measured twice: the refusal
// where it was built, and the turn's failed settlement under its boundary
// mode, so the failure rate of anonymized turns can be watched in production.
// The turn runs through the real send handler and `streamChat`; only the
// anonymizer behind the boundary is replaced, by one that fails.

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterEach(() => {
  resetMetricLineSinkForTesting();
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

/** The records of `metric` among the EMF lines written. */
const recordsOf = (lines: readonly string[], metric: string) =>
  lines
    .map((line): unknown => JSON.parse(line))
    .filter(
      (record): record is Record<string, unknown> =>
        isRecord(record) && metric in record,
    );

const collectMetricLines = (): string[] => {
  const lines: string[] = [];
  setMetricLineSinkForTesting((line) => {
    lines.push(line);
  });
  return lines;
};

/** The settlement counts written, by the dimensions an alarm reads. */
const settlementsOf = (lines: readonly string[]) =>
  recordsOf(lines, "ChatTurnSettlements").map(
    ({ failure_code, mode, outcome, provider }) => ({
      failure_code,
      mode,
      outcome,
      provider,
    }),
  );

const unwrap = <T>(result: Result<T, unknown>): T =>
  Result.isOk(result) ? result.value : panic("Expected an ok result");

/** The thread's turn that is still running. */
const runningTurnOf = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(
        and(eq(chatTurns.threadId, threadId), eq(chatTurns.status, "running")),
      )
  ).at(0)?.id ?? panic("Expected a running turn");

const turnStatusesOf = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({ failureCode: chatTurns.failureCode, status: chatTurns.status })
      .from(chatTurns)
      .where(eq(chatTurns.threadId, threadId))
  ).map(({ failureCode, status }) => ({ failureCode, status }));

describe("chat turn outcome metrics", () => {
  test("a turn the anonymized boundary refuses counts the refusal and the failed turn", async () => {
    const harness = createApprovalHarness({
      boundaryAnonymizer: async () =>
        await Promise.reject(new Error("anonymizer unavailable")),
      ids,
      safeDb,
      scopedDb,
      testDb,
    });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    const lines = collectMetricLines();
    const exchanges = harness.recordThread(threadId);
    try {
      await client.sendUserMessage(Bun.randomUUIDv7(), "Hello", {
        sendMode: CHAT_SEND_MODE.anonymized,
      });
      await client.settle();

      // The fixture reaches the fault: the page shows the turn failed and
      // its row says so.
      expect(client.runtimeState().hasError).toBe(true);
      expect(exchanges).toHaveLength(1);
      const response =
        exchanges.at(0)?.response ?? panic("Expected a refusal response");
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        code: CHAT_TRANSPORT_ERROR_CODE.thirdPartyBoundaryRefusal,
        message: expect.any(String),
      });
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: "boundary-refusal", status: "failed" },
      ]);

      expect(
        recordsOf(lines, "AnonymizationRefusals").map(({ reason, site }) => ({
          reason,
          site,
        })),
      ).toEqual([{ reason: "pipeline_error", site: "text_batch" }]);
      expect(
        recordsOf(lines, "ChatTurnSettlements").map(
          ({ failure_code, mode, outcome, provider }) => ({
            failure_code,
            mode,
            outcome,
            provider,
          }),
        ),
      ).toEqual([
        {
          failure_code: "boundary-refusal",
          mode: "anonymized",
          outcome: "failed",
          // Refused before the model was resolved.
          provider: "none",
        },
      ]);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test.each([
    {
      failureCode: "provider-error",
      turn: { type: "fail-before-output", message: "Provider unavailable" },
    },
    {
      failureCode: "empty-response",
      turn: { type: "text", text: "", finishReason: "stop" },
    },
  ] as const)(
    "a $failureCode failure retains its own stored and metric code",
    async ({ failureCode, turn }) => {
      const harness = createApprovalHarness({
        ids,
        safeDb,
        scopedDb,
        testDb,
        organizationAIConfig: {
          providers: [{ provider: "openai", apiKey: "test-api-key" }],
          overrideModels: {
            chat: { provider: "openai", modelId: HARNESS_CHAT_MODEL_ID },
            fast: { provider: "openai", modelId: "gpt-5.4-nano" },
            pdf: { provider: "openai", modelId: HARNESS_CHAT_MODEL_ID },
            reasoning: { provider: "openai", modelId: HARNESS_CHAT_MODEL_ID },
          },
          decision: null,
        },
      });
      const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
      seededThreadIds.push(threadId);
      const client = await harness.openWebClient(threadId);
      const lines = collectMetricLines();
      try {
        harness.script(threadId, [turn]);
        await client.sendUserMessage(Bun.randomUUIDv7(), "Hello", {
          sendMode: CHAT_SEND_MODE.rawOverride,
        });
        await client.settle();
        expect(await turnStatusesOf(threadId)).toEqual([
          { failureCode, status: "failed" },
        ]);
        expect(recordsOf(lines, "AnonymizationRefusals")).toEqual([]);
        expect(settlementsOf(lines)).toEqual([
          {
            failure_code: failureCode,
            mode: "raw",
            outcome: "failed",
            provider: "openai",
          },
        ]);
      } finally {
        client.dispose();
        await harness.close();
      }
    },
  );

  test("a completed raw turn counts once, under its provider, with no refusal", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    const lines = collectMetricLines();
    try {
      harness.script(threadId, [
        { type: "step", text: "Hello back.", toolCalls: [] },
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Hello", {
        sendMode: CHAT_SEND_MODE.rawOverride,
      });
      await client.settle();

      expect(client.runtimeState().hasError).toBe(false);
      expect(recordsOf(lines, "AnonymizationRefusals")).toEqual([]);
      expect(
        recordsOf(lines, "ChatTurnSettlements").map(
          ({ failure_code, mode, outcome, provider }) => ({
            failure_code,
            mode,
            outcome,
            provider,
          }),
        ),
      ).toEqual([
        {
          failure_code: "none",
          mode: "raw",
          outcome: "completed",
          provider: "openai",
        },
      ]);
    } finally {
      client.dispose();
      await harness.close();
    }
  });
});

describe("a turn's settlement count", () => {
  test("admission loss during a failed settlement write preserves the pending approval checkpoint", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    const firstWriteStarted = Promise.withResolvers<undefined>();
    const firstWriteMayFail = Promise.withResolvers<undefined>();
    let lifecycle: ChatSendLifecycle | undefined;
    try {
      harness.script(threadId, [
        {
          type: "tool-call",
          toolName: APPROVAL_TOOL_NAME,
          toolCallId: "approval-race",
          arguments: approvalToolArguments("test document"),
        },
      ]);
      await client.sendUserMessage(
        Bun.randomUUIDv7(),
        "Delete the test document",
        {
          sendMode: CHAT_SEND_MODE.rawOverride,
        },
      );
      await client.settle();
      const checkpoint = toPersistableChatMessage(
        await harness.lastAssistant(threadId),
      );
      const interaction = {
        type: "approval",
        toolCallId: "approval-race",
      } as const;
      expect(getAwaitingUserInteractions(checkpoint)).toEqual([interaction]);
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: null, status: "awaiting-user" },
      ]);
      const original =
        (await testDb.query.chatMessages.findFirst({
          where: { id: { eq: checkpoint.id } },
          columns: { content: true },
        })) ?? panic("Expected the approval message");
      const execution =
        unwrap(
          await claimChatTurnForExecution({
            acceptedTurnId: null,
            continuationInteraction: interaction,
            incomingMessageId: checkpoint.id,
            incomingMessageRole: "assistant",
            organizationId: ids.orgA,
            safeDb,
            threadId,
            userId: ids.userA1,
            workspaceId: null,
          }),
        ) ?? panic("Expected the continuation to claim the awaiting turn");
      const admission = new AbortController();
      let persistenceCalls = 0;
      const flakyDb: SafeDb = async (work, retry) => {
        persistenceCalls += 1;
        if (persistenceCalls === 1) {
          firstWriteStarted.resolve(undefined);
          await firstWriteMayFail.promise;
          return Result.err(
            new DatabaseError({ message: "Transient settlement failure" }),
          );
        }
        return await safeDb(work, retry);
      };
      lifecycle = new ChatSendLifecycle({
        scopedDb,
        startAdmission: async () =>
          Result.ok({
            signal: admission.signal,
            modelAdmission: testModelAdmission(ids.orgA),
            reservePeriod: async () => Result.ok(undefined),
            release: async () => undefined,
          }),
        externalMcpToolsLoader: createLazyExternalMcpToolsLoader(async () => {
          throw new DatabaseError({ message: "No connectors expected" });
        }),
        indexThread: async () => undefined,
        mode: "raw",
        recordAuditEvent: async () => undefined,
        rollbackSideEffects: async () => Result.ok(undefined),
        safeDb: flakyDb,
        threadId,
        userId: ids.userA1,
        workspaceId: null,
      });
      lifecycle.claimTurn(execution, checkpoint);
      unwrap(
        await lifecycle.admitExecution({
          organizationId: ids.orgA,
          checkpoint,
        }),
      );
      const lines = collectMetricLines();
      const failing = lifecycle.failCurrentTurn("connector-discovery", true);
      await firstWriteStarted.promise;
      expect(admission.signal.aborted).toBe(false);
      admission.abort(
        new ActionAdmissionError({
          message: "Admission lease lost",
          reason: "unavailable",
        }),
      );
      firstWriteMayFail.resolve(undefined);
      await failing;
      expect(persistenceCalls).toBe(1);
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: null, status: "running" },
      ]);
      expect(settlementsOf(lines)).toEqual([]);

      await lifecycle.cleanup();

      expect(persistenceCalls).toBe(2);
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: null, status: "awaiting-user" },
      ]);
      const restored =
        (await testDb.query.chatMessages.findFirst({
          where: { id: { eq: checkpoint.id } },
          columns: { content: true },
        })) ?? panic("Expected the restored approval message");
      expect(restored.content).toEqual(original.content);
      expect(
        await testDb.query.chatTurns.findFirst({
          where: { id: { eq: execution.id } },
          columns: {
            assistantMessageId: true,
            failureRetryable: true,
            interactionType: true,
            interactionToolCallId: true,
          },
        }),
      ).toEqual({
        assistantMessageId: checkpoint.id,
        failureRetryable: null,
        interactionType: interaction.type,
        interactionToolCallId: interaction.toolCallId,
      });
      expect(
        getAwaitingUserInteractions(await harness.lastAssistant(threadId)),
      ).toEqual([interaction]);
      expect(harness.executions).toEqual([]);
      expect(settlementsOf(lines)).toEqual([]);
    } finally {
      firstWriteMayFail.resolve(undefined);
      await lifecycle?.cleanup();
      client.dispose();
      await harness.close();
    }
  });

  test("counts the stop that won the race, not the outcome the run proposed", async () => {
    const proposed: string[] = [];
    const harness = createApprovalHarness({
      // A stop recorded elsewhere once the stream has ended: the run never
      // sees it, and its settlement stores the stop instead of its answer.
      beforeTurnSettles: async ({ outcome, threadId }) => {
        proposed.push(outcome.type);
        const turnId = await runningTurnOf(threadId);
        unwrap(
          await safeDb(
            async (tx) => await stopChatTurnOnTx({ threadId, tx, turnId }),
          ),
        );
      },
      ids,
      safeDb,
      scopedDb,
      testDb,
    });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    const lines = collectMetricLines();
    try {
      harness.script(threadId, [
        { type: "step", text: "Hello back.", toolCalls: [] },
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Hello", {
        sendMode: CHAT_SEND_MODE.rawOverride,
      });
      await client.settle();

      // The fixture reaches the race: the run proposed its answer, and the
      // row holds the stop.
      expect(proposed).toEqual(["completed"]);
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: null, status: "cancelled" },
      ]);
      expect(settlementsOf(lines)).toEqual([
        {
          failure_code: "none",
          mode: "raw",
          outcome: "cancelled",
          provider: "openai",
        },
      ]);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test("counts nothing for a turn another owner settled first", async () => {
    const proposed: string[] = [];
    const harness = createApprovalHarness({
      // The lease lapses and the reaper settles the turn before the run
      // stores its answer.
      beforeTurnSettles: async ({ outcome, threadId }) => {
        proposed.push(outcome.type);
        await testDb
          .update(chatTurns)
          .set({
            leaseExpiresAt: sql`${chatTurns.createdAt} + interval '1 millisecond'`,
          })
          .where(eq(chatTurns.threadId, threadId));
        unwrap(
          await safeDb(
            async (tx) => await reapOwnerlessChatTurnOnTx({ threadId, tx }),
          ),
        );
      },
      ids,
      safeDb,
      scopedDb,
      testDb,
    });
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const client = await harness.openWebClient(threadId);
    const lines = collectMetricLines();
    try {
      harness.script(threadId, [
        { type: "step", text: "Hello back.", toolCalls: [] },
      ]);
      await client.sendUserMessage(Bun.randomUUIDv7(), "Hello", {
        sendMode: CHAT_SEND_MODE.rawOverride,
      });
      await client.settle();

      // The fixture reaches the race: the run proposed its answer, and the
      // reaper's outcome is what the row holds.
      expect(proposed).toEqual(["completed"]);
      expect(
        (await turnStatusesOf(threadId)).map(({ status }) => status),
      ).toEqual(["interrupted"]);
      expect(settlementsOf(lines)).toEqual([]);
    } finally {
      client.dispose();
      await harness.close();
    }
  });

  test.each([
    { code: "provider-error", retryable: false },
    { code: "boundary-refusal", retryable: true },
  ] as const)(
    "counts a preflight $code failure once, after the retry that stored it",
    async ({ code, retryable }) => {
      const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
      const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
      seededThreadIds.push(threadId);
      await testDb.insert(chatThreads).values({
        id: threadId,
        organizationId: ids.orgA,
        title: "Settlement count test",
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      });
      const acceptance = createChatTurnAcceptance({
        organizationId: ids.orgA,
        threadId,
        userId: ids.userA1,
        userMessageId,
        workspaceId: ids.wsA1,
      });
      unwrap(
        await safeDb(async (tx) => {
          await tx.insert(chatMessages).values({
            content: { data: [{ text: "Draft it", type: "text" }], version: 1 },
            id: userMessageId,
            role: "user",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          });
          await insertChatTurnAcceptanceOnTx({ acceptance, tx });
        }),
      );
      const execution =
        unwrap(
          await claimChatTurnForExecution({
            acceptedTurnId: acceptance.id,
            incomingMessageId: userMessageId,
            incomingMessageRole: "user",
            organizationId: ids.orgA,
            safeDb,
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          }),
        ) ?? panic("Expected the accepted turn to be claimed");
      // The first settlement write fails, as a dropped connection would.
      let failuresLeft = 1;
      const flakyDb: SafeDb = async (work, retry) =>
        await safeDb(async (tx) => {
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error("connection reset");
          }
          return await work(tx);
        }, retry);
      const lifecycle = new ChatSendLifecycle({
        scopedDb,
        externalMcpToolsLoader: createLazyExternalMcpToolsLoader(
          async () => await Promise.reject(new Error("No connectors expected")),
        ),
        indexThread: async () => await Promise.resolve(undefined),
        mode: "anonymized",
        recordAuditEvent: async () => await Promise.resolve(undefined),
        rollbackSideEffects: async () =>
          await Promise.resolve(Result.ok(undefined)),
        safeDb: flakyDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      });
      lifecycle.claimTurn(execution, undefined);
      const lines = collectMetricLines();

      await lifecycle.failCurrentTurn(code, retryable);
      // The fixture reaches the fault: nothing is stored or counted yet.
      expect(failuresLeft).toBe(0);
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: null, status: "running" },
      ]);
      expect(settlementsOf(lines)).toEqual([]);

      await lifecycle.cleanup();

      // The retry stored the failure, and the count matches the row.
      expect(await turnStatusesOf(threadId)).toEqual([
        { failureCode: code, status: "failed" },
      ]);
      const [storedTurn] = await testDb
        .select({ failureRetryable: chatTurns.failureRetryable })
        .from(chatTurns)
        .where(eq(chatTurns.threadId, threadId));
      expect(storedTurn?.failureRetryable).toBe(retryable);
      expect(settlementsOf(lines)).toEqual([
        {
          failure_code: code,
          mode: "anonymized",
          outcome: "failed",
          provider: "none",
        },
      ]);
    },
  );
});
