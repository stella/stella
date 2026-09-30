import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/rate-limit/action-admission";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { ChatTurnOwnership, ChatTurnRun } from "./chat-turn-run";

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
});
