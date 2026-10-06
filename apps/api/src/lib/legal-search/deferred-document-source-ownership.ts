// parser-output-unchanged: document ownership does not alter parsing.
import { Result, TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";

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
  operation: (fence: DeferredDocumentSourceFence) => Promise<T>;
};

const liveDecisionMergeLease = sql<boolean>`
  ${eq(caseLawSources.ingestionLeasePurpose, "decision-merge")}
  AND ${caseLawSources.ingestionLeaseToken} IS NOT NULL
  AND ${caseLawSources.ingestionLeaseExpiresAt} > clock_timestamp()
`;

/** All database effects validate ownership while holding the source row. */
export const withDeferredDocumentSourceOwnership = async <T>({
  decisionId,
  scopedDb,
  signal,
  timeoutMs,
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
        .select({ id: caseLawSources.id, mergeLease: liveDecisionMergeLease })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, decision.sourceId))
        .for("update")
    ).at(0);
    if (source === undefined) {
      return { status: "missing" } as const;
    }
    return source.mergeLease
      ? ({ status: "busy" } as const)
      : ({ status: "ready", sourceId: source.id } as const);
  });
  if (initial.status !== "ready") {
    return initial;
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
            const fencedDb: ScopedDb = async (run) => {
              assertActive();
              return await scopedDb(async (tx) => {
                assertActive();
                const owner = (
                  await tx
                    .select({
                      id: caseLawSources.id,
                      mergeLease: liveDecisionMergeLease,
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
                if (owner.mergeLease) {
                  abortTransaction(
                    new DeferredDocumentOwnershipLostError({
                      message: "Document source is held for decision merge",
                    }),
                  );
                }
                const value = await run(tx);
                assertActive();
                const mergeLease = (
                  await tx
                    .select({ id: caseLawSources.id })
                    .from(caseLawSources)
                    .where(
                      and(
                        eq(caseLawSources.id, initial.sourceId),
                        liveDecisionMergeLease,
                      ),
                    )
                    .limit(1)
                ).at(0);
                if (mergeLease !== undefined) {
                  abortTransaction(
                    new DeferredDocumentOwnershipLostError({
                      message:
                        "Document source entered decision merge during settlement",
                    }),
                  );
                }
                assertActive();
                return value;
              });
            };
            const fence: DeferredDocumentSourceFence = {
              [ownership]: true,
              sourceId: initial.sourceId,
              scopedDb: fencedDb,
              signal: operationSignal,
              beforeRemoteEffect: async (effect) => {
                await fencedDb(() => Promise.resolve());
                const value = await effect();
                await fencedDb(() => Promise.resolve());
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
