import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawRemovalReconciliationItems,
  caseLawSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  REMOVAL_RETRY_KIND,
  REMOVAL_RETRY_KINDS,
  removalRetryKind,
  removalRetryPayloadSchema,
} from "@/api/lib/legal-search/removal-reconciliation-state";
import type {
  RemovalRetryPayload,
  RemovalStepOutcome,
} from "@/api/lib/legal-search/removal-reconciliation-state";

const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  60 * 60_000,
  DAY_IN_MS,
  7 * DAY_IN_MS,
] as const;

export type RemovalRetryItem = {
  id: SafeId<"caseLawRemovalReconciliationItem">;
  decisionId: SafeId<"caseLawDecision">;
  attempts: number;
  payload: RemovalRetryPayload;
};

type SelectRemovalRetriesOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  now: Date;
  perKindLimit: number;
};

/** Each kind uses a bounded, ordered range of the same reconciliation lane. */
export const selectDueRemovalRetries = async ({
  scopedDb,
  sourceId,
  now,
  perKindLimit,
}: SelectRemovalRetriesOptions): Promise<RemovalRetryItem[]> => {
  const items: RemovalRetryItem[] = [];
  for (const kind of REMOVAL_RETRY_KINDS) {
    // db-await-in-loop: fixed kind ranges each have their own indexed limit.
    const rows = await scopedDb(
      async (tx) =>
        await tx
          .select({
            id: caseLawRemovalReconciliationItems.id,
            payload: caseLawRemovalReconciliationItems.payload,
            attempts: caseLawRemovalReconciliationItems.attempts,
            decisionId: caseLawRemovalReconciliationItems.decisionId,
          })
          .from(caseLawRemovalReconciliationItems)
          .where(
            and(
              eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
              eq(caseLawRemovalReconciliationItems.kind, kind),
              sql`${caseLawRemovalReconciliationItems.nextAttemptAt} <= ${now.toISOString()}::timestamptz`,
            ),
          )
          .orderBy(
            caseLawRemovalReconciliationItems.nextAttemptAt,
            caseLawRemovalReconciliationItems.id,
          )
          .limit(perKindLimit),
    );
    for (const row of rows) {
      const parsed = v.safeParse(removalRetryPayloadSchema, row.payload);
      if (
        !parsed.success ||
        removalRetryKind(parsed.output) !== kind ||
        parsed.output.decisionId !== row.decisionId
      ) {
        return panic("Invalid publisher-removal retry item");
      }
      items.push({
        payload: parsed.output,
        id: row.id,
        attempts: row.attempts,
        decisionId: row.decisionId,
      });
    }
  }
  return items;
};

type PersistRemovalOutcomeOptions = {
  sourceId: SafeId<"caseLawSource">;
  decisionId: SafeId<"caseLawDecision">;
  outcome: RemovalStepOutcome;
  now: Date;
  origin: { type: "discovery" } | { type: "retry"; item: RemovalRetryItem };
};

type RemovalPayloadOptions = Pick<
  PersistRemovalOutcomeOptions,
  "decisionId" | "origin"
> & {
  outcome: Exclude<RemovalStepOutcome, { type: "settled" }>;
};
const removalOutcomePayload = ({
  decisionId,
  outcome,
  origin,
}: RemovalPayloadOptions) => {
  switch (outcome.type) {
    case "superseded":
      return {
        type: "superseded",
        reason: outcome.reason,
        evidence: outcome.evidence,
        decisionId,
        previousItemId:
          origin.type === "retry"
            ? origin.item.id
            : panic("Only a retry can supersede an erasure"),
      } as const satisfies RemovalRetryPayload;
    case "unprobeable":
      return {
        type: outcome.type,
        decisionId,
        reason: outcome.reason,
      } as const satisfies RemovalRetryPayload;
    case "pending":
      if (outcome.operation === "erase") {
        return {
          type: outcome.type,
          operation: outcome.operation,
          decisionId,
          reason: outcome.reason,
          evidence: outcome.evidence,
        } as const satisfies RemovalRetryPayload;
      }
      return {
        type: outcome.type,
        operation: outcome.operation,
        decisionId,
        reason: outcome.reason,
      } as const satisfies RemovalRetryPayload;
    default:
      outcome satisfies never;
      return panic("Unhandled removal retry payload");
  }
};

/** The caller holds the source row; retry revisions prevent stale attempts recreating settled work. */
export const persistRemovalOutcomeTx = async (
  tx: Transaction,
  { sourceId, decisionId, outcome, now, origin }: PersistRemovalOutcomeOptions,
): Promise<boolean> => {
  // audit: skip — durable reconciliation outcome for the canonical removal audit.
  const previous = (
    await tx
      .select({
        id: caseLawRemovalReconciliationItems.id,
        attempts: caseLawRemovalReconciliationItems.attempts,
      })
      .from(caseLawRemovalReconciliationItems)
      .where(
        and(
          eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
          eq(caseLawRemovalReconciliationItems.decisionId, decisionId),
        ),
      )
      .limit(1)
  ).at(0);
  if (
    origin.type === "retry" &&
    (previous?.id !== origin.item.id ||
      previous.attempts !== origin.item.attempts)
  ) {
    return false;
  }
  // Enumeration must not overwrite an authorized erasure or reset its retry revision.
  if (origin.type === "discovery" && previous !== undefined) {
    return true;
  }
  if (outcome.type === "settled") {
    await tx
      .delete(caseLawRemovalReconciliationItems)
      .where(
        and(
          eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
          eq(caseLawRemovalReconciliationItems.decisionId, decisionId),
        ),
      );
    return true;
  }
  const discoveryErasure =
    origin.type === "discovery" &&
    outcome.type === "pending" &&
    outcome.operation === "erase";
  const newlyAuthorizedErasure =
    outcome.type === "pending" &&
    outcome.operation === "erase" &&
    origin.type === "retry" &&
    (origin.item.payload.type !== "pending" ||
      origin.item.payload.operation === "probe");
  const attempts = (previous?.attempts ?? 0) + (discoveryErasure ? 0 : 1);
  const delay =
    RETRY_DELAYS_MS.at(
      Math.max(1, Math.min(attempts, RETRY_DELAYS_MS.length)) - 1,
    ) ?? panic("Missing removal retry delay");
  const pending = {
    kind: removalRetryKind(outcome),
    payload: removalOutcomePayload({ decisionId, outcome, origin }),
    attempts,
    nextAttemptAt: new Date(
      now.getTime() + (discoveryErasure || newlyAuthorizedErasure ? 0 : delay),
    ),
    lastAttemptAt: now,
    lastError: outcome.reason,
  };
  if (outcome.type === "superseded") {
    // Close the old authorization and create a separately identified current-identity probe.
    await tx
      .delete(caseLawRemovalReconciliationItems)
      .where(
        and(
          eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
          eq(caseLawRemovalReconciliationItems.decisionId, decisionId),
        ),
      );
    await tx.insert(caseLawRemovalReconciliationItems).values({
      sourceId,
      decisionId,
      ...pending,
    });
    return true;
  }
  await tx
    .insert(caseLawRemovalReconciliationItems)
    .values({ sourceId, decisionId, ...pending })
    .onConflictDoUpdate({
      target: [
        caseLawRemovalReconciliationItems.sourceId,
        caseLawRemovalReconciliationItems.decisionId,
      ],
      set: pending,
    });
  return true;
};

/** The source task schedules the retry lane independently of the weekly discovery cycle. */
export const nextRemovalRetryAt = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource">,
): Promise<Date | null> => {
  let next: Date | null = null;
  for (const kind of REMOVAL_RETRY_KINDS) {
    // db-await-in-loop: one earliest due timestamp per fixed kind, no history scan.
    const row = await scopedDb(async (tx) =>
      (
        await tx
          .select({ at: caseLawRemovalReconciliationItems.nextAttemptAt })
          .from(caseLawRemovalReconciliationItems)
          .where(
            and(
              eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
              eq(caseLawRemovalReconciliationItems.kind, kind),
            ),
          )
          .orderBy(
            caseLawRemovalReconciliationItems.nextAttemptAt,
            caseLawRemovalReconciliationItems.id,
          )
          .limit(1)
      ).at(0),
    );
    if (row !== undefined && (next === null || row.at < next)) {
      next = row.at;
    }
  }
  return next;
};

/** The store owns health reads as well as durable retry transitions. */
export const removalReconciliationCountsQuery = (
  db: Transaction,
  sourceIds: SafeId<"caseLawSource">[],
) => {
  const counts = db
    .select({
      pendingRemovals: sql<number>`count(*)::int`.as("pending_removals"),
      unprobeable:
        sql<number>`count(*) filter (where ${caseLawRemovalReconciliationItems.kind} = ${REMOVAL_RETRY_KIND.UNPROBEABLE})::int`.as(
          "unprobeable",
        ),
    })
    .from(caseLawRemovalReconciliationItems)
    .where(eq(caseLawRemovalReconciliationItems.sourceId, caseLawSources.id))
    .as("removal_counts");
  return db
    .select({
      sourceId: caseLawSources.id,
      pendingRemovals: counts.pendingRemovals,
      unprobeable: counts.unprobeable,
    })
    .from(caseLawSources)
    .innerJoinLateral(counts, sql`true`)
    .where(inArray(caseLawSources.id, sourceIds));
};
