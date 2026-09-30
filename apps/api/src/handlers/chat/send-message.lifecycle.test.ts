import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { chatMessages, chatTurns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "./chat-message-parts";
import { ChatSendLifecycle } from "./send-message";
import { createLazyExternalMcpToolsLoader } from "./tools/external-mcp-tools";

describe("send lifecycle checkpoint indexing", () => {
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
            name: "search",
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
        update: (table: unknown) => ({
          set: (values: Record<string, unknown>) => ({
            where: () => {
              if (table === chatMessages) {
                writtenMessages.push(values);
              }
              if (table === chatTurns) {
                writtenTurns.push(values);
              }
              return Object.assign(Promise.resolve(undefined), {
                returning: async () => [
                  {
                    id: "turn_lifecycle",
                    organizationId: "organization_lifecycle",
                    runId: null,
                  },
                ],
              });
            },
          }),
        }),
      });
      const admission = new AbortController();
      const indexedThreads: string[] = [];
      const threadId = toSafeId<"chatThread">("thread_lifecycle");
      const lifecycle = new ChatSendLifecycle({
        indexThread: async (indexedThreadId) => {
          indexedThreads.push(indexedThreadId);
        },
        startAdmission: async () =>
          Result.ok({
            signal: admission.signal,
            release: async () => undefined,
          }),
        externalMcpToolsLoader: createLazyExternalMcpToolsLoader(async () => {
          throw new ActionAdmissionError({
            message: "Connector discovery was not expected",
            reason: "unavailable",
          });
        }),
        recordAuditEvent: async () => undefined,
        rollbackSideEffects: async () => Result.ok(undefined),
        safeDb: db.safeDb,
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
      expect(writtenMessages.at(0)?.content).toEqual(
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
