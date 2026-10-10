import { Result, TaggedError } from "better-result";
import { sql, type SQL } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { withExecutorSavepoint } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";
import { isRecord } from "@/api/lib/type-guards";

type Executor = { execute: (query: SQL) => Promise<unknown> };

export type DecisionWriteExtensionOutcome =
  | { type: "applied" }
  | { type: "deferred"; reason: "unavailable" | "deadline" | "failed" };

export type DecisionWriteExtension = (context: {
  tx: Executor;
  decisionId: SafeId<"caseLawDecision">;
  payload: (CorpusPayload & { contentHash: string }) | undefined;
  signal: AbortSignal;
}) => Promise<DecisionWriteExtensionOutcome>;

class DecisionWriteExtensionError extends TaggedError(
  "DecisionWriteExtensionError",
)<{ message: string }> {}

const DEFAULT_DEADLINE_MS = 1000;
const MAX_DEADLINE_MS = 10_000;

const milliseconds = (value: unknown): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) {
    return abortTransaction(
      new DecisionWriteExtensionError({
        message: "Invalid transaction deadline setting",
      }),
    );
  }
  return numeric;
};

/** The executor is revoked before the savepoint is released or rolled back. */
export const runDecisionWriteExtension = async (
  tx: Executor,
  decisionId: SafeId<"caseLawDecision">,
  {
    payload,
    extension,
    deadlineMs = DEFAULT_DEADLINE_MS,
    signal,
  }: {
    payload?: CorpusPayload & { contentHash: string };
    extension?: DecisionWriteExtension;
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<DecisionWriteExtensionOutcome> => {
  signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_DEADLINE_MS
  ) {
    return abortTransaction(
      new DecisionWriteExtensionError({
        message: "Invalid decision write deadline",
      }),
    );
  }
  if (extension === undefined) {
    return { type: "deferred", reason: "unavailable" };
  }
  const settings = executedRows(
    await tx.execute(sql`SELECT
      current_setting('statement_timeout') AS statement_timeout,
      current_setting('lock_timeout') AS lock_timeout,
      extract(epoch FROM current_setting('statement_timeout')::interval) * 1000 AS statement_ms,
      extract(epoch FROM current_setting('lock_timeout')::interval) * 1000 AS lock_ms`),
  ).at(0);
  if (
    !isRecord(settings) ||
    typeof settings["statement_timeout"] !== "string" ||
    typeof settings["lock_timeout"] !== "string"
  ) {
    return abortTransaction(
      new DecisionWriteExtensionError({
        message: "Missing transaction deadline settings",
      }),
    );
  }
  const statementTimeout = settings["statement_timeout"];
  const lockTimeout = settings["lock_timeout"];
  const statementMs = milliseconds(settings["statement_ms"]);
  const lockMs = milliseconds(settings["lock_ms"]);
  const outcome = await withExecutorSavepoint(tx, async () => {
    const controller = new AbortController();
    const extensionSignal =
      signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, signal]);
    const deadline = performance.now() + deadlineMs;
    let accepting = true;
    let tail = Promise.resolve();
    const operations: Promise<unknown>[] = [];
    const executor: Executor = {
      execute: async (query) => {
        const operation = tail.then(async () => {
          if (!accepting) {
            return abortTransaction(
              new DecisionWriteExtensionError({
                message: "Decision write executor is closed",
              }),
            );
          }
          extensionSignal.throwIfAborted();
          const remaining = Math.ceil(deadline - performance.now());
          if (remaining <= 0) {
            return abortTransaction(
              new DecisionWriteExtensionError({
                message: "Decision write deadline expired",
              }),
            );
          }
          const statementBound =
            statementMs === 0 ? remaining : Math.min(statementMs, remaining);
          const lockBound =
            lockMs === 0 ? remaining : Math.min(lockMs, remaining);
          await tx.execute(sql`SELECT
          set_config('statement_timeout', ${String(statementBound)}, true),
          set_config('lock_timeout', ${String(lockBound)}, true)`);
          extensionSignal.throwIfAborted();
          return await tx.execute(query);
        });
        operations.push(operation);
        tail = operation.then(
          () => undefined,
          () => undefined,
        );
        return await operation;
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<DecisionWriteExtensionOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ type: "deferred", reason: "deadline" });
      }, deadlineMs);
    });
    const attempted = Result.tryPromise({
      try: async () =>
        await extension({
          tx: executor,
          decisionId,
          payload,
          signal: extensionSignal,
        }),
      catch: (cause) => cause,
    }).then((result): DecisionWriteExtensionOutcome => {
      if (result.isErr()) {
        return { type: "deferred", reason: "failed" };
      }
      return result.value;
    });
    const result = await Promise.race([attempted, expired]);
    accepting = false;
    clearTimeout(timer);
    controller.abort();
    // A timed-out callback may finish later, but cannot issue another statement.
    const settled = await Promise.allSettled(operations);
    let completed = result;
    if (
      result.type === "applied" &&
      settled.some((operation) => operation.status === "rejected")
    ) {
      completed = { type: "deferred", reason: "failed" };
    }
    return {
      type: completed.type === "applied" ? "commit" : "rollback",
      value: completed,
    };
  });
  if (outcome.isErr()) {
    return abortTransaction(outcome.error.cause);
  }
  await tx.execute(sql`SELECT
    set_config('statement_timeout', ${statementTimeout}, true),
    set_config('lock_timeout', ${lockTimeout}, true)`);
  signal?.throwIfAborted();
  return outcome.value;
};
