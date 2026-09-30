import { panic } from "better-result";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  sanctionsEditionFanouts,
  sanctionsMonitoringBackfills,
  sanctionsOrganizationMarks,
  sanctionsSources,
} from "@/api/db/schema";
import { createIngestionDb } from "@/api/db/scoped";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import type { SchedulerDb } from "@/api/lib/scheduler/types";

const ORGANIZATION_FANOUT_BATCH_SIZE = 100;

// These system transactions only turn durable activation/organization requests into tenant jobs.
// They never read contact data. A tenant worker executes the contact page under stella/RLS.
const fanOutEditionPage = async (db: SchedulerDb) =>
  await db.transaction(async (tx) => {
    const owner = (
      await tx.execute<{ role: string }>(sql`SELECT current_user AS role`)
    ).at(0);
    if (owner === undefined) {
      panic("Scheduler role missing");
    }
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
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
    // Keep the ingestion row fence while the scheduler owner enqueues tenant jobs.
    // Ingestion has no tenant privileges; role changes share this atomic transaction.
    await tx.execute(sql`SELECT set_config('role', ${owner.role}, true)`);
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
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
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
    const owner =
      (await tx.execute<{ role: string }>(sql`SELECT current_user AS role`)).at(
        0,
      ) ?? panic("Scheduler role missing");
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    const sources = await tx
      .select({
        sourceId: sanctionsSources.id,
        editionId: sanctionsSources.activeEditionId,
      })
      .from(sanctionsSources)
      .where(inArray(sanctionsSources.id, sanctionsSourceIds()))
      .orderBy(asc(sanctionsSources.id))
      .limit(sanctionsSourceIds().length);
    await tx.execute(sql`SELECT set_config('role', ${owner.role}, true)`);
    if (sources.length > 0) {
      await tx
        .insert(sanctionsMonitoringBackfills)
        .values(
          sources.map(({ sourceId, editionId }) => ({
            sourceId,
            editionId,
            organizationId: mark.organizationId,
          })),
        )
        .onConflictDoUpdate({
          target: [
            sanctionsMonitoringBackfills.organizationId,
            sanctionsMonitoringBackfills.sourceId,
          ],
          set: {
            editionId: sql`excluded.edition_id`,
            cursorContactId: null,
            state: "pending",
            scheduledAt: sql`now()`,
            generation: sql`${sanctionsMonitoringBackfills.generation} + 1`,
          },
        });
    }
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

const queueFreshnessTransitions = async (db: SchedulerDb, now: Date) => {
  const ingestionDb = createIngestionDb(db);
  await ingestionDb(async (tx) => {
    const rows = await readSanctionsFreshness({
      now,
      db: async (run) => await run(tx),
    });
    await tx.execute(sql`
    INSERT INTO sanctions_edition_fanouts AS fanout (source_id, edition_id, freshness_status)
    SELECT observed.source, observed."editionId", observed.status
    FROM jsonb_to_recordset(${JSON.stringify(rows.map(({ source, status, edition }) => ({ source, status, editionId: edition?.id ?? null })))}::text::jsonb)
      AS observed(source text, status text, "editionId" uuid)
    ON CONFLICT (source_id) DO UPDATE
      SET freshness_status = excluded.freshness_status, state = 'pending', cursor_organization_id = NULL
      WHERE fanout.edition_id IS NOT DISTINCT FROM excluded.edition_id
        AND fanout.freshness_status IS DISTINCT FROM excluded.freshness_status
  `);
  });
};

type QueueSanctionsMonitoringBackfillsOptions = { db: SchedulerDb; now: Date };

/** Bounded system discovery/queue writes; contact processing uses the scoped tenant worker. */
export const queueSanctionsMonitoringBackfills = async ({
  db,
  now,
}: QueueSanctionsMonitoringBackfillsOptions) => {
  await queueFreshnessTransitions(db, now);
  const requested = await consumeOrganizationRequest(db);
  const fanned = await fanOutEditionPage(db);
  return { requested, fanned };
};
