import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { chatMessages, chatTurns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "./chat-message-parts";
import { ChatTurnOwnership, ChatTurnRun } from "./chat-turn-run";
import { processServerChatStream } from "./stream-chat";
import { createChatMessageIdMapper } from "./stream-message-identity";

describe("chat run admission follows owned settlement", () => {
  test("holds through provider, persistence and heartbeat completion without aborting durable ownership", async () => {
    const beatStarted = Promise.withResolvers<undefined>();
    const beatMayFinish = Promise.withResolvers<undefined>();
    const providerMayFinish = Promise.withResolvers<undefined>();
    const persistenceStarted = Promise.withResolvers<undefined>();
    const persistenceMayFinish = Promise.withResolvers<undefined>();
    const db = createScopedDbMock({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              beatStarted.resolve(undefined);
              await beatMayFinish.promise;
              return [{ cancelRequestedAt: null }];
            },
          }),
        }),
      }),
    });
    const admission = new AbortController();
    let releases = 0;
    let persisted = 0;
    const run = new ChatTurnRun({
      admission: {
        signal: admission.signal,
        release: async () => {
          releases += 1;
          await Promise.resolve();
        },
      },
      connectors: undefined,
      deadlineMs: 60_000,
      heartbeat: { intervalMs: 1, renewEvery: 1000 },
      ownership: new ChatTurnOwnership(),
      owner: {
        execution: {
          id: toSafeId<"chatTurn">("turn_admission"),
          executionId: "execution_admission",
        },
        owningAssistantMessage: undefined,
        recordAuditEvent: async () => {
          await Promise.resolve();
        },
        safeDb: db.safeDb,
        threadId: toSafeId<"chatThread">("thread_admission"),
        userId: toSafeId<"user">("user_admission"),
        workspaceId: null,
      },
    });
    const output = async function* (): AsyncIterable<StreamChunk> {
      await providerMayFinish.promise;
      await run.settle(async () => {
        persistenceStarted.resolve(undefined);
        await persistenceMayFinish.promise;
        persisted += 1;
      });
      yield* [];
    };
    const transport = run.produce(output());
    await beatStarted.promise;
    expect(releases).toBe(0);
    admission.abort(
      new ActionAdmissionError({
        message: "Admission lease lost",
        reason: "unavailable",
      }),
    );
    expect(run.control.admissionSignal?.aborted).toBe(true);
    expect(run.control.providerAbortController.signal.aborted).toBe(true);
    expect(run.control.providerAbortController.signal.reason).toBe(
      admission.signal.reason,
    );
    expect(run.control.abortController.signal.aborted).toBe(false);
    providerMayFinish.resolve(undefined);
    await persistenceStarted.promise;
    expect(releases).toBe(0);
    expect(persisted).toBe(0);
    persistenceMayFinish.resolve(undefined);
    await transport.text();
    expect(persisted).toBe(1);
    expect(releases).toBe(0);
    beatMayFinish.resolve(undefined);
    expect(await run.settled).toBe("stored");
    expect(await run.settled).toBe("stored");
    expect(releases).toBe(1);
    expect(run.control.abortController.signal.aborted).toBe(false);
  });
  test("keeps admission through upstream finalizers and releases before a detached action acquires capacity", async () => {
    const finalizerStarted = Promise.withResolvers<undefined>();
    const finalizerMayFinish = Promise.withResolvers<undefined>();
    const persistenceFinished = Promise.withResolvers<undefined>();
    const releaseStarted = Promise.withResolvers<undefined>();
    const releaseMayFinish = Promise.withResolvers<undefined>();
    const db = createScopedDbMock({});
    let active = 1;
    let followUpStarted = false;
    let followUp: Promise<void> | undefined;
    let releases = 0;
    let persisted = 0;
    const run = new ChatTurnRun({
      admission: {
        signal: new AbortController().signal,
        release: async () => {
          releaseStarted.resolve(undefined);
          await releaseMayFinish.promise;
          active -= 1;
          releases += 1;
        },
      },
      connectors: undefined,
      deadlineMs: 60_000,
      heartbeat: { intervalMs: 60_000, renewEvery: 1000 },
      ownership: new ChatTurnOwnership(),
      owner: {
        execution: {
          id: toSafeId<"chatTurn">("turn_finalizer"),
          executionId: "execution_finalizer",
        },
        owningAssistantMessage: undefined,
        recordAuditEvent: async () => {
          await Promise.resolve();
        },
        safeDb: db.safeDb,
        threadId: toSafeId<"chatThread">("thread_finalizer"),
        userId: toSafeId<"user">("user_finalizer"),
        workspaceId: null,
      },
    });
    const source = async function* (): AsyncIterable<StreamChunk> {
      try {
        yield {
          type: EventType.RUN_STARTED,
          runId: "run-1",
          threadId: "thread-1",
        };
        yield { type: EventType.RUN_ERROR, message: "Provider failed" };
      } finally {
        finalizerStarted.resolve(undefined);
        await finalizerMayFinish.promise;
      }
    };
    const output = processServerChatStream({
      abortSignal: run.control.abortController.signal,
      deadlineSignal: run.control.deadlineSignal,
      getResponseMessage: () => null,
      mapMessageId: createChatMessageIdMapper(() =>
        toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
      ),
      onFinish: async ({ outcome }) => {
        expect(outcome.type).toBe("failed");
        followUp = run.followUpAfterSettlement(async () => {
          expect(active).toBe(0);
          active += 1;
          followUpStarted = true;
          await Promise.resolve();
        });
        await run.settle(async () => {
          persisted += 1;
          persistenceFinished.resolve(undefined);
        });
      },
      processor: new StreamProcessor(),
      source: source(),
    });
    const transport = run.produce(output());
    const consumed = transport.text();
    await persistenceFinished.promise;
    await finalizerStarted.promise;
    expect(persisted).toBe(1);
    expect(releases).toBe(0);
    expect(followUpStarted).toBe(false);
    finalizerMayFinish.resolve(undefined);
    await consumed;
    await releaseStarted.promise;
    expect(followUpStarted).toBe(false);
    expect(active).toBe(1);
    releaseMayFinish.resolve(undefined);
    expect(await run.settled).toBe("stored");
    await followUp;
    expect(followUpStarted).toBe(true);
    expect(releases).toBe(1);
  });

  test("keeps the original pending checkpoint eligible only before continuation production", () => {
    const checkpoint = toPersistableChatMessage({
      id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
      metadata: {
        turnOutcome: {
          type: "awaiting-user",
          interaction: { type: "approval", toolCallId: "approval-1" },
        },
      },
      parts: [
        {
          type: "tool-call",
          id: "approval-1",
          name: "search",
          arguments: "{}",
          approval: { id: "approval-1", needsApproval: true },
          state: "approval-requested",
        },
      ],
      role: "assistant",
    });
    const accepted = toPersistableChatMessage({
      ...checkpoint,
      parts: [
        {
          type: "tool-call",
          id: "approval-1",
          name: "search",
          arguments: "{}",
          approval: { id: "approval-1", needsApproval: true, approved: true },
          state: "approval-responded",
        },
      ],
    });
    expect(accepted.parts).not.toEqual(checkpoint.parts);
    for (const production of ["not-started", "started"] as const) {
      const admission = new AbortController();
      const run = new ChatTurnRun({
        admission: {
          signal: admission.signal,
          release: async () => {
            await Promise.resolve();
          },
        },
        checkpoint,
        connectors: undefined,
        deadlineMs: 60_000,
        ownership: new ChatTurnOwnership(),
        owner: {
          execution: {
            id: toSafeId<"chatTurn">("turn_checkpoint"),
            executionId: "execution_checkpoint",
          },
          owningAssistantMessage: accepted,
          recordAuditEvent: async () => {
            await Promise.resolve();
          },
          safeDb: createScopedDbMock({}).safeDb,
          threadId: toSafeId<"chatThread">("thread_checkpoint"),
          userId: toSafeId<"user">("user_checkpoint"),
          workspaceId: null,
        },
      });
      expect(run.restorableCheckpoint).toBeUndefined();
      if (production === "started") {
        expect(run.startContinuationProduction()).toBe(true);
      }
      admission.abort(
        new ActionAdmissionError({
          message: "Admission lease lost",
          reason: "unavailable",
        }),
      );
      expect(run.startContinuationProduction()).toBe(false);
      expect(run.restorableCheckpoint).toBe(
        production === "not-started" ? checkpoint : undefined,
      );
    }
  });

  test("restores the original pending checkpoint after loss before either failure or empty-stream settlement", async () => {
    for (const exit of [
      "pre-stream-failure",
      "empty-aborted-stream",
    ] as const) {
      const checkpoint = toPersistableChatMessage({
        id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
        metadata: {
          turnOutcome: {
            type: "awaiting-user",
            interaction: { type: "approval", toolCallId: "approval-1" },
          },
        },
        parts: [
          {
            type: "tool-call",
            id: "approval-1",
            name: "search",
            arguments: "{}",
            approval: { id: "approval-1", needsApproval: true },
            state: "approval-requested",
          },
        ],
        role: "assistant",
      });
      const accepted = toPersistableChatMessage({
        ...checkpoint,
        parts: [
          {
            type: "tool-call",
            id: "approval-1",
            name: "search",
            arguments: "{}",
            approval: { id: "approval-1", needsApproval: true, approved: true },
            state: "approval-responded",
          },
        ],
      });
      const writtenMessages: Record<string, unknown>[] = [];
      const writtenTurns: Record<string, unknown>[] = [];
      const db = createScopedDbMock({
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              if (table === chatMessages) {writtenMessages.push(values);}
              if (table === chatTurns) {writtenTurns.push(values);}
              return Object.assign(Promise.resolve(undefined), {
                returning: async () =>
                  await Promise.resolve([
                    {
                      id: "turn_checkpoint",
                      organizationId: "organization_checkpoint",
                      runId: null,
                    },
                  ]),
              });
            },
          }),
        }),
      });
      const admission = new AbortController();
      let releases = 0;
      let discardedPersistence = 0;
      const run = new ChatTurnRun({
        admission: {
          signal: admission.signal,
          release: async () => {
            releases += 1;
            await Promise.resolve();
          },
        },
        checkpoint,
        connectors: undefined,
        deadlineMs: 60_000,
        heartbeat: { intervalMs: 60_000, renewEvery: 1000 },
        ownership: new ChatTurnOwnership(),
        owner: {
          execution: {
            id: toSafeId<"chatTurn">("turn_checkpoint"),
            executionId: "execution_checkpoint",
          },
          owningAssistantMessage: accepted,
          recordAuditEvent: async () => {
            await Promise.resolve();
          },
          indexThread: async () => {
            await Promise.resolve();
          },
          safeDb: db.safeDb,
          threadId: toSafeId<"chatThread">("thread_checkpoint"),
          userId: toSafeId<"user">("user_checkpoint"),
          workspaceId: null,
        },
      });
      admission.abort(
        new ActionAdmissionError({
          message: "Admission lease lost",
          reason: "unavailable",
        }),
      );
      expect(run.startContinuationProduction()).toBe(false);
      if (exit === "pre-stream-failure") {
        await run.fail("provider-error", true);
      } else {
        const source = async function* (): AsyncIterable<StreamChunk> {
          await Promise.resolve();
          yield* [];
        };
        const output = processServerChatStream({
          abortSignal: run.control.providerAbortController.signal,
          runSignal: run.control.abortController.signal,
          deadlineSignal: run.control.deadlineSignal,
          getRestorableCheckpoint: () => run.restorableCheckpoint,
          getResponseMessage: () => null,
          mapMessageId: createChatMessageIdMapper(() => checkpoint.id),
          onFinish: async ({ outcome, responseMessage }) => {
            expect(outcome.type).toBe("awaiting-user");
            expect(responseMessage?.parts).toEqual(checkpoint.parts);
            await run.settle(async () => {
              discardedPersistence += 1;
              await Promise.resolve();
            });
          },
          processor: new StreamProcessor(),
          source: source(),
        });
        await run.produce(output).text();
      }
      expect(await run.settled).toBe("stored");
      expect(discardedPersistence).toBe(0);
      expect(writtenMessages).toHaveLength(1);
      expect(writtenMessages.at(0)?.content).toEqual(
        chatMessageContentFromMessage(checkpoint),
      );
      expect(writtenTurns).toHaveLength(1);
      expect(writtenTurns.at(0)).toMatchObject({
        status: "awaiting-user",
        failureCode: null,
        failureRetryable: null,
        interactionToolCallId: "approval-1",
      });
      expect(releases).toBe(1);
    }
  });
});
