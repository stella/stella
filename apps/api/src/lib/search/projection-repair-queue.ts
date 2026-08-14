import { Result, UnhandledException } from "better-result";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { rootDb } from "@/api/db/root";
import {
  contacts,
  entities,
  searchProjectionRepairQueue,
  workspaces,
} from "@/api/db/schema";
import type { SearchProjectionKind } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  reindexWorkspacesForContact,
  upsertContactSearchDocument,
  upsertWorkspaceSearchDocument,
} from "@/api/lib/search/index-global";
import { getSearchProvider } from "@/api/lib/search/provider";

/**
 * The one path by which an entity, contact, or matter search projection is
 * brought up to date.
 *
 * A mutation marks its source dirty inside its own transaction, so the mark
 * commits or rolls back with the edit. After the commit the caller flushes
 * that mark: the same claim/repair/settle steps the scheduler runs, applied
 * to the rows it just wrote. A flush lost to a restart, a crash, or a deploy
 * changes nothing durable — the row is still there, and the standing drain
 * repairs it on its next pass.
 *
 * Repairs are idempotent. Each upsert helper reads its source and no-ops when
 * the source is gone, so a queued row for a deleted source is dropped rather
 * than resurrected, and repeating a repair rewrites the same projection.
 */

/** Rows a scheduled drain claims per run. */
export const SEARCH_PROJECTION_REPAIR_BATCH_SIZE = 32;

/**
 * Repairs in flight at once. Each one opens its own transaction on the owner
 * pool, so the batch is drained by a fixed number of workers rather than all
 * at once; the bound is what keeps a backlog from crowding out request work.
 */
const SEARCH_PROJECTION_REPAIR_CONCURRENCY = 4;

const REPAIR_RETRY_BASE_SECONDS = 60;
const REPAIR_RETRY_MAX_SECONDS = 6 * 60 * 60;
/**
 * A repair that fails this many times is parked (`next_attempt_at =
 * infinity`): the claim query never picks it up again, so a permanently
 * failing row cannot loop. A later real edit re-marks the row, which resets
 * the schedule and un-parks it.
 */
const REPAIR_MAX_ATTEMPTS = 8;

const SEARCH_PROJECTION_KIND = {
  contact: "contact",
  entity: "entity",
  workspace: "workspace",
} as const satisfies Record<SearchProjectionKind, SearchProjectionKind>;

/** Owner-level handle; the queue is system state, not tenant-scoped work. */
type SearchProjectionRepairDb = Pick<
  typeof rootDb,
  "delete" | "select" | "update"
>;

export type SearchProjectionRepairDeps = {
  db: SearchProjectionRepairDb;
  repair: Record<SearchProjectionKind, (sourceId: string) => Promise<void>>;
};

export type SearchProjectionRepairOutcome = {
  failed: number;
  repaired: number;
};

type ClaimedRepair = {
  kind: SearchProjectionKind;
  revision: string;
  sourceId: string;
};

/**
 * Repairing a contact repairs every projection its text reaches: its own
 * document, and the matters that fold the contact's name into their
 * searchable text as client or party. Splitting the two would let a rename
 * refresh the contact while every matter carrying that name kept the old one.
 */
const repairContactProjection = async (sourceId: string): Promise<void> => {
  const contactId = toSafeId<"contact">(sourceId);
  await upsertContactSearchDocument(contactId);
  await reindexWorkspacesForContact(contactId);
};

const defaultRepairDeps: SearchProjectionRepairDeps = {
  db: rootDb,
  repair: {
    contact: repairContactProjection,
    entity: async (sourceId) =>
      await getSearchProvider().indexEntity(toSafeId<"entity">(sourceId)),
    workspace: async (sourceId) =>
      await upsertWorkspaceSearchDocument(toSafeId<"workspace">(sourceId)),
  },
};

const uniqueIds = <T extends string>(ids: readonly T[]): T[] => [
  ...new Set(ids),
];

/**
 * Every mark is written as one `INSERT ... SELECT` over the source table, so
 * the tenant comes from the source row rather than from the caller, and the
 * read runs under the caller's own scope: a session can only mark what it can
 * already see.
 */
const markedFrom = (kind: SearchProjectionKind) => ({
  attempts: sql<number>`0`.as("attempts"),
  enqueuedAt: sql<Date>`now()`.as("enqueued_at"),
  kind: sql<SearchProjectionKind>`${kind}`.as("kind"),
  nextAttemptAt: sql<Date>`now()`.as("next_attempt_at"),
  revision: sql<string>`gen_random_uuid()`.as("revision"),
});

/**
 * A repeat mutation lands on the same key and rewrites its revision, so a
 * burst of edits is one pending repair rather than a queue of them, and the
 * attempt schedule restarts because the new edit deserves a fresh try.
 */
const onRepeatedMark = {
  set: {
    attempts: sql`0`,
    enqueuedAt: sql`excluded.enqueued_at`,
    nextAttemptAt: sql`excluded.next_attempt_at`,
    organizationId: sql`excluded.organization_id`,
    revision: sql`excluded.revision`,
  },
  target: [
    searchProjectionRepairQueue.kind,
    searchProjectionRepairQueue.sourceId,
  ],
};

export const enqueueEntitySearchRepairs = async (
  tx: Transaction,
  entityIds: readonly SafeId<"entity">[],
): Promise<void> => {
  const ids = uniqueIds(entityIds);
  if (ids.length === 0) {
    return;
  }
  await tx
    .insert(searchProjectionRepairQueue)
    .select(
      tx
        .select({
          ...markedFrom(SEARCH_PROJECTION_KIND.entity),
          organizationId: workspaces.organizationId,
          sourceId: entities.id,
        })
        .from(entities)
        .innerJoin(workspaces, eq(workspaces.id, entities.workspaceId))
        .where(inArray(entities.id, ids)),
    )
    .onConflictDoUpdate(onRepeatedMark);
};

export const enqueueContactSearchRepairs = async (
  tx: Transaction,
  contactIds: readonly SafeId<"contact">[],
): Promise<void> => {
  const ids = uniqueIds(contactIds);
  if (ids.length === 0) {
    return;
  }
  await tx
    .insert(searchProjectionRepairQueue)
    .select(
      tx
        .select({
          ...markedFrom(SEARCH_PROJECTION_KIND.contact),
          organizationId: contacts.organizationId,
          sourceId: contacts.id,
        })
        .from(contacts)
        .where(inArray(contacts.id, ids)),
    )
    .onConflictDoUpdate(onRepeatedMark);
};

export const enqueueWorkspaceSearchRepairs = async (
  tx: Transaction,
  workspaceIds: readonly SafeId<"workspace">[],
): Promise<void> => {
  const ids = uniqueIds(workspaceIds);
  if (ids.length === 0) {
    return;
  }
  await tx
    .insert(searchProjectionRepairQueue)
    .select(
      tx
        .select({
          ...markedFrom(SEARCH_PROJECTION_KIND.workspace),
          organizationId: workspaces.organizationId,
          sourceId: workspaces.id,
        })
        .from(workspaces)
        .where(inArray(workspaces.id, ids)),
    )
    .onConflictDoUpdate(onRepeatedMark);
};

const claimedColumns = {
  kind: searchProjectionRepairQueue.kind,
  revision: searchProjectionRepairQueue.revision,
  sourceId: searchProjectionRepairQueue.sourceId,
};

const claimQueuedRepairs = async ({
  db,
  kind,
  sourceIds,
}: {
  db: SearchProjectionRepairDb;
  kind: SearchProjectionKind;
  sourceIds: readonly string[];
}): Promise<ClaimedRepair[]> =>
  await db
    .select(claimedColumns)
    .from(searchProjectionRepairQueue)
    .where(
      and(
        eq(searchProjectionRepairQueue.kind, kind),
        inArray(searchProjectionRepairQueue.sourceId, [...sourceIds]),
      ),
    )
    .limit(sourceIds.length);

/**
 * Due rows, oldest dirt first. A row the repair could not fix carries a
 * retry time in the future and is skipped until it arrives, so one
 * unrepairable source cannot hold the head of every batch.
 */
const claimDueRepairs = async ({
  db,
  limit,
}: {
  db: SearchProjectionRepairDb;
  limit: number;
}): Promise<ClaimedRepair[]> =>
  await db
    .select(claimedColumns)
    .from(searchProjectionRepairQueue)
    .where(lte(searchProjectionRepairQueue.nextAttemptAt, sql`now()`))
    .orderBy(
      asc(searchProjectionRepairQueue.enqueuedAt),
      asc(searchProjectionRepairQueue.kind),
      asc(searchProjectionRepairQueue.sourceId),
    )
    .limit(limit);

/**
 * Both settlements match on the revision that was claimed. A mutation that
 * lands while the repair is in flight has already rewritten that revision, so
 * neither the delete nor the backoff touches its row and the newer edit stays
 * queued instead of being cleared as handled.
 */
const claimedRow = (claim: ClaimedRepair) =>
  and(
    eq(searchProjectionRepairQueue.kind, claim.kind),
    eq(searchProjectionRepairQueue.sourceId, claim.sourceId),
    eq(searchProjectionRepairQueue.revision, claim.revision),
  );

const settleRepaired = async (
  db: SearchProjectionRepairDb,
  claim: ClaimedRepair,
): Promise<void> => {
  await db.delete(searchProjectionRepairQueue).where(claimedRow(claim));
};

const settleFailed = async (
  db: SearchProjectionRepairDb,
  claim: ClaimedRepair,
): Promise<void> => {
  const updated = await db
    .update(searchProjectionRepairQueue)
    .set({
      attempts: sql`${searchProjectionRepairQueue.attempts} + 1`,
      nextAttemptAt: sql`CASE
        WHEN ${searchProjectionRepairQueue.attempts} + 1 >= ${REPAIR_MAX_ATTEMPTS}
          THEN 'infinity'::timestamptz
        ELSE now() + make_interval(secs => LEAST(
          ${REPAIR_RETRY_BASE_SECONDS}::double precision
            * power(2, ${searchProjectionRepairQueue.attempts}),
          ${REPAIR_RETRY_MAX_SECONDS}::double precision
        ))
      END`,
    })
    .where(claimedRow(claim))
    .returning({ attempts: searchProjectionRepairQueue.attempts });
  const attempts = updated.at(0)?.attempts ?? 0;
  if (attempts >= REPAIR_MAX_ATTEMPTS) {
    logger.error("search.projection_repair_parked", {
      attempts,
      searchProjectionKind: claim.kind,
      searchProjectionSourceId: claim.sourceId,
    });
  }
};

type RepairRun = {
  deps: SearchProjectionRepairDeps;
  outcome: SearchProjectionRepairOutcome;
  pending: ClaimedRepair[];
  signal: AbortSignal | undefined;
};

const repairClaim = async ({
  claim,
  deps,
  outcome,
}: {
  claim: ClaimedRepair;
  deps: SearchProjectionRepairDeps;
  outcome: SearchProjectionRepairOutcome;
}): Promise<void> => {
  const attempt = await Result.tryPromise({
    try: async () => await deps.repair[claim.kind](claim.sourceId),
    catch: (cause) =>
      cause instanceof Error ? cause : new UnhandledException({ cause }),
  });

  if (Result.isError(attempt)) {
    outcome.failed += 1;
    captureError(attempt.error, {
      searchProjectionKind: claim.kind,
      searchProjectionSourceId: claim.sourceId,
    });
    logger.error("search.projection_repair_failed", {
      "error.type": errorTag(attempt.error),
      searchProjectionKind: claim.kind,
      searchProjectionSourceId: claim.sourceId,
    });
    await settleFailed(deps.db, claim);
    return;
  }

  outcome.repaired += 1;
  await settleRepaired(deps.db, claim);
};

/**
 * One worker chain: takes the next claim and recurses. Recursion rather than a
 * loop keeps every repair's completion a real `await` without serialising the
 * whole batch — the chains run beside each other, each one sequential.
 */
const runRepairWorker = async (run: RepairRun): Promise<void> => {
  if (run.signal?.aborted === true) {
    return;
  }
  const claim = run.pending.shift();
  if (!claim) {
    return;
  }
  await repairClaim({ claim, deps: run.deps, outcome: run.outcome });
  await runRepairWorker(run);
};

const repairClaimed = async ({
  claims,
  deps,
  signal,
}: {
  claims: ClaimedRepair[];
  deps: SearchProjectionRepairDeps;
  signal: AbortSignal | undefined;
}): Promise<SearchProjectionRepairOutcome> => {
  const run: RepairRun = {
    deps,
    outcome: { failed: 0, repaired: 0 },
    pending: claims,
    signal,
  };
  const workerCount = Math.min(
    SEARCH_PROJECTION_REPAIR_CONCURRENCY,
    claims.length,
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => await runRepairWorker(run)),
  );
  return run.outcome;
};

const flushSearchRepairs = async ({
  deps,
  kind,
  sourceIds,
}: {
  deps: SearchProjectionRepairDeps;
  kind: SearchProjectionKind;
  sourceIds: readonly string[];
}): Promise<SearchProjectionRepairOutcome> => {
  const ids = uniqueIds(sourceIds);
  if (ids.length === 0) {
    return { failed: 0, repaired: 0 };
  }
  const claims = await claimQueuedRepairs({
    db: deps.db,
    kind,
    sourceIds: ids,
  });
  return await repairClaimed({ claims, deps, signal: undefined });
};

export const flushEntitySearchRepairs = async (
  entityIds: readonly SafeId<"entity">[],
  deps: SearchProjectionRepairDeps = defaultRepairDeps,
): Promise<SearchProjectionRepairOutcome> =>
  await flushSearchRepairs({
    deps,
    kind: SEARCH_PROJECTION_KIND.entity,
    sourceIds: entityIds,
  });

export const flushContactSearchRepairs = async (
  contactIds: readonly SafeId<"contact">[],
  deps: SearchProjectionRepairDeps = defaultRepairDeps,
): Promise<SearchProjectionRepairOutcome> =>
  await flushSearchRepairs({
    deps,
    kind: SEARCH_PROJECTION_KIND.contact,
    sourceIds: contactIds,
  });

export const flushWorkspaceSearchRepairs = async (
  workspaceIds: readonly SafeId<"workspace">[],
  deps: SearchProjectionRepairDeps = defaultRepairDeps,
): Promise<SearchProjectionRepairOutcome> =>
  await flushSearchRepairs({
    deps,
    kind: SEARCH_PROJECTION_KIND.workspace,
    sourceIds: workspaceIds,
  });

type DrainSearchProjectionRepairOptions = {
  deps?: SearchProjectionRepairDeps;
  limit?: number;
  signal?: AbortSignal | undefined;
};

/**
 * Repairs one bounded batch of due rows. Whatever it leaves behind stays
 * queued for the next pass, so the run cost is fixed no matter how far the
 * projections have drifted.
 */
export const drainSearchProjectionRepairQueue = async ({
  deps = defaultRepairDeps,
  limit = SEARCH_PROJECTION_REPAIR_BATCH_SIZE,
  signal,
}: DrainSearchProjectionRepairOptions = {}): Promise<SearchProjectionRepairOutcome> => {
  if (signal?.aborted === true) {
    return { failed: 0, repaired: 0 };
  }
  const claims = await claimDueRepairs({ db: deps.db, limit });
  return await repairClaimed({ claims, deps, signal });
};
