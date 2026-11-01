import { panic } from "better-result";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import {
  sanctionsEditionFanouts,
  sanctionsMonitoringBackfills,
  sanctionsOrganizationMarks,
  sanctionsSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import {
  permitsLifecycleMove,
  transitionLifecycleBatch,
} from "@/api/lib/db/transitions";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import type { SanctionsSourceFreshness } from "@/api/lib/lists/sanctions/freshness";
import { resetMonitoringBackfills } from "@/api/lib/lists/sanctions/monitoring-backfill";
import { SANCTIONS_EDITION_FANOUT_TRANSITIONS } from "@/api/lib/lists/sanctions/monitoring-transition-specs";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

const ORGANIZATION_FANOUT_BATCH_SIZE = 100;

// These system transactions only turn durable activation/organization requests into tenant jobs.
// They never read contact data. A tenant worker executes the contact page under stella/RLS.
type FanoutPageOptions = {
  db: Pick<SchedulerDb, "transaction">;
  recordTransitionAuditEvent: (
    tx: Parameters<Parameters<SchedulerDb["transaction"]>[0]>[0],
    transitions: number,
    fanned: number,
  ) => void | Promise<void>;
};

const fanOutEditionPage = async ({
  db,
  recordTransitionAuditEvent,
}: FanoutPageOptions) =>
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
        .where(eq(sanctionsEditionFanouts.status, "pending"))
        .orderBy(asc(sanctionsEditionFanouts.sourceId))
        .limit(1)
        .for("no key update", { skipLocked: true })
    ).at(0);
    if (fanout === undefined) {
      await tx.execute(sql`SELECT set_config('role', ${owner.role}, true)`);
      return { type: "idle", fanned: 0 } as const;
    }
    // Keep the ingestion row fence while the scheduler owner enqueues tenant jobs.
    // Ingestion has no tenant privileges; role changes share this atomic transaction.
    await tx.execute(sql`SELECT set_config('role', ${owner.role}, true)`);
    const page = await readCursorPage(
      tx
        .select({ id: organization.id })
        .from(organization)
        .where(
          fanout.cursorOrganizationId === null
            ? undefined
            : gt(organization.id, fanout.cursorOrganizationId),
        )
        .orderBy(asc(organization.id)),
      {
        limit: ORGANIZATION_FANOUT_BATCH_SIZE,
        cursorForItem: ({ id }) => id,
      },
    );
    const orgs = page.items;
    const organizations = orgs.map(({ id }) => ({
      id: brandPersistedOrganizationId(id),
    }));
    if (orgs.length > 0) {
      const jobs = await tx
        .insert(sanctionsMonitoringBackfills)
        .values(
          organizations.map(({ id }) => ({
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
            scheduledAt: sql`now()`,
            generation: sql`${sanctionsMonitoringBackfills.generation} + 1`,
          },
        })
        .returning();
      await resetMonitoringBackfills(tx, jobs);
    }
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    const freshnessMove = {
      from: [fanout.freshnessStatus],
      to: fanout.freshnessStatus,
    };
    if (
      !permitsLifecycleMove(
        SANCTIONS_EDITION_FANOUT_TRANSITIONS.graphs.freshnessStatus,
        freshnessMove,
      )
    ) {
      panic("Fanout progress must preserve its freshness state");
    }
    await transitionLifecycleBatch({
      tx,
      spec: SANCTIONS_EDITION_FANOUT_TRANSITIONS,
      ids: [fanout.sourceId],
      moves: {
        status: {
          from: ["pending"],
          to: page.nextCursor !== null ? "pending" : "complete",
        },
        freshnessStatus: freshnessMove,
      },
      set: {
        cursorOrganizationId:
          organizations.at(-1)?.id ?? fanout.cursorOrganizationId,
      },
      recordTransitionAuditEvent: async (auditTx, { ids }) => {
        await auditTx.execute(
          sql`SELECT set_config('role', ${owner.role}, true)`,
        );
        await recordTransitionAuditEvent(auditTx, ids.length, orgs.length);
      },
    });
    await tx.execute(sql`SELECT set_config('role', ${owner.role}, true)`);
    return { type: "transitioned", fanned: orgs.length } as const;
  });

const consumeOrganizationRequest = async (
  db: Pick<SchedulerDb, "transaction">,
) =>
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
      const jobs = await tx
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
            scheduledAt: sql`now()`,
            generation: sql`${sanctionsMonitoringBackfills.generation} + 1`,
          },
        })
        .returning();
      await resetMonitoringBackfills(tx, jobs);
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

const queueFreshnessTransitions = async (
  db: Pick<SchedulerDb, "transaction">,
  now: Date,
  recordTransitionAuditEvent: (count: number) => void,
) =>
  await db.transaction(async (tx) => {
    const owner =
      (await tx.execute<{ role: string }>(sql`SELECT current_user AS role`)).at(
        0,
      ) ?? panic("Scheduler role missing");
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    const rows = await readSanctionsFreshness({
      now,
      db: async (run) => await run(tx),
    });
    const inserted = await tx
      .insert(sanctionsEditionFanouts)
      .values(
        rows.map(({ source, status, edition }) => ({
          sourceId: source,
          freshnessStatus: status,
          editionId: edition?.id ?? null,
        })),
      )
      .onConflictDoNothing()
      .returning({ sourceId: sanctionsEditionFanouts.sourceId });
    const fanouts = await tx
      .select()
      .from(sanctionsEditionFanouts)
      .where(
        inArray(
          sanctionsEditionFanouts.sourceId,
          rows.map(({ source }) => source),
        ),
      )
      .orderBy(asc(sanctionsEditionFanouts.sourceId))
      .limit(sanctionsSourceIds().length)
      .for("no key update");
    const insertedIds = new Set(inserted.map(({ sourceId }) => sourceId));
    const currentBySource = new Map(
      fanouts.map((fanout) => [fanout.sourceId, fanout]),
    );
    const changed = rows.filter(({ source, status, edition }) => {
      const current =
        currentBySource.get(source) ?? panic("Freshness fanout missing");
      return (
        insertedIds.has(source) ||
        (current.editionId === (edition?.id ?? null) &&
          current.freshnessStatus !== status)
      );
    });
    if (changed.length > 0) {
      const changesByFreshness = {
        fresh: changed.filter(({ status }) => status === "fresh"),
        unavailable: changed.filter(({ status }) => status === "unavailable"),
      } satisfies Record<SanctionsSourceFreshness["status"], typeof changed>;
      await transitionLifecycleBatch({
        tx,
        spec: SANCTIONS_EDITION_FANOUT_TRANSITIONS,
        ids: changesByFreshness.fresh.map(({ source }) => source),
        moves: {
          status: { from: ["pending", "complete"], to: "pending" },
          freshnessStatus: {
            from: ["unknown", "fresh", "unavailable"],
            to: "fresh",
          },
        },
        set: { cursorOrganizationId: null },
        recordTransitionAuditEvent: async (_auditTx, { ids }) => {
          recordTransitionAuditEvent(ids.length);
          await Promise.resolve();
        },
      });
      await transitionLifecycleBatch({
        tx,
        spec: SANCTIONS_EDITION_FANOUT_TRANSITIONS,
        ids: changesByFreshness.unavailable.map(({ source }) => source),
        moves: {
          status: { from: ["pending", "complete"], to: "pending" },
          freshnessStatus: {
            from: ["unknown", "fresh", "unavailable"],
            to: "unavailable",
          },
        },
        set: { cursorOrganizationId: null },
        recordTransitionAuditEvent: async (_auditTx, { ids }) => {
          recordTransitionAuditEvent(ids.length);
          await Promise.resolve();
        },
      });
    }
    // SET LOCAL survives a successful savepoint; nested scheduler calls retain their owner role.
    await tx.execute(sql`SELECT set_config('role', ${owner.role}, true)`);
    return changed.length;
  });

type QueueSanctionsMonitoringBackfillsOptions = {
  db: SchedulerDb;
  now: Date;
  runId: SafeId<"schedulerJobRun">;
};

/** Bounded system discovery/queue writes; contact processing uses the scoped tenant worker. */
export const queueSanctionsMonitoringBackfills = async ({
  db,
  now,
  runId,
}: QueueSanctionsMonitoringBackfillsOptions) =>
  await db.transaction(async (tx) => {
    // One outer transaction makes the run's aggregated audit inseparable from every nested transition.
    let transitions = 0;
    const recordTransitionAuditEvent = (count: number) => {
      transitions += count;
    };
    const freshnessQueued = await queueFreshnessTransitions(
      tx,
      now,
      recordTransitionAuditEvent,
    );
    const requested = await consumeOrganizationRequest(tx);
    const outcome = await fanOutEditionPage({
      db: tx,
      recordTransitionAuditEvent: (_auditTx, count) =>
        recordTransitionAuditEvent(count),
    });
    await recordSystemAudit(tx, "system:sanctions-monitoring-fanout", {
      subject: runId,
      counts: {
        freshnessQueued,
        requestedOrganizations: requested,
        fannedOrganizations: outcome.fanned,
        transitions,
      },
    });
    return { requested, fanned: outcome.fanned };
  });
