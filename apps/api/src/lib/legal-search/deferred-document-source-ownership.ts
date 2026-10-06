// parser-output-unchanged: document ownership does not alter parsing.
import { Result, TaggedError } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { abortTransaction, type ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withTimeout } from "@/api/lib/with-timeout";

export class DeferredDocumentOwnershipLostError extends TaggedError(
  "DeferredDocumentOwnershipLostError",
)<{ message: string }> {}

export const isDeferredDocumentOwnershipLost = (error: unknown): boolean => {
  if (DeferredDocumentOwnershipLostError.is(error)) {
    return true;
  }
  return typeof error === "object" && error !== null && "cause" in error
    ? isDeferredDocumentOwnershipLost(error.cause)
    : false;
};

class DeferredDocumentFenceError extends TaggedError(
  "DeferredDocumentFenceError",
)<{ message: string }> {}

const ownership = Symbol("deferredDocumentSourceOwnership");

export type DeferredDocumentSourceFence = {
  readonly [ownership]: true;
  readonly sourceId: SafeId<"caseLawSource">;
  readonly scopedDb: ScopedDb;
  readonly signal: AbortSignal;
  /** The decision-merge generation this ownership started under. */
  readonly mergeEpoch: bigint;
  /** Refuses once a decision merge holds or has held the source. */
  assertOwned: () => Promise<void>;
  beforeRemoteEffect: <T>(effect: () => Promise<T>) => Promise<T>;
};

export type DeferredDocumentOwnershipRefusal =
  | { status: "busy" }
  | { status: "lost" };

type WithDeferredDocumentSourceOwnershipOptions<T> = {
  decisionId: SafeId<"caseLawDecision">;
  scopedDb: ScopedDb;
  signal?: AbortSignal;
  timeoutMs: number;
  /**
   * The generation an earlier ownership claimed the decision under; a merge
   * completed since then makes that claim's snapshot stale.
   */
  expectedMergeEpoch?: bigint;
  operation: (fence: DeferredDocumentSourceFence) => Promise<T>;
};

const liveDecisionMergeLease = sql<boolean>`
  ${eq(caseLawSources.ingestionLeasePurpose, "decision-merge")}
  AND ${caseLawSources.ingestionLeaseToken} IS NOT NULL
  AND ${caseLawSources.ingestionLeaseExpiresAt} > clock_timestamp()
`;

/**
 * All database effects validate ownership while holding the source row. The
 * epoch catches a merge that claimed and released the source between two
 * checks (during a remote effect), which a live-lease test alone cannot see.
 */
export const withDeferredDocumentSourceOwnership = async <T>({
  decisionId,
  scopedDb,
  signal,
  timeoutMs,
  expectedMergeEpoch,
  operation,
}: WithDeferredDocumentSourceOwnershipOptions<T>): Promise<
  | { status: "completed"; value: T }
  | { status: "missing" }
  | DeferredDocumentOwnershipRefusal
> => {
  signal?.throwIfAborted();
  const initial = await scopedDb(async (tx) => {
    const decision = (
      await tx
        .select({ sourceId: caseLawDecisions.sourceId })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1)
    ).at(0);
    if (decision === undefined) {
      return { status: "missing" } as const;
    }
    const source = (
      await tx
        .select({
          id: caseLawSources.id,
          mergeLease: liveDecisionMergeLease,
          mergeEpoch: caseLawSources.decisionMergeEpoch,
        })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, decision.sourceId))
        .for("update")
    ).at(0);
    if (source === undefined) {
      return { status: "missing" } as const;
    }
    return source.mergeLease
      ? ({ status: "busy" } as const)
      : ({
          status: "ready",
          sourceId: source.id,
          mergeEpoch: source.mergeEpoch,
        } as const);
  });
  if (initial.status !== "ready") {
    return initial;
  }
  if (
    expectedMergeEpoch !== undefined &&
    initial.mergeEpoch !== expectedMergeEpoch
  ) {
    return { status: "lost" };
  }
  let state: "active" | "closed" = "active";
  try {
    const result = await Result.tryPromise({
      try: async () =>
        await withTimeout(
          async (operationSignal) => {
            const assertActive = () => {
              operationSignal.throwIfAborted();
              if (state === "closed") {
                abortTransaction(
                  new DeferredDocumentFenceError({
                    message: "Document ownership is closed",
                  }),
                );
              }
            };
            const assertNoMerge = async (tx: Transaction) => {
              const owner = (
                await tx
                  .select({
                    id: caseLawSources.id,
                    mergeLease: liveDecisionMergeLease,
                    mergeEpoch: caseLawSources.decisionMergeEpoch,
                  })
                  .from(caseLawSources)
                  .where(eq(caseLawSources.id, initial.sourceId))
                  .for("update")
              ).at(0);
              if (owner === undefined) {
                abortTransaction(
                  new DeferredDocumentFenceError({
                    message: "Document source is missing",
                  }),
                );
              }
              if (owner.mergeLease || owner.mergeEpoch !== initial.mergeEpoch) {
                abortTransaction(
                  new DeferredDocumentOwnershipLostError({
                    message: "Document source entered decision merge",
                  }),
                );
              }
            };
            const fencedDb: ScopedDb = async (run) => {
              assertActive();
              return await scopedDb(async (tx) => {
                assertActive();
                await assertNoMerge(tx);
                const value = await run(tx);
                assertActive();
                await assertNoMerge(tx);
                assertActive();
                return value;
              });
            };
            const assertOwned = async () => {
              assertActive();
              await scopedDb(async (tx) => {
                await assertNoMerge(tx);
              });
            };
            const fence: DeferredDocumentSourceFence = {
              [ownership]: true,
              sourceId: initial.sourceId,
              mergeEpoch: initial.mergeEpoch,
              scopedDb: fencedDb,
              signal: operationSignal,
              assertOwned,
              beforeRemoteEffect: async (effect) => {
                await assertOwned();
                const value = await effect();
                await assertOwned();
                return value;
              },
            };
            return await operation(fence);
          },
          { label: "caseLaw.deferredDocumentOwnership", timeoutMs, signal },
        ),
      catch: (error) => error,
    });
    if (Result.isError(result)) {
      if (isDeferredDocumentOwnershipLost(result.error)) {
        return { status: "lost" };
      }
      abortTransaction(result.error);
    }
    return { status: "completed", value: result.value };
  } finally {
    state = "closed";
  }
};
