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
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { SANCTIONS_MONITORING_BACKFILL_TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transitionBatch } from "@/api/lib/db/transitions";
import {
  commitSanctionsMonitoringBatch,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { SANCTIONS_MARK_LEASE_MS } from "@/api/lib/lists/sanctions/monitoring-drain";
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
  nextGeneration?: (typeof sanctionsMonitoringBackfills.$inferSelect)["generation"];
};

export const transitionMonitoringBackfill = async ({
  tx,
  job,
  to,
  set,
  nextGeneration,
}: BackfillTransitionOptions) => {
  const actor = TENANT_SYSTEM_ACTOR.sanctionsMonitoringBackfill;
  const recordAuditEvent = createBackgroundAuditRecorder({
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
    },
  });
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
        .filter((row) => row.status !== job.status)
        .map((row) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY,
          resourceId: CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
          changes: { status: { old: job.status, new: row.status } },
          metadata: {
            sourceId: job.sourceId,
            kind: "sanctions-monitoring-backfill",
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
    const contactRows = await tx
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
      .orderBy(asc(contacts.id))
      .limit(SANCTIONS_MONITORING_BATCH_SIZE);
    return { job, contactRows };
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
  const checkpoint: { claim: typeof claim; transition: "hold" | "advance" } = {
    claim,
    transition: "hold",
  };
  return await commitReplaySafeIngestionBatch({
    runInTransaction: db,
    items: results,
    checkpoint,
    persistItems: async (tx, items) => {
      checkpoint.transition = "hold";
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
      });
      if (terminal.length !== items.length) {
        return "retry" as const;
      }
      checkpoint.transition = "advance";
      return "advanced" as const;
    },
    persistCheckpoint: async (
      tx,
      { claim: { job, contactRows }, transition },
    ) => {
      if (transition === "hold") {
        return;
      }
      // persistItems holds this row lock after checking both generation and lease; the owner also fences the generation.
      await transitionMonitoringBackfill({
        tx,
        job,
        to:
          contactRows.length < SANCTIONS_MONITORING_BATCH_SIZE
            ? "complete"
            : "pending",
        set: {
          cursorContactId: contactRows.at(-1)?.id ?? job.cursorContactId,
          scheduledAt: now,
        },
      });
    },
  });
};
