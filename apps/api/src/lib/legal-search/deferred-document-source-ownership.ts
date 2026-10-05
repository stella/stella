// parser-output-unchanged: document ownership does not alter parsing.
import { Result, TaggedError } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
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

/** All database effects validate ownership while holding the source row. */
export const withDeferredDocumentSourceOwnership = async <T>({
  decisionId,
  scopedDb,
  signal,
  timeoutMs,
  operation,
}: WithDeferredDocumentSourceOwnershipOptions<T>): Promise<
  { status: "completed"; value: T } | DeferredDocumentOwnershipRefusal
> => {
  signal?.throwIfAborted();
  const decision = await scopedDb(async (tx) =>
    (
      await tx
        .select({ sourceId: caseLawDecisions.sourceId })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId))
        .limit(1)
    ).at(0),
  );
  if (decision === undefined) {
    return { status: "busy" };
  }
  const lease = await acquireCaseLawSourceIngestionLease({
    sourceId: decision.sourceId,
    scopedDb,
  });
  if (lease === null) {
    return { status: "busy" };
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
                throw new DeferredDocumentOwnershipLostError({
                  message: "Document ownership is closed",
                });
              }
            };
            const fencedDb: ScopedDb = async (run) => {
              assertActive();
              return await scopedDb(async (tx) => {
                assertActive();
                const owner = (
                  await tx
                    .select({ id: caseLawSources.id })
                    .from(caseLawSources)
                    .where(
                      and(
                        eq(caseLawSources.id, decision.sourceId),
                        eq(
                          caseLawSources.ingestionLeaseToken,
                          lease.leaseToken,
                        ),
                        sql`${caseLawSources.ingestionLeaseExpiresAt} > clock_timestamp()`,
                      ),
                    )
                    .for("update")
                ).at(0);
                if (owner === undefined) {
                  throw new DeferredDocumentOwnershipLostError({
                    message: "Document source ownership was lost",
                  });
                }
                const value = await run(tx);
                assertActive();
                const stillOwned = (
                  await tx
                    .select({ id: caseLawSources.id })
                    .from(caseLawSources)
                    .where(
                      and(
                        eq(caseLawSources.id, decision.sourceId),
                        eq(
                          caseLawSources.ingestionLeaseToken,
                          lease.leaseToken,
                        ),
                        sql`${caseLawSources.ingestionLeaseExpiresAt} > clock_timestamp()`,
                      ),
                    )
                    .limit(1)
                ).at(0);
                if (stillOwned === undefined) {
                  throw new DeferredDocumentOwnershipLostError({
                    message:
                      "Document source ownership expired during settlement",
                  });
                }
                assertActive();
                return value;
              });
            };
            const fence: DeferredDocumentSourceFence = {
              [ownership]: true,
              sourceId: decision.sourceId,
              scopedDb: fencedDb,
              signal: operationSignal,
              beforeRemoteEffect: async (effect) => {
                await fencedDb(async () => undefined);
                const value = await effect();
                await fencedDb(async () => undefined);
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
      throw result.error;
    }
    return { status: "completed", value: result.value };
  } finally {
    state = "closed";
    await lease.release();
  }
};
