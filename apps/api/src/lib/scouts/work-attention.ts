import { panic } from "better-result";
import { and, asc, eq, gt, inArray, lte, max, or } from "drizzle-orm";

import { SCOUT_KEY } from "@stll/api-contract/signals";
import type { OpenWorkObligationStatus } from "@stll/api-contract/signals";
import { WORK_OBLIGATION_STATUS } from "@stll/api-contract/workflow-status";
import type { WorkObligationStatus } from "@stll/api-contract/workflow-status";
import { DAY_IN_MS } from "@stll/time";

import { member as organizationMembers } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import {
  entities,
  WORK_OBLIGATION_EVENT_TYPE,
  workObligationEvents,
  workObligations,
  workspaces,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  WORK_ATTENTION_DEADLINE_DAYS,
  workAttentionSignals,
  workAttentionToday,
} from "@/api/lib/scouts/work-attention.logic";
import type { WorkAttentionObligation } from "@/api/lib/scouts/work-attention.logic";
import type { NewSignal } from "@/api/lib/signals/emit";
import { runScout } from "@/api/lib/signals/scout";
import { workObligationEligibleEntity } from "@/api/lib/work-obligations/eligibility";

/** The statuses an obligation still owes somebody an answer in. */
const OPEN_WORK_OBLIGATION_STATUSES = [
  WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
  WORK_OBLIGATION_STATUS.ACTIVE,
] as const satisfies readonly OpenWorkObligationStatus[];

/** The events that put the current owner on an obligation. */
const ASSIGNMENT_EVENT_TYPES = [
  WORK_OBLIGATION_EVENT_TYPE.OWNER_ASSIGNED,
  WORK_OBLIGATION_EVENT_TYPE.DELEGATED,
] as const;

/** The two database handles the sweep needs, injectable for integration tests. */
export type WorkAttentionScoutDependencies = {
  db: typeof rootDb;
  createScopedDb: typeof createRootScopedDb;
};

const DEFAULT_WORK_ATTENTION_SCOUT_DEPENDENCIES = {
  db: rootDb,
  createScopedDb: createRootScopedDb,
} satisfies WorkAttentionScoutDependencies;

export type RunWorkAttentionScoutArgs = {
  /** Keyset position from the previous tick; `null` starts a fresh cycle. */
  cursor: SafeId<"entity"> | null;
  now?: Date;
  dependencies?: WorkAttentionScoutDependencies;
};

export type RunWorkAttentionScoutResult = {
  scanned: number;
  emitted: number;
  inserted: number;
  organizations: number;
  /** Organizations whose last member is gone, so no one could read a signal. */
  organizationsWithoutMember: number;
  /** `null` once the cycle is complete, so the next tick sweeps from the start. */
  nextCursor: SafeId<"entity"> | null;
};

type ObligationFacts = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  status: WorkObligationStatus;
  ownerUserId: string | null;
  name: string;
  workingTargetDate: string | null;
  hardDeadlineDate: string | null;
  createdAt: Date;
};

type ObligationRow = ObligationFacts & {
  organizationId: SafeId<"organization">;
};

/**
 * Either handle the scout reads obligations through: the root pool for the
 * sweep page, the emitting transaction for the recheck immediately before
 * insertion.
 */
type ObligationReader = Pick<Transaction, "select">;

/** The facts both reads project, so the recheck cannot drift from the page. */
const obligationFactsColumns = {
  entityId: workObligations.entityId,
  workspaceId: workObligations.workspaceId,
  status: workObligations.status,
  ownerUserId: workObligations.ownerUserId,
  name: entities.name,
  workingTargetDate: workObligations.workingTargetDate,
  hardDeadlineDate: workObligations.hardDeadlineDate,
  createdAt: workObligations.createdAt,
} as const;

/** The entity both reads join through, so the recheck cannot drift either. */
const obligationEntityJoin = and(
  eq(entities.id, workObligations.entityId),
  eq(entities.workspaceId, workObligations.workspaceId),
  eq(entities.kind, "task"),
  workObligationEligibleEntity,
);

const openStatus = (status: WorkObligationStatus): OpenWorkObligationStatus => {
  switch (status) {
    case WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT:
    case WORK_OBLIGATION_STATUS.ACTIVE:
      return status;
    case WORK_OBLIGATION_STATUS.UNASSIGNED:
    case WORK_OBLIGATION_STATUS.COMPLETED:
    case WORK_OBLIGATION_STATUS.CANCELLED:
      return panic(`work.attention page returned a ${status} obligation`);
    default: {
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
    }
  }
};

/**
 * One bounded keyset page of open obligations that could warrant attention.
 * The predicate is the scout's cheap half: an unanswered assignment always
 * qualifies for inspection, an acknowledged one only once its hard deadline is
 * inside the risk window.
 */
const loadObligationPage = async (
  db: ObligationReader,
  cursor: SafeId<"entity"> | null,
  now: Date,
): Promise<ObligationRow[]> => {
  const riskCutoff = new Date(
    now.getTime() + WORK_ATTENTION_DEADLINE_DAYS * DAY_IN_MS,
  );
  return await db
    .select({
      ...obligationFactsColumns,
      organizationId: workspaces.organizationId,
    })
    .from(workObligations)
    .innerJoin(entities, obligationEntityJoin)
    .innerJoin(workspaces, eq(workspaces.id, workObligations.workspaceId))
    .where(
      and(
        inArray(workObligations.status, [...OPEN_WORK_OBLIGATION_STATUSES]),
        or(
          eq(
            workObligations.status,
            WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
          ),
          lte(workObligations.hardDeadlineDate, workAttentionToday(riskCutoff)),
        ),
        cursor === null ? undefined : gt(workObligations.entityId, cursor),
      ),
    )
    .orderBy(asc(workObligations.entityId))
    .limit(LIMITS.workAttentionObligationsPage);
};

/**
 * Latest assignment instant per unanswered obligation, in one query for the
 * page. A row with no assignment event was created already-owned, so its own
 * creation is when the owner was put on it.
 */
const loadAssignedAt = async (
  db: ObligationReader,
  rows: readonly ObligationFacts[],
): Promise<Map<SafeId<"entity">, Date>> => {
  const awaiting = rows.filter(
    ({ status }) => status === WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
  );
  if (awaiting.length === 0) {
    return new Map();
  }
  const assignments = await db
    .select({
      obligationEntityId: workObligationEvents.obligationEntityId,
      assignedAt: max(workObligationEvents.occurredAt),
    })
    .from(workObligationEvents)
    .where(
      and(
        inArray(
          workObligationEvents.obligationEntityId,
          awaiting.map(({ entityId }) => entityId),
        ),
        inArray(
          workObligationEvents.workspaceId,
          awaiting.map((row) => row.workspaceId),
        ),
        inArray(workObligationEvents.type, [...ASSIGNMENT_EVENT_TYPES]),
      ),
    )
    .groupBy(workObligationEvents.obligationEntityId);

  return new Map(
    assignments.flatMap(({ obligationEntityId, assignedAt }) =>
      assignedAt === null ? [] : [[obligationEntityId, assignedAt] as const],
    ),
  );
};

/**
 * One organization member per organization, as the RLS session identity the
 * emitting transaction runs under. The scout has no human actor: signal
 * visibility is decided by the organization and the workspace the row carries,
 * never by this identity, and the emitted rows are left unassigned and without
 * a creator so no member is shown as having raised them.
 */
const loadScoutActors = async (
  db: typeof rootDb,
  organizationIds: readonly SafeId<"organization">[],
): Promise<Map<SafeId<"organization">, SafeId<"user">>> => {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const actors = await db
    .selectDistinctOn([organizationMembers.organizationId], {
      organizationId: organizationMembers.organizationId,
      userId: organizationMembers.userId,
    })
    .from(organizationMembers)
    .where(inArray(organizationMembers.organizationId, [...organizationIds]))
    .orderBy(
      asc(organizationMembers.organizationId),
      asc(organizationMembers.createdAt),
      asc(organizationMembers.id),
    )
    .limit(organizationIds.length);
  return new Map(
    actors.map((actor) => [
      brandPersistedOrganizationId(actor.organizationId),
      brandPersistedUserId(actor.userId),
    ]),
  );
};

const toObligation = (
  row: ObligationFacts,
  assignedAt: Map<SafeId<"entity">, Date>,
): WorkAttentionObligation => ({
  entityId: row.entityId,
  workspaceId: row.workspaceId,
  name: row.name,
  status: openStatus(row.status),
  ownerUserId: brandPersistedUserId(
    row.ownerUserId ??
      panic(`work.attention obligation ${row.entityId} has no owner`),
  ),
  assignedAt: assignedAt.get(row.entityId) ?? row.createdAt,
  workingTargetDate: row.workingTargetDate,
  hardDeadlineDate: row.hardDeadlineDate,
});

type OrganizationBatch = {
  organizationId: SafeId<"organization">;
  workspaceIds: SafeId<"workspace">[];
  /** Every scanned obligation, so the recheck reads exactly what was scanned. */
  obligationEntityIds: SafeId<"entity">[];
  signals: NewSignal[];
};

/**
 * One batch per organization the page touched, including the organizations
 * whose scanned obligations warrant nothing: the census records that they were
 * scanned, which is what keeps "ran, found nothing" apart from "never ran".
 */
const groupByOrganization = (
  rows: readonly ObligationRow[],
  assignedAt: Map<SafeId<"entity">, Date>,
  now: Date,
): OrganizationBatch[] => {
  const batches = new Map<SafeId<"organization">, OrganizationBatch>();
  for (const row of rows) {
    const signals = workAttentionSignals(toObligation(row, assignedAt), now);
    const batch = batches.get(row.organizationId);
    if (!batch) {
      batches.set(row.organizationId, {
        organizationId: row.organizationId,
        workspaceIds: [row.workspaceId],
        obligationEntityIds: [row.entityId],
        signals,
      });
      continue;
    }
    batch.signals.push(...signals);
    batch.obligationEntityIds.push(row.entityId);
    if (!batch.workspaceIds.includes(row.workspaceId)) {
      batch.workspaceIds.push(row.workspaceId);
    }
  }
  return [...batches.values()];
};

/**
 * The dedupe keys the batch's obligations still warrant, recomputed from rows
 * re-read inside the emitting transaction. The page was read from the root
 * handle and several organizations may have been emitted since: an obligation
 * acknowledged, completed, reassigned or re-dated in that window must not
 * raise a warning, because nothing resolves a stored signal once its condition
 * clears. Bounded by the page, and read through the same projection and join
 * as the page so the two cannot disagree about what qualifies.
 */
const stillWarrantedKeys = async (
  tx: Transaction,
  batch: OrganizationBatch,
  now: Date,
): Promise<Set<string>> => {
  const rows = await tx
    .select(obligationFactsColumns)
    .from(workObligations)
    .innerJoin(entities, obligationEntityJoin)
    .where(
      and(
        inArray(workObligations.entityId, batch.obligationEntityIds),
        inArray(workObligations.status, [...OPEN_WORK_OBLIGATION_STATUSES]),
      ),
    );
  const assignedAt = await loadAssignedAt(tx, rows);
  return new Set(
    rows.flatMap((row) =>
      workAttentionSignals(toObligation(row, assignedAt), now).map(
        ({ dedupeKey }) => dedupeKey,
      ),
    ),
  );
};

/**
 * Observe one bounded page of governed work and emit the attention signals it
 * warrants, one `scout_runs` row per organization the page touched, including
 * the organizations the page found nothing to warn about.
 *
 * Nothing here resolves a signal whose condition has cleared: the signals model
 * only transitions rows through an authenticated member's accept, dismiss or
 * snooze, so an acknowledged obligation's signal stays in the Inbox until
 * somebody answers it.
 */
export const runWorkAttentionScout = async ({
  cursor,
  now = new Date(),
  dependencies = DEFAULT_WORK_ATTENTION_SCOUT_DEPENDENCIES,
}: RunWorkAttentionScoutArgs): Promise<RunWorkAttentionScoutResult> => {
  const { db, createScopedDb } = dependencies;
  const rows = await loadObligationPage(db, cursor, now);
  const lastRow = rows.at(-1);
  if (!lastRow) {
    return {
      scanned: 0,
      emitted: 0,
      inserted: 0,
      organizations: 0,
      organizationsWithoutMember: 0,
      nextCursor: null,
    };
  }

  const assignedAt = await loadAssignedAt(db, rows);
  const batches = groupByOrganization(rows, assignedAt, now);
  const actors = await loadScoutActors(
    db,
    batches.map((batch) => batch.organizationId),
  );

  let emitted = 0;
  let inserted = 0;
  let organizations = 0;
  let organizationsWithoutMember = 0;
  for (const batch of batches) {
    const userId = actors.get(batch.organizationId);
    if (!userId) {
      organizationsWithoutMember += 1;
      continue;
    }
    const scopedDb = createScopedDb({
      organizationId: batch.organizationId,
      userId,
      workspaceIds: batch.workspaceIds,
    });
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- per-organization scoped connection; one run row and emit transaction per tenant
    const result = await runScout({
      db: scopedDb,
      organizationId: batch.organizationId,
      scoutKey: SCOUT_KEY.WORK_ATTENTION,
      observe: () => batch.signals,
      screen: async (tx, proposed) => {
        const warranted = await stillWarrantedKeys(tx, batch, now);
        return proposed.filter(({ dedupeKey }) => warranted.has(dedupeKey));
      },
    });
    emitted += result.emittedCount;
    inserted += result.insertedIds.length;
    organizations += 1;
  }

  return {
    scanned: rows.length,
    emitted,
    inserted,
    organizations,
    organizationsWithoutMember,
    nextCursor: lastRow.entityId,
  };
};
