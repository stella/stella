import { panic } from "better-result";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  contacts,
  sanctionsMonitoringBackfills,
  sanctionsSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  commitSanctionsMonitoringBatch,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { SANCTIONS_MARK_LEASE_MS } from "@/api/lib/lists/sanctions/monitoring-drain";
import { prepareMonitoringContacts } from "@/api/lib/lists/sanctions/monitoring-screen";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { commitReplaySafeIngestionBatch } from "@/api/lib/replay-safe-ingestion";

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
            eq(sanctionsMonitoringBackfills.state, "pending"),
            sql`${sanctionsMonitoringBackfills.scheduledAt} <= ${now}::timestamptz`,
          ),
        )
        .limit(1)
        .for("no key update", { skipLocked: true })
    ).at(0);
    if (job === undefined) {
      return null;
    }
    await tx
      .update(sanctionsMonitoringBackfills)
      .set({ scheduledAt: leaseExpiresAt })
      .where(
        and(
          eq(sanctionsMonitoringBackfills.organizationId, organizationId),
          eq(sanctionsMonitoringBackfills.sourceId, source),
        ),
      );
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
              eq(sanctionsMonitoringBackfills.state, "pending"),
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
        await tx
          .update(sanctionsMonitoringBackfills)
          .set({
            editionId: current.editionId,
            cursorContactId: null,
            generation: sql`${sanctionsMonitoringBackfills.generation} + 1`,
            scheduledAt: now,
          })
          .where(
            and(
              eq(sanctionsMonitoringBackfills.organizationId, organizationId),
              eq(sanctionsMonitoringBackfills.sourceId, source),
            ),
          );
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
      await tx
        .update(sanctionsMonitoringBackfills)
        .set({
          cursorContactId: contactRows.at(-1)?.id ?? job.cursorContactId,
          state:
            contactRows.length < SANCTIONS_MONITORING_BATCH_SIZE
              ? "complete"
              : "pending",
          scheduledAt: now,
        })
        .where(
          and(
            eq(sanctionsMonitoringBackfills.organizationId, organizationId),
            eq(sanctionsMonitoringBackfills.sourceId, source),
            eq(sanctionsMonitoringBackfills.generation, job.generation),
            sql`${sanctionsMonitoringBackfills.scheduledAt} = ${leaseExpiresAt}::timestamptz`,
            eq(sanctionsMonitoringBackfills.state, "pending"),
          ),
        );
    },
  });
};
