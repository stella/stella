import { panic } from "better-result";
import { and, eq, exists, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { DAY_IN_MS } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawRemovalReconciliationItems,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { lockCaseLawRemovalSource } from "@/api/lib/db/aggregate-lock";
import {
  REMOVAL_PENDING_REASON,
  REMOVAL_RETRY_KIND,
  REMOVAL_RETRY_KINDS,
  removalRetryKind,
  removalRetryPayloadSchema,
} from "@/api/lib/legal-search/removal-reconciliation-state";
import type {
  RemovalRetryPayload,
  RemovalStepOutcome,
} from "@/api/lib/legal-search/removal-reconciliation-state";

import type { RemovalEvidence } from "./removal-evidence";

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
  kinds?: readonly (typeof REMOVAL_RETRY_KINDS)[number][];
  acceptedOnly?: boolean;
};

/** Persisted claims remain classifiable when a later observation restores the row. */
const acceptedErasure = (tx: Pick<Transaction, "select">) =>
  exists(
    tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.id, caseLawRemovalReconciliationItems.decisionId),
          or(
            isNotNull(caseLawDecisions.redactedAt),
            sql`${caseLawRemovalReconciliationItems.payload}->>'claim' = 'accepted'`,
          ),
        ),
      ),
  );

/** Each kind uses a bounded, ordered range of the same reconciliation lane. */
export const selectDueRemovalRetries = async ({
  scopedDb,
  sourceId,
  now,
  perKindLimit,
  kinds = REMOVAL_RETRY_KINDS,
  acceptedOnly = false,
}: SelectRemovalRetriesOptions): Promise<RemovalRetryItem[]> => {
  const items: RemovalRetryItem[] = [];
  for (const kind of kinds) {
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
              acceptedOnly ? acceptedErasure(tx) : undefined,
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

type RetainClaimedErasureOptions = {
  retryItem?: RemovalRetryItem | undefined;
  decisionId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  evidence: RemovalEvidence;
  now: Date;
};

export type ClaimedErasureRecovery =
  | { type: "external" }
  | {
      type: "owned";
      id: SafeId<"caseLawRemovalReconciliationItem">;
      attempts: number;
    };

/**
 * The decision fence has accepted this evidence. Only a newly created item
 * belongs to this caller. A foreign takeover advances the attempt revision;
 * only the worker presenting that exact revision can retain its settlement right.
 */
export const retainClaimedErasureTx = async (
  tx: Transaction,
  {
    evidence,
    now,
    decisionId,
    sourceId,
    retryItem,
  }: RetainClaimedErasureOptions,
): Promise<ClaimedErasureRecovery> => {
  await lockCaseLawRemovalSource({ tx, sourceId });
  const payload = {
    type: "pending",
    operation: "erase",
    claim: "accepted",
    decisionId: evidence.decisionId,
    evidence,
    reason: REMOVAL_PENDING_REASON.STORES_PENDING,
  } as const satisfies RemovalRetryPayload;
  // audit: skip - the redaction owner records the accepted erasure; this is its durable retry obligation.
  const proposedId = createSafeId<"caseLawRemovalReconciliationItem">();
  const retained = await tx
    .insert(caseLawRemovalReconciliationItems)
    .values({
      id: proposedId,
      sourceId,
      decisionId,
      kind: REMOVAL_RETRY_KIND.ERASURE,
      payload,
      nextAttemptAt: now,
      lastAttemptAt: now,
      lastError: payload.reason,
    })
    .onConflictDoUpdate({
      target: [
        caseLawRemovalReconciliationItems.sourceId,
        caseLawRemovalReconciliationItems.decisionId,
      ],
      set: {
        kind: REMOVAL_RETRY_KIND.ERASURE,
        payload,
        attempts:
          retryItem === undefined
            ? sql`${caseLawRemovalReconciliationItems.attempts} + 1`
            : sql`CASE WHEN ${caseLawRemovalReconciliationItems.id} = ${retryItem.id} AND ${caseLawRemovalReconciliationItems.attempts} = ${retryItem.attempts} THEN ${caseLawRemovalReconciliationItems.attempts} ELSE ${caseLawRemovalReconciliationItems.attempts} + 1 END`,
        nextAttemptAt: sql`LEAST(${caseLawRemovalReconciliationItems.nextAttemptAt}, excluded.next_attempt_at)`,
        lastError: payload.reason,
      },
    })
    .returning({
      id: caseLawRemovalReconciliationItems.id,
      attempts: caseLawRemovalReconciliationItems.attempts,
    });
  const row =
    retained.at(0) ?? panic("Accepted erasure did not retain recovery work");
  return row.id === proposedId
    ? { type: "owned", id: row.id, attempts: row.attempts }
    : { type: "external" };
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
  previousPayload?: unknown;
};
const removalOutcomePayload = ({
  decisionId,
  outcome,
  origin,
  previousPayload,
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
          claim:
            outcome.claim ??
            (v.is(v.object({ claim: v.literal("accepted") }), previousPayload)
              ? previousPayload.claim
              : undefined),
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
  await lockCaseLawRemovalSource({ tx, sourceId });
  // audit: skip — durable reconciliation outcome for the canonical removal audit.
  const previous = (
    await tx
      .select({
        id: caseLawRemovalReconciliationItems.id,
        attempts: caseLawRemovalReconciliationItems.attempts,
        payload: caseLawRemovalReconciliationItems.payload,
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
    payload: removalOutcomePayload({
      decisionId,
      outcome,
      origin,
      previousPayload: previous?.payload,
    }),
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
  {
    kinds = REMOVAL_RETRY_KINDS,
    acceptedOnly = false,
  }: {
    kinds?: readonly (typeof REMOVAL_RETRY_KINDS)[number][];
    acceptedOnly?: boolean;
  } = {},
): Promise<Date | null> => {
  let next: Date | null = null;
  for (const kind of kinds) {
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
              acceptedOnly ? acceptedErasure(tx) : undefined,
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

type DueErasureSourcesOptions = {
  scopedDb: ScopedDb;
  after: SafeId<"caseLawSource"> | null;
  now: Date;
  limit: number;
};

/** Seek sources by primary key and test each source's indexed erasure range. */
export const selectDueErasureSources = async ({
  scopedDb,
  after,
  now,
  limit,
}: DueErasureSourcesOptions) =>
  await scopedDb(
    async (tx) =>
      await tx
        .select({ id: caseLawSources.id })
        .from(caseLawSources)
        .where(
          and(
            after === null ? undefined : gt(caseLawSources.id, after),
            exists(
              tx
                .select({ id: caseLawRemovalReconciliationItems.id })
                .from(caseLawRemovalReconciliationItems)
                .where(
                  and(
                    eq(
                      caseLawRemovalReconciliationItems.sourceId,
                      caseLawSources.id,
                    ),
                    eq(
                      caseLawRemovalReconciliationItems.kind,
                      REMOVAL_RETRY_KIND.ERASURE,
                    ),
                    acceptedErasure(tx),
                    sql`${caseLawRemovalReconciliationItems.nextAttemptAt} <= ${now.toISOString()}::timestamptz`,
                  ),
                ),
            ),
          ),
        )
        .orderBy(caseLawSources.id)
        .limit(limit),
  );

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
