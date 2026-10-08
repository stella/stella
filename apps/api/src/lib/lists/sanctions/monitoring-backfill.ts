import { panic } from "better-result";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  sanctionsMonitoringBackfills,
  sanctionsSources,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
  createBackgroundAuditRecorder,
  recordAuditGroups,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { SANCTIONS_MONITORING_BACKFILL_TRANSITIONS } from "@/api/lib/db/transition-specs";
import {
  defineScopedTransitions,
  transitionBatch,
  transitionUpsertBatch,
} from "@/api/lib/db/transitions";
import {
  commitSanctionsMonitoringBatch,
  createMonitoringBatchAuditCounts,
  addMonitoringBatchAuditCounts,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { SANCTIONS_MARK_LEASE_MS } from "@/api/lib/lists/sanctions/monitoring-drain";
import { lockSanctionsMonitoring } from "@/api/lib/lists/sanctions/monitoring-lock";
import { prepareMonitoringContacts } from "@/api/lib/lists/sanctions/monitoring-screen";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";

type BackfillTransitionOptions = {
  tx: Transaction;
  job: typeof sanctionsMonitoringBackfills.$inferSelect;
  to: (typeof sanctionsMonitoringBackfills.$inferSelect)["status"];
  set: Pick<
    typeof sanctionsMonitoringBackfills.$inferInsert,
    "cursorContactId" | "scheduledAt" | "editionId"
  >;
  auditCounts?: ReturnType<typeof createMonitoringBatchAuditCounts>;
  nextGeneration?: (typeof sanctionsMonitoringBackfills.$inferSelect)["generation"];
};

const monitoringBackfillAuditBindings = (
  job: typeof sanctionsMonitoringBackfills.$inferSelect,
) => {
  const actor = TENANT_SYSTEM_ACTOR.sanctionsMonitoringBackfill;
  return {
    organizationId: job.organizationId,
    workspaceId: null,
    userId: actor,
    execution: {
      performer: {
        type: "service",
        id: actor,
        name: "Sanctions monitoring backfill",
      },
      trigger: { type: "system", source: actor, sourceId: job.sourceId },
    } as const,
  };
};

const BACKFILL_BATCH_TRANSITIONS = defineScopedTransitions({
  table: sanctionsMonitoringBackfills,
  key: "sourceId",
  scope: ["organizationId"],
  stateColumn: "status",
  edges: SANCTIONS_MONITORING_BACKFILL_TRANSITIONS.edges,
  initial: ["pending"],
  sameStateUpsert: "ignore",
});

/** The enqueue statement already locks each full key and advances its generation. */
export const resetMonitoringBackfills = async (
  tx: Transaction,
  jobs: readonly (typeof sanctionsMonitoringBackfills.$inferSelect)[],
) =>
  await transitionUpsertBatch({
    tx,
    spec: BACKFILL_BATCH_TRANSITIONS,
    values: jobs.map((job) => ({ ...job, status: "pending" as const })),
    recordTransitionAuditEvent: async (auditTx, rows) => {
      const byIdentity = new Map(
        jobs.map((job) => [
          JSON.stringify([job.organizationId, job.sourceId]),
          job,
        ]),
      );
      await recordAuditGroups({
        tx: auditTx,
        groups: rows.map(({ identity }) => {
          const job =
            byIdentity.get(
              JSON.stringify([
                identity["organizationId"],
                identity["sourceId"],
              ]),
            ) ?? panic("Backfill audit identity was not enqueued");
          return {
            bindings: monitoringBackfillAuditBindings(job),
            events: [
              {
                action: AUDIT_ACTION.UPDATE,
                resourceType: AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY,
                resourceId: CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
                changes: { status: { old: job.status, new: "pending" } },
                metadata: {
                  sourceId: job.sourceId,
                  kind: "sanctions-monitoring-backfill",
                },
              },
            ],
          };
        }),
      });
    },
  });

const transitionMonitoringBackfill = async ({
  tx,
  job,
  to,
  set,
  nextGeneration,
  auditCounts,
}: BackfillTransitionOptions) => {
  const recordAuditEvent = createBackgroundAuditRecorder(
    monitoringBackfillAuditBindings(job),
  );
  return await transitionBatch({
    tx,
    spec: SANCTIONS_MONITORING_BACKFILL_TRANSITIONS,
    ids: [job.sourceId],
    scope: { organizationId: job.organizationId },
    options: {
      from: [job.status],
      to,
      fence: job.generation,
      set,
      ...(nextGeneration === undefined ? {} : { nextFence: nextGeneration }),
    },
    recordTransitionAuditEvent: async (auditTx, rows) => {
      const events = rows
        .filter(
          (row) =>
            row.status !== job.status ||
            Object.values(auditCounts ?? {}).some((count) => count > 0),
        )
        .map((row) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY,
          resourceId: CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
          ...(row.status === job.status
            ? {}
            : { changes: { status: { old: job.status, new: row.status } } }),
          metadata: {
            sourceId: job.sourceId,
            kind: "sanctions-monitoring-backfill",
            ...auditCounts,
          },
        }));
      if (events.length > 0) {
        await recordAuditEvent(auditTx, events);
      }
    },
  });
};

type MonitoringBackfillOptions = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  sourceId: string;
  now: Date;
  signal: AbortSignal;
};

export const advanceSanctionsMonitoringBackfill = async ({
  db,
  organizationId,
  sourceId,
  now,
  signal,
}: MonitoringBackfillOptions) => {
  const source =
    sanctionsSourceIds().find((id) => id === sourceId) ??
    panic("Unknown monitoring source");
  const leaseExpiresAt = new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS);
  const claim = await db(async (tx) => {
    const job = (
      await tx
        .select()
        .from(sanctionsMonitoringBackfills)
        .where(
          and(
            eq(sanctionsMonitoringBackfills.organizationId, organizationId),
            eq(sanctionsMonitoringBackfills.sourceId, source),
            eq(sanctionsMonitoringBackfills.status, "pending"),
            sql`${sanctionsMonitoringBackfills.scheduledAt} <= ${now}::timestamptz`,
          ),
        )
        .limit(1)
        .for("no key update", { skipLocked: true })
    ).at(0);
    if (job === undefined) {
      return null;
    }
    await transitionMonitoringBackfill({
      tx,
      job,
      to: "pending",
      set: { scheduledAt: leaseExpiresAt },
    });
    const page = await readCursorPage(
      tx
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, organizationId),
            job.cursorContactId === null
              ? undefined
              : gt(contacts.id, job.cursorContactId),
          ),
        )
        .orderBy(asc(contacts.id)),
      {
        limit: SANCTIONS_MONITORING_BATCH_SIZE,
        cursorForItem: ({ id }) => id,
      },
    );
    return { job, contactRows: page.items, hasMore: page.nextCursor !== null };
  });
  if (claim === null) {
    return "idle" as const;
  }
  signal.throwIfAborted();
  const prepared = await prepareMonitoringContacts({
    db,
    contactRows: claim.contactRows,
    now,
  });
  const results = prepared.map(({ contactId, contactFingerprint, lists }) => ({
    contactId,
    contactFingerprint,
    outcome:
      lists.find((list) => list.source === source) ??
      panic("Monitoring outcome missing"),
  }));
  signal.throwIfAborted();
  const checkpoint: {
    claim: typeof claim;
    transition: "hold" | "advance";
    auditCounts: ReturnType<typeof createMonitoringBatchAuditCounts>;
  } = {
    claim,
    transition: "hold",
    auditCounts: createMonitoringBatchAuditCounts(),
  };
  return await commitReplaySafeIngestionBatch({
    runInTransaction: db,
    items: results,
    checkpoint,
    persistItems: async (tx, items) => {
      await lockSanctionsMonitoring(tx, organizationId);
      checkpoint.transition = "hold";
      checkpoint.auditCounts = createMonitoringBatchAuditCounts();
      const job = (
        await tx
          .select()
          .from(sanctionsMonitoringBackfills)
          .where(
            and(
              eq(sanctionsMonitoringBackfills.organizationId, organizationId),
              eq(sanctionsMonitoringBackfills.sourceId, source),
              eq(sanctionsMonitoringBackfills.generation, claim.job.generation),
              eq(sanctionsMonitoringBackfills.status, "pending"),
              sql`${sanctionsMonitoringBackfills.scheduledAt} = ${leaseExpiresAt}::timestamptz`,
            ),
          )
          .limit(1)
          .for("no key update")
      ).at(0);
      if (job === undefined) {
        return "superseded" as const;
      }
      const current =
        (
          await tx
            .select({ editionId: sanctionsSources.activeEditionId })
            .from(sanctionsSources)
            .where(eq(sanctionsSources.id, source))
            .limit(1)
        ).at(0) ?? panic("Backfill source missing");
      if (current.editionId !== claim.job.editionId) {
        await transitionMonitoringBackfill({
          tx,
          job,
          to: "pending",
          nextGeneration: job.generation + 1n,
          set: {
            editionId: current.editionId,
            cursorContactId: null,
            scheduledAt: now,
          },
        });
        return "superseded" as const;
      }
      const terminal = await commitSanctionsMonitoringBatch({
        db: async (run) => await run(tx),
        organizationId,
        source,
        results: items,
        recordAuditEvent: (_auditTx, event) => {
          addMonitoringBatchAuditCounts(checkpoint.auditCounts, event);
        },
      });
      if (terminal.length !== items.length) {
        return "retry" as const;
      }
      checkpoint.transition = "advance";
      return "advanced" as const;
    },
    persistCheckpoint: async (
      tx,
      { claim: { job, contactRows, hasMore }, transition, auditCounts },
    ) => {
      if (transition === "hold") {
        return;
      }
      // persistItems holds this row lock after checking both generation and lease; the owner also fences the generation.
      await transitionMonitoringBackfill({
        tx,
        job,
        auditCounts,
        to: hasMore ? "pending" : "complete",
        set: {
          cursorContactId: contactRows.at(-1)?.id ?? job.cursorContactId,
          scheduledAt: now,
        },
      });
    },
  });
};
