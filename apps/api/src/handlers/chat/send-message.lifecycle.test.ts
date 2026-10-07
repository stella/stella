import { EventType, memoryStream } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatTurns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import type { AdmittedActionIdentity } from "@/api/lib/rate-limit/action-kinds";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "./chat-message-parts";
import { ChatSendLifecycle } from "./send-message";
import { createLazyExternalMcpToolsLoader } from "./tools/external-mcp-tools";

describe("send lifecycle checkpoint indexing", () => {
  test("replays retain their turn/run identity and a fresh turn can reuse an old run id", async () => {
    const identities: string[] = [];
    for (const turn of ["turn-a", "turn-b"]) {
      const db = createScopedDbMock({});
      const lifecycle = new ChatSendLifecycle({
        mode: "raw",
        indexThread: async () => undefined,
        startAdmission: async (options) => {
          expect(options.mode).toBe("concurrency-only");
          return Result.ok({
            signal: new AbortController().signal,
            release: async () => undefined,
            reservePeriod: async (
              identity: AdmittedActionIdentity,
              organizationStateDb?: ScopedDb,
            ) => {
              expect(organizationStateDb).toBe(db.scopedDb);
              expect(identity.actionKind).toBe("chat.send");
              identities.push(identity.logicalPhaseId);
              return Result.ok(undefined);
            },
          });
        },
        externalMcpToolsLoader: createLazyExternalMcpToolsLoader(async () => {
          throw new ActionAdmissionError({
            message: "Connector discovery was not expected",
            reason: "unavailable",
          });
        }),
        recordAuditEvent: async () => undefined,
        rollbackSideEffects: async () => Result.ok(undefined),
        safeDb: db.safeDb,
        scopedDb: db.scopedDb,
        threadId: toSafeId<"chatThread">("same-thread"),
        userId: toSafeId<"user">("phase_user"),
        workspaceId: null,
      });
      expect(
        Result.isOk(
          await lifecycle.admitExecution({
            organizationId: toSafeId<"organization">("phase_org"),
            checkpoint: undefined,
          }),
        ),
      ).toBe(true);
      const viewer = new AbortController();
      viewer.abort();
      expect(lifecycle.isClientConnectionAborted(viewer.signal)).toBe(true);
      lifecycle.claimTurn(
        { id: toSafeId<"chatTurn">(turn), executionId: turn },
        undefined,
      );
      expect(lifecycle.isClientConnectionAborted(viewer.signal)).toBe(false);
      for (const runId of [
        "initial",
        "initial",
        "regeneration",
        "approved-child",
      ]) {
        const outcome = await lifecycle.reserveExecutionPeriod(runId);
        expect(Result.isOk(outcome)).toBe(true);
      }
      const run = lifecycle.startRun(undefined);
      expect(lifecycle.isClientConnectionAborted(viewer.signal)).toBe(false);
      const response = run.produce(
        (async function* () {
          yield {
            type: EventType.RUN_STARTED,
            runId: "matrix-run",
            threadId: "same-thread",
            timestamp: 0,
          } as const;
          await run.settle(async () => ({ type: "not-owned" }));
        })(),
        memoryStream({ runId: Bun.randomUUIDv7() }),
      );
      await response.text();
      await lifecycle.cleanup();
    }
    expect(identities.at(0)).toBe(identities.at(1));
    expect(identities.at(4)).toBe(identities.at(5));
    expect(new Set(identities).size).toBe(6);
  });

  test("uses the injected indexer when admission loss restores before and after run handoff", async () => {
    for (const phase of ["preflight", "handed-over"] as const) {
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
                returning: async () => [
                  {
                    id: "turn_lifecycle",
                    organizationId: "organization_lifecycle",
                    runId: null,
                  },
                ],
              };
            },
          }),
        }),
      });
      const admission = new AbortController();
      const indexedThreads: string[] = [];
      const threadId = toSafeId<"chatThread">("thread_lifecycle");
      const lifecycle = new ChatSendLifecycle({
        mode: "raw",
        indexThread: async (indexedThreadId) => {
          indexedThreads.push(indexedThreadId);
        },
        startAdmission: async (options) => {
          expect(options).toMatchObject({
            mode: "concurrency-only",
            actionKind: "chat.send",
          });
          return Result.ok({
            signal: admission.signal,
            reservePeriod: async (
              identity: AdmittedActionIdentity,
              organizationStateDb?: ScopedDb,
            ) => {
              expect(organizationStateDb).toBe(db.scopedDb);
              expect(identity).toEqual({
                actionKind: "chat.send",
                logicalPhaseId: JSON.stringify([
                  "turn_lifecycle",
                  "run_lifecycle",
                ]),
              });
              return Result.ok(undefined);
            },
            release: async () => undefined,
          });
        },
        externalMcpToolsLoader: createLazyExternalMcpToolsLoader(async () => {
          throw new ActionAdmissionError({
            message: "Connector discovery was not expected",
            reason: "unavailable",
          });
        }),
        recordAuditEvent: async () => undefined,
        rollbackSideEffects: async () => Result.ok(undefined),
        safeDb: db.safeDb,
        scopedDb: db.scopedDb,
        threadId,
        userId: toSafeId<"user">("user_lifecycle"),
        workspaceId: null,
      });
      lifecycle.claimTurn(
        {
          id: toSafeId<"chatTurn">("turn_lifecycle"),
          executionId: "execution_lifecycle",
        },
        checkpoint,
      );
      const acquired = await lifecycle.admitExecution({
        organizationId: toSafeId<"organization">("organization_lifecycle"),
        checkpoint,
      });
      expect(Result.isOk(acquired)).toBe(true);
      expect(
        Result.isOk(await lifecycle.reserveExecutionPeriod("run_lifecycle")),
      ).toBe(true);
      const run =
        phase === "handed-over" ? lifecycle.startRun(undefined) : undefined;
      admission.abort(
        new ActionAdmissionError({
          message: "Admission lease lost",
          reason: "unavailable",
        }),
      );
      if (run !== undefined) {
        await run.fail("provider-error", true);
        expect(await run.settled).toBe("stored");
      }
      await lifecycle.cleanup();
      expect(indexedThreads).toEqual([threadId]);
      expect(writtenMessages).toHaveLength(1);
      expect(writtenMessages.at(0)?.["content"]).toEqual(
        chatMessageContentFromMessage(checkpoint),
      );
      expect(writtenTurns).toHaveLength(1);
      expect(writtenTurns.at(0)).toMatchObject({
        status: "awaiting-user",
        failureCode: null,
        failureRetryable: null,
      });
    }
  });
});
