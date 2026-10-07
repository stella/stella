import { memoryStream, EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { chatMessages, chatTurns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { HandlerError, TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  ActionAdmissionError,
  actionAdmissionRefusal,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import type { withTimeout } from "@/api/lib/with-timeout";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { startChatExecutionAdmission } from "./chat-execution-admission";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "./chat-message-parts";
import { ChatTurnOwnership, ChatTurnRun } from "./chat-turn-run";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createChatMessageIdMapper } from "./stream-message-identity";

describe("chat run admission follows owned settlement", () => {
  test("an initial durability write failure releases admission and unused connectors without pulling the provider", async () => {
    const admission = new AbortController();
    let releases = 0;
    let connectorCloses = 0;
    let providerCalls = 0;
    const run = new ChatTurnRun({
      admission: {
        signal: admission.signal,
        reservePeriod: async () => Result.ok(undefined),
        release: async () => {
          releases += 1;
        },
      },
      connectors: {
        close: () => {
          connectorCloses += 1;
        },
      },
      deadlineMs: 60_000,
      mode: "raw",
      heartbeat: { intervalMs: 60_000, renewEvery: 1000 },
      ownership: new ChatTurnOwnership(),
      owner: {
        indexThread: async () => {},
        execution: {
          id: toSafeId<"chatTurn">("turn_delivery_failure"),
          executionId: "execution_delivery_failure",
        },
        owningAssistantMessage: undefined,
        recordAuditEvent: async () => {},
        safeDb: createScopedDbMock({}).safeDb,
        threadId: toSafeId<"chatThread">("thread_delivery_failure"),
        userId: toSafeId<"user">("user_delivery_failure"),
        workspaceId: null,
      },
    });
    const durability = memoryStream({ runId: Bun.randomUUIDv7() });
    const source = (async function* (): AsyncIterable<StreamChunk> {
      providerCalls += 1;
      yield { type: EventType.CUSTOM, name: "unused-provider", value: {} };
    })();
    await run
      .produce(source, {
        ...durability,
        append: async () => {
          throw new HandlerError({
            status: 500,
            message: "Delivery write failed",
          });
        },
        close: async () => {
          await run.failProduction("not-started");
          await durability.close();
        },
      })
      .text();
    // The deliberately empty DB fixture cannot store the failure, but the
    // local lifecycle must still terminate and return its occupied capacity.
    expect(providerCalls).toBe(0);
    expect(connectorCloses).toBe(1);
    expect(releases).toBe(1);
    expect(await run.settled).toBe("unstored");
  });

  test("persists once and releases admission when processor finalization throws after lease loss", async () => {
    for (const exit of ["drain", "throw"] as const) {
      const admission = new AbortController();
      let releases = 0;
      let persisted = 0;
      let finalizations = 0;
      const run = new ChatTurnRun({
        admission: {
          signal: admission.signal,
          reservePeriod: async () => Result.ok(undefined),
          release: async () => {
            releases += 1;
            await Promise.resolve();
          },
        },
        connectors: undefined,
        deadlineMs: 60_000,
        mode: "raw",
        heartbeat: { intervalMs: 60_000, renewEvery: 1000 },
        ownership: new ChatTurnOwnership(),
        owner: {
          indexThread: async () => await Promise.resolve(),
          execution: {
            id: toSafeId<"chatTurn">("turn_processor_failure"),
            executionId: "execution_processor_failure",
          },
          owningAssistantMessage: undefined,
          recordAuditEvent: async () => {
            await Promise.resolve();
          },
          safeDb: createScopedDbMock({}).safeDb,
          threadId: toSafeId<"chatThread">("thread_processor_failure"),
          userId: toSafeId<"user">("user_processor_failure"),
          workspaceId: null,
        },
      });
      const { processor, message } = createStreamMessageCapture({
        initialMessages: [],
        capture: toChatMessage,
      });
      const finalize = processor.finalizeStream.bind(processor);
      processor.finalizeStream = () => {
        finalizations += 1;
        finalize();
        throw new HandlerError({
          status: 500,
          message: "Processor finalization failed",
        });
      };
      const source = async function* (): AsyncIterable<StreamChunk> {
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "assistant-1",
          role: "assistant",
        };
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "assistant-1",
          delta: "Partial answer",
        };
        admission.abort(
          new ActionAdmissionError({
            message: "Admission lease lost",
            reason: "unavailable",
          }),
        );
        if (exit === "throw") {
          throw new HandlerError({ status: 503, message: "Provider aborted" });
        }
      };
      const output = processServerChatStream({
        abortSignal: run.control.providerAbortController.signal,
        runSignal: run.control.abortController.signal,
        deadlineSignal: run.control.deadlineSignal,
        getResponseMessage: message,
        initialMessages: [],
        mapMessageId: createChatMessageIdMapper(() =>
          toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
        ),
        processor,
        source: source(),
        onFinish: async ({ outcome, responseMessage }) => {
          expect(outcome).toEqual({
            type: "failed",
            error: "provider_unavailable",
            refusal: actionAdmissionRefusal(
              new ActionAdmissionError({
                reason: "unavailable",
                message: "Admission lease lost",
              }),
            ),
          });
          expect(responseMessage.parts).toContainEqual({
            type: "text",
            content: "Partial answer",
          });
          await run.settle(async () => {
            persisted += 1;
            await Promise.resolve();
            return { type: "stored", outcome: { type: "completed" } };
          });
        },
      });
      await run
        .produce(output, memoryStream({ runId: Bun.randomUUIDv7() }))
        .text();
      expect(await run.settled).toBe("stored");
      expect(persisted).toBe(1);
      expect(releases).toBe(1);
      expect(finalizations).toBe(1);
      expect(run.control.abortController.signal.aborted).toBe(false);
    }
  });

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
        reservePeriod: async () => Result.ok(undefined),
        release: async () => {
          releases += 1;
          await Promise.resolve();
        },
      },
      connectors: undefined,
      deadlineMs: 60_000,
      mode: "raw",
      heartbeat: { intervalMs: 1, renewEvery: 1000 },
      ownership: new ChatTurnOwnership(),
      owner: {
        indexThread: async () => await Promise.resolve(),
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
        return { type: "stored", outcome: { type: "completed" } };
      });
      yield* [];
    };
    const transport = run.produce(
      output(),
      memoryStream({ runId: Bun.randomUUIDv7() }),
    );
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
        reservePeriod: async () => Result.ok(undefined),
        release: async () => {
          releaseStarted.resolve(undefined);
          await releaseMayFinish.promise;
          active -= 1;
          releases += 1;
        },
      },
      connectors: undefined,
      deadlineMs: 60_000,
      mode: "raw",
      heartbeat: { intervalMs: 60_000, renewEvery: 1000 },
      ownership: new ChatTurnOwnership(),
      owner: {
        indexThread: async () => await Promise.resolve(),
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
      initialMessages: [],
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
          return { type: "stored", outcome: { type: "completed" } };
        });
      },
      processor: new StreamProcessor(),
      source: source(),
    });
    const transport = run.produce(
      output,
      memoryStream({ runId: Bun.randomUUIDv7() }),
    );
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
          name: "web_search",
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
          name: "web_search",
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
          reservePeriod: async () => Result.ok(undefined),
          release: async () => {
            await Promise.resolve();
          },
        },
        checkpoint,
        connectors: undefined,
        deadlineMs: 60_000,
        mode: "raw",
        ownership: new ChatTurnOwnership(),
        owner: {
          indexThread: async () => await Promise.resolve(),
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
            name: "web_search",
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
            name: "web_search",
            arguments: "{}",
            approval: { id: "approval-1", needsApproval: true, approved: true },
            state: "approval-responded",
          },
        ],
      });
      const writtenMessages: Record<string, unknown>[] = [];
      const writtenTurns: Record<string, unknown>[] = [];
      const db = createScopedDbMock({
        query: {
          chatThreadCompactions: {
            findFirst: async () => await Promise.resolve(null),
          },
        },
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              if (table === chatMessages) {
                writtenMessages.push(values);
              }
              if (table === chatTurns) {
                writtenTurns.push(values);
              }
              return {
                returning: async () =>
                  await Promise.resolve([
                    {
                      id: "turn_checkpoint",
                      organizationId: "organization_checkpoint",
                      runId: null,
                    },
                  ]),
              };
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
          reservePeriod: async () => Result.ok(undefined),
          release: async () => {
            releases += 1;
            await Promise.resolve();
          },
        },
        checkpoint,
        connectors: undefined,
        deadlineMs: 60_000,
        mode: "raw",
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
          initialMessages: [],
          mapMessageId: createChatMessageIdMapper(() => checkpoint.id),
          onFinish: async ({ outcome, responseMessage }) => {
            expect(outcome.type).toBe("awaiting-user");
            expect(responseMessage.parts).toEqual(checkpoint.parts);
            await run.settle(async () => {
              discardedPersistence += 1;
              await Promise.resolve();
              return { type: "stored", outcome: { type: "completed" } };
            });
          },
          processor: new StreamProcessor(),
          source: source(),
        });
        await run
          .produce(output, memoryStream({ runId: Bun.randomUUIDv7() }))
          .text();
      }
      expect(await run.settled).toBe("stored");
      expect(discardedPersistence).toBe(0);
      expect(writtenMessages).toHaveLength(1);
      expect(writtenMessages.at(0)?.["content"]).toEqual(
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
  test("bounds a hanging upstream finalizer then releases real admission and stops renewing without losing stored settlement", async () => {
    const deadlineMs = 60_000;
    const waitStarted = Promise.withResolvers<undefined>();
    const timeoutAtBound = Promise.withResolvers<undefined>();
    const finalizerStarted = Promise.withResolvers<undefined>();
    const finalizerMayFinish = Promise.withResolvers<undefined>();
    const nextRenewalScheduled = Promise.withResolvers<undefined>();
    let now = 0;
    let scheduled: { at: number; callback: () => void } | undefined;
    let schedules = 0;
    let renewals = 0;
    let releases = 0;
    let acquisitions = 0;
    const timing = {
      now: () => now,
      schedule: (callback: () => void, delayMs: number) => {
        const entry = { at: now + delayMs, callback };
        scheduled = entry;
        schedules += 1;
        if (schedules === 2) {
          nextRenewalScheduled.resolve(undefined);
        }
        return () => {
          if (scheduled === entry) {
            scheduled = undefined;
          }
        };
      },
      firePending: () => {
        const entry = scheduled;
        if (entry === undefined) {
          return false;
        }
        scheduled = undefined;
        now = entry.at;
        entry.callback();
        return true;
      },
      hasPending: () => scheduled !== undefined,
    };
    const redis = {
      send: async (_command: string, args: string[]) => {
        const script = args.at(0) ?? panic("Admission must send a script");
        if (script.includes('redis.call("ZCARD"')) {
          acquisitions += 1;
        } else if (script.includes('redis.call("ZSCORE"')) {
          renewals += 1;
        } else if (script.includes('redis.call("ZREM"')) {
          releases += 1;
        } else {
          panic("Unexpected admission operation");
        }
        return await Promise.resolve(1);
      },
    };
    const acquired = await startChatExecutionAdmission({
      mode: "action",
      periodIdentity: {
        actionKind: "chat.send",
        logicalPhaseId: "thread:hanging",
      },
      enabled: true,
      organizationId: toSafeId<"organization">("organization_hanging"),
      userId: toSafeId<"user">("user_hanging"),
      admit: async (options) =>
        await withActionAdmission({
          ...options,
          policy: {
            organizationConcurrency: 1,
            userConcurrency: 1,
            leaseMs: 10_000,
          },
          redis,
          timing,
          createId: () => "lease_hanging",
        }),
    });
    if (Result.isError(acquired)) {
      throw acquired.error;
    }
    const admission = acquired.value;
    let persisted = 0;
    const run = new ChatTurnRun({
      admission,
      connectors: undefined,
      deadlineMs,
      mode: "raw",
      heartbeat: { intervalMs: 60_000, renewEvery: 1000 },
      ownership: new ChatTurnOwnership(),
      waitForUpstream: async <T>(
        operation: (signal: AbortSignal) => Promise<T>,
        options: Parameters<typeof withTimeout>[1],
      ): Promise<T> => {
        expect(options.timeoutMs).toBe(deadlineMs);
        const controller = new AbortController();
        const sourceClosed = operation(controller.signal);
        waitStarted.resolve(undefined);
        return await Promise.race([
          sourceClosed,
          timeoutAtBound.promise.then(() => {
            expect(now).toBe(deadlineMs);
            const error = new TimeoutError({
              message: "Upstream cleanup timed out",
              label: options.label,
              timeoutMs: options.timeoutMs,
            });
            controller.abort(error);
            throw error;
          }),
        ]);
      },
      owner: {
        indexThread: async () => await Promise.resolve(),
        execution: {
          id: toSafeId<"chatTurn">("turn_hanging"),
          executionId: "execution_hanging",
        },
        owningAssistantMessage: undefined,
        recordAuditEvent: async () => {
          await Promise.resolve();
        },
        safeDb: createScopedDbMock({}).safeDb,
        threadId: toSafeId<"chatThread">("thread_hanging"),
        userId: toSafeId<"user">("user_hanging"),
        workspaceId: null,
      },
    });
    const output = async function* (): AsyncIterable<StreamChunk> {
      try {
        await run.settle(async () => {
          persisted += 1;
          await Promise.resolve();
          return { type: "stored", outcome: { type: "completed" } };
        });
        yield* [];
      } finally {
        finalizerStarted.resolve(undefined);
        await finalizerMayFinish.promise;
      }
    };
    const consumed = run
      .produce(output(), memoryStream({ runId: Bun.randomUUIDv7() }))
      .text();
    await finalizerStarted.promise;
    await waitStarted.promise;
    expect(acquisitions).toBe(1);
    expect(persisted).toBe(1);
    expect(releases).toBe(0);
    expect(timing.firePending()).toBe(true);
    await nextRenewalScheduled.promise;
    expect(renewals).toBe(1);
    expect(releases).toBe(0);
    now = deadlineMs;
    timeoutAtBound.resolve(undefined);
    expect(await run.settled).toBe("stored");
    expect(releases).toBe(1);
    expect(timing.hasPending()).toBe(false);
    now += deadlineMs;
    expect(timing.firePending()).toBe(false);
    expect(renewals).toBe(1);
    expect(persisted).toBe(1);
    expect(admission.signal.aborted).toBe(false);
    finalizerMayFinish.resolve(undefined);
    await consumed;
    expect(await run.settled).toBe("stored");
    expect(releases).toBe(1);
  });
});
