import { and, asc, eq, gt, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  sanctionsEditionFanouts,
  sanctionsMonitoringBackfills,
  sanctionsOrganizationMarks,
} from "@/api/db/schema";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { advanceSanctionsMonitoringBackfill } from "@/api/lib/lists/sanctions/monitoring-backfill";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";
import type { SchedulerDb, SchedulerTask } from "@/api/lib/scheduler/types";

export const BACKFILL_SANCTIONS_MONITORING_TASK =
  "sanctions.backfillMonitoring" as const;
const ORGANIZATION_FANOUT_BATCH_SIZE = 100;

// These system transactions only turn durable activation/organization requests into tenant jobs.
// They never read contact data. A tenant worker executes the contact page under stella/RLS.
const fanOutEditionPage = async (db: SchedulerDb) =>
  await db.transaction(async (tx) => {
    const fanout = (
      await tx
        .select()
        .from(sanctionsEditionFanouts)
        .where(eq(sanctionsEditionFanouts.state, "pending"))
        .orderBy(asc(sanctionsEditionFanouts.sourceId))
        .limit(1)
        .for("no key update", { skipLocked: true })
    ).at(0);
    if (fanout === undefined) {
      return 0;
    }
    const orgs = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(
        fanout.cursorOrganizationId === null
          ? undefined
          : gt(organization.id, fanout.cursorOrganizationId),
      )
      .orderBy(asc(organization.id))
      .limit(ORGANIZATION_FANOUT_BATCH_SIZE);
    if (orgs.length > 0) {
      await tx
        .insert(sanctionsMonitoringBackfills)
        .values(
          orgs.map(({ id }) => ({
            organizationId: id,
            sourceId: fanout.sourceId,
            editionId: fanout.editionId,
          })),
        )
        .onConflictDoUpdate({
          target: [
            sanctionsMonitoringBackfills.organizationId,
            sanctionsMonitoringBackfills.sourceId,
          ],
          set: {
            editionId: fanout.editionId,
            cursorContactId: null,
            state: "pending",
            scheduledAt: sql`now()`,
            generation: sql`${sanctionsMonitoringBackfills.generation} + 1`,
          },
        });
    }
    await tx
      .update(sanctionsEditionFanouts)
      .set({
        cursorOrganizationId: orgs.at(-1)?.id ?? fanout.cursorOrganizationId,
        state:
          orgs.length < ORGANIZATION_FANOUT_BATCH_SIZE ? "complete" : "pending",
      })
      .where(eq(sanctionsEditionFanouts.sourceId, fanout.sourceId));
    return orgs.length;
  });

const consumeOrganizationRequest = async (db: SchedulerDb) =>
  await db.transaction(async (tx) => {
    // Read without a lock; lock jobs before the mark so settings-trigger writers cannot form a cycle.
    const mark = (
      await tx
        .select()
        .from(sanctionsOrganizationMarks)
        .orderBy(asc(sanctionsOrganizationMarks.organizationId))
        .limit(1)
    ).at(0);
    if (mark === undefined) {
      return 0;
    }
    await tx.execute(sql`
    INSERT INTO sanctions_monitoring_backfills AS job (organization_id, source_id, edition_id)
    SELECT ${mark.organizationId}, id, active_edition_id FROM sanctions_sources WHERE id = ANY(${sql.param(sanctionsSourceIds())}::text[]) ORDER BY id
    ON CONFLICT (organization_id, source_id) DO UPDATE
      SET edition_id = excluded.edition_id, cursor_contact_id = NULL, state = 'pending',
        scheduled_at = now(), generation = job.generation + 1
  `);
    await tx
      .delete(sanctionsOrganizationMarks)
      .where(
        and(
          eq(sanctionsOrganizationMarks.organizationId, mark.organizationId),
          eq(sanctionsOrganizationMarks.generation, mark.generation),
        ),
      );
    return 1;
  });

const queueFreshnessTransitions = async (db: SchedulerDb) => {
  const rows = await readSanctionsFreshness({
    db: async (run) => await db.transaction(run),
  });
  await db.execute(sql`
    INSERT INTO sanctions_edition_fanouts AS fanout (source_id, edition_id, freshness_status)
    SELECT observed.source, observed."editionId", observed.status
    FROM jsonb_to_recordset(${JSON.stringify(rows.map(({ source, status, edition }) => ({ source, status, editionId: edition?.id ?? null })))}::text::jsonb)
      AS observed(source text, status text, "editionId" uuid)
    ON CONFLICT (source_id) DO UPDATE
      SET freshness_status = excluded.freshness_status, state = 'pending', cursor_organization_id = NULL
      WHERE fanout.edition_id IS NOT DISTINCT FROM excluded.edition_id
        AND fanout.freshness_status IS DISTINCT FROM excluded.freshness_status
  `);
};

export const backfillSanctionsMonitoringTask: SchedulerTask = async ({
  db,
  signal,
  logger,
  scheduleContinuation,
}) => {
  signal.throwIfAborted();
  await queueFreshnessTransitions(db);
  const requested = await consumeOrganizationRequest(db);
  const fanned = await fanOutEditionPage(db);
  signal.throwIfAborted();
  const now = new Date();
  const pending = (
    await db
      .select({
        organizationId: sanctionsMonitoringBackfills.organizationId,
        sourceId: sanctionsMonitoringBackfills.sourceId,
      })
      .from(sanctionsMonitoringBackfills)
      .where(
        and(
          eq(sanctionsMonitoringBackfills.state, "pending"),
          sql`${sanctionsMonitoringBackfills.scheduledAt} <= ${now}::timestamptz`,
        ),
      )
      .orderBy(
        asc(sanctionsMonitoringBackfills.scheduledAt),
        asc(sanctionsMonitoringBackfills.organizationId),
        asc(sanctionsMonitoringBackfills.sourceId),
      )
      .limit(1)
  ).at(0);
  const outcome =
    pending === undefined
      ? "idle"
      : await advanceSanctionsMonitoringBackfill({
          db: createRootScopedDb({
            organizationId: pending.organizationId,
            userId: null,
            workspaceIds: [],
          }),
          organizationId: pending.organizationId,
          sourceId: pending.sourceId,
          now,
          signal,
        });
  logger.info("scheduler.sanctions_monitoring_backfill", {
    "sanctions.organization_requests": requested,
    "sanctions.organizations_fanned": fanned,
    "sanctions.outcome": outcome,
  });
  if (
    requested > 0 ||
    fanned > 0 ||
    outcome === "advanced" ||
    outcome === "superseded"
  ) {
    scheduleContinuation(new Date(now.getTime() + 1000));
  }
};
