import { panic } from "better-result";
import { and, asc, eq, gt, inArray, isNull, lte, max, or } from "drizzle-orm";

import { SCOUT_KEY } from "@stll/api-contract/signals";
import type { OpenWorkObligationStatus } from "@stll/api-contract/signals";
import { WORK_OBLIGATION_STATUS } from "@stll/api-contract/workflow-status";
import type { WorkObligationStatus } from "@stll/api-contract/workflow-status";
import { DAY_IN_MS, parseTimeZoneId } from "@stll/time";
import type { TimeZoneId } from "@stll/time";

import { member as organizationMembers, user } from "@/api/db/auth-schema";
import type { rootDb, Transaction } from "@/api/db/root";
import {
  entities,
  featureEnrolments,
  organizationSettings,
  WORK_OBLIGATION_EVENT_TYPE,
  workObligationEvents,
  workObligations,
  workspaces,
} from "@/api/db/schema";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { isBackgroundFeatureEnabled } from "@/api/lib/feature-access/background";
import { LIMITS } from "@/api/lib/limits";
import { logger } from "@/api/lib/observability/logger";
import {
  effectiveOrganizationTimeZone,
  organizationTimeZoneColumns,
  readOrganizationTimeZone,
} from "@/api/lib/organization-time-zone";
import type { createRootScopedDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
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

/**
 * The two database handles the sweep needs: the scheduler hands in its own
 * connection and the scoped-transaction factory; integration tests inject both.
 */
export type WorkAttentionScoutDependencies = {
  db: typeof rootDb;
  createScopedDb: typeof createRootScopedDb;
};

export type RunWorkAttentionScoutArgs = {
  /** Keyset position from the previous tick; `null` starts a fresh cycle. */
  cursor: SafeId<"entity"> | null;
  now?: Date;
  dependencies: WorkAttentionScoutDependencies;
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
  timeZone: TimeZoneId | null;
  practiceJurisdictions: PracticeJurisdiction[] | null;
};

/**
 * The zone whose day is the latest on Earth (UTC+14). A deadline due by the
 * risk cutoff in any organization's zone is due by it here, so the page
 * predicate can stay one shared bound; the scout then judges each obligation
 * on its own organization's day.
 */
const LATEST_DAY_ZONE =
  parseTimeZoneId("Pacific/Kiritimati") ??
  panic("Runtime does not know Pacific/Kiritimati");

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
      ...organizationTimeZoneColumns,
    })
    .from(workObligations)
    .innerJoin(entities, obligationEntityJoin)
    .innerJoin(workspaces, eq(workspaces.id, workObligations.workspaceId))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, workObligations.ownerUserId),
        eq(organizationMembers.organizationId, workspaces.organizationId),
      ),
    )
    .innerJoin(
      user,
      and(
        eq(user.id, organizationMembers.userId),
        eq(user.emailVerified, true),
        isNull(user.deletedAt),
      ),
    )
    .innerJoin(
      featureEnrolments,
      and(
        eq(featureEnrolments.userId, organizationMembers.userId),
        eq(
          featureEnrolments.organizationId,
          organizationMembers.organizationId,
        ),
        eq(featureEnrolments.featureId, "signals"),
      ),
    )
    .leftJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, workspaces.organizationId),
    )
    .where(
      and(
        inArray(workObligations.status, [...OPEN_WORK_OBLIGATION_STATUSES]),
        or(
          eq(
            workObligations.status,
            WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
          ),
          lte(
            workObligations.hardDeadlineDate,
            workAttentionToday(riskCutoff, LATEST_DAY_ZONE),
          ),
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
  recipientUserId: SafeId<"user">;
  /** The organization's zone: every obligation in it is judged on its day. */
  zone: TimeZoneId;
  workspaceIds: SafeId<"workspace">[];
  /** Every scanned obligation, so the recheck reads exactly what was scanned. */
  obligationEntityIds: SafeId<"entity">[];
  signals: NewSignal[];
};

/**
 * One batch per recipient the page touched, including recipients
 * whose scanned obligations warrant nothing: their scoped census records that they were
 * scanned, which is what keeps "ran, found nothing" apart from "never ran".
 */
const groupByRecipient = (
  rows: readonly ObligationRow[],
  assignedAt: Map<SafeId<"entity">, Date>,
  now: Date,
): OrganizationBatch[] => {
  const batches = new Map<string, OrganizationBatch>();
  for (const row of rows) {
    const recipientUserId = brandPersistedUserId(
      row.ownerUserId ?? panic("Open work has no owner"),
    );
    const batchKey = `${row.organizationId}:${recipientUserId}`;
    const batch = batches.get(batchKey);
    const zone =
      batch?.zone ??
      effectiveOrganizationTimeZone({
        timeZone: row.timeZone,
        practiceJurisdictions: arrayOrEmpty(row.practiceJurisdictions),
      });
    const signals = workAttentionSignals(
      toObligation(row, assignedAt),
      now,
      zone,
    );
    if (!batch) {
      batches.set(batchKey, {
        organizationId: row.organizationId,
        recipientUserId,
        zone,
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
 * The signals the batch's obligations still warrant, recomputed from rows and
 * the organization's zone re-read inside the emitting transaction. The page was
 * read from the root handle and several organizations may have been emitted
 * since: an obligation acknowledged, completed, reassigned or re-dated, or a
 * zone change that moves the organization's day, in that window must not raise
 * a warning or carry the page's stale evidence, because nothing resolves a
 * stored signal once its condition clears. Bounded by the page, and read
 * through the same projection and join as the page so the two cannot disagree
 * about what qualifies.
 */
const stillWarrantedSignals = async (
  tx: Transaction,
  batch: OrganizationBatch,
  now: Date,
): Promise<NewSignal[]> => {
  const zone = await readOrganizationTimeZone(tx, batch.organizationId);
  const rows = await tx
    .select(obligationFactsColumns)
    .from(workObligations)
    .innerJoin(entities, obligationEntityJoin)
    .innerJoin(workspaces, eq(workspaces.id, workObligations.workspaceId))
    .innerJoin(
      organizationMembers,
      and(
        eq(organizationMembers.userId, workObligations.ownerUserId),
        eq(organizationMembers.organizationId, workspaces.organizationId),
      ),
    )
    .innerJoin(
      user,
      and(
        eq(user.id, organizationMembers.userId),
        eq(user.emailVerified, true),
        isNull(user.deletedAt),
      ),
    )
    .innerJoin(
      featureEnrolments,
      and(
        eq(featureEnrolments.userId, organizationMembers.userId),
        eq(
          featureEnrolments.organizationId,
          organizationMembers.organizationId,
        ),
        eq(featureEnrolments.featureId, "signals"),
      ),
    )
    .where(
      and(
        inArray(workObligations.entityId, batch.obligationEntityIds),
        inArray(workObligations.status, [...OPEN_WORK_OBLIGATION_STATUSES]),
      ),
    );
  const assignedAt = await loadAssignedAt(tx, rows);
  return rows.flatMap((row) =>
    workAttentionSignals(toObligation(row, assignedAt), now, zone),
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
  dependencies,
}: RunWorkAttentionScoutArgs): Promise<RunWorkAttentionScoutResult> => {
  const { db, createScopedDb } = dependencies;
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    logger.info("scout.work_attention.skipped", {
      reason: "deployment_disabled",
    });
    return {
      scanned: 0,
      emitted: 0,
      inserted: 0,
      organizations: 0,
      organizationsWithoutMember: 0,
      nextCursor: cursor,
    };
  }
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
  const batches = groupByRecipient(rows, assignedAt, now);

  let emitted = 0;
  let inserted = 0;
  const organizations = new Set<SafeId<"organization">>();
  let organizationsWithoutMember = 0;
  for (const batch of batches) {
    const userId = batch.recipientUserId;
    if (
      !(await isBackgroundFeatureEnabled({
        tx: db,
        organizationId: batch.organizationId,
        userId,
        featureId: "signals",
      }))
    ) {
      logger.info("scout.work_attention.skipped", {
        organizationId: batch.organizationId,
        reason: "recipient_not_granted",
      });
      organizationsWithoutMember += 1;
      continue;
    }
    const scopedDb = createScopedDb({
      organizationId: batch.organizationId,
      userId,
      workspaceIds: batch.workspaceIds,
    });
    // db-await-in-loop: per-recipient RLS connection; atomic census and emission for one enrolled owner
    const result = await runScout({
      db: scopedDb,
      organizationId: batch.organizationId,
      userId,
      scoutKey: SCOUT_KEY.WORK_ATTENTION,
      observe: () => batch.signals,
      screen: async (tx, proposed) => {
        if (
          !(await isBackgroundFeatureEnabled({
            tx,
            organizationId: batch.organizationId,
            userId,
            featureId: "signals",
          }))
        ) {
          return [];
        }
        const proposedKeys = new Set(
          proposed.map(({ dedupeKey }) => dedupeKey),
        );
        const warranted = await stillWarrantedSignals(tx, batch, now);
        return warranted.filter(({ dedupeKey }) => proposedKeys.has(dedupeKey));
      },
    });
    emitted += result.emittedCount;
    inserted += result.insertedIds.length;
    organizations.add(batch.organizationId);
  }

  return {
    scanned: rows.length,
    emitted,
    inserted,
    organizations: organizations.size,
    organizationsWithoutMember,
    nextCursor: lastRow.entityId,
  };
};
