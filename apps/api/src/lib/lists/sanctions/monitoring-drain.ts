import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { contacts, sanctionsContactMarks } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  commitSanctionsMonitoringBatch,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { prepareMonitoringContacts } from "@/api/lib/lists/sanctions/monitoring-screen";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";

export const SANCTIONS_MARK_LEASE_MS = 5 * 60_000;

type MonitoringDrainOptions = {
  db: ScopedDb;
  organizationId: SafeId<"organization">;
  now: Date;
  signal: AbortSignal;
};

export const drainSanctionsContactMarks = async ({
  db,
  organizationId,
  now,
  signal,
}: MonitoringDrainOptions) => {
  const leaseExpiresAt = new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS);
  const claimed = await db(async (tx) => {
    const marks = await tx
      .select()
      .from(sanctionsContactMarks)
      .where(
        and(
          eq(sanctionsContactMarks.organizationId, organizationId),
          sql`${sanctionsContactMarks.scheduledAt} <= ${now}::timestamptz`,
        ),
      )
      .orderBy(
        asc(sanctionsContactMarks.scheduledAt),
        asc(sanctionsContactMarks.contactId),
      )
      .limit(SANCTIONS_MONITORING_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (marks.length === 0) {
      return { marks, contactRows: [] };
    }
    const ids = marks.map(({ contactId }) => contactId);
    await tx
      .update(sanctionsContactMarks)
      .set({ scheduledAt: leaseExpiresAt })
      .where(
        and(
          eq(sanctionsContactMarks.organizationId, organizationId),
          inArray(sanctionsContactMarks.contactId, ids),
        ),
      );
    const contactRows = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          inArray(contacts.id, ids),
        ),
      )
      .limit(SANCTIONS_MONITORING_BATCH_SIZE);
    return { marks, contactRows };
  });
  signal.throwIfAborted();
  const prepared = await prepareMonitoringContacts({
    db,
    contactRows: claimed.contactRows,
    now,
  });
  const terminal = new Set(prepared.map(({ contactId }) => contactId));
  const sources = sanctionsSourceIds();
  // One source in flight bounds each transaction and preserves the mark until all sources finish.
  const commitSource = async (index: number): Promise<void> => {
    const source = sources.at(index);
    if (source === undefined) {
      return;
    }
    signal.throwIfAborted();
    const results = prepared.map(
      ({ contactId, contactFingerprint, lists }) => ({
        contactId,
        contactFingerprint,
        outcome:
          lists.find((list) => list.source === source) ??
          panic("Monitoring source outcome missing"),
      }),
    );
    const committed = new Set(
      await commitSanctionsMonitoringBatch({
        db,
        organizationId,
        source,
        results,
        claim: { leaseExpiresAt, marks: claimed.marks },
      }),
    );
    for (const id of terminal) {
      if (!committed.has(id)) {
        terminal.delete(id);
      }
    }
    await commitSource(index + 1);
  };
  await commitSource(0);
  signal.throwIfAborted();
  const marks = claimed.marks
    .filter(({ contactId }) => terminal.has(contactId))
    .map(({ contactId, generation }) => ({
      contactId,
      generation: generation.toString(),
    }));
  if (marks.length > 0) {
    await db(async (tx) => {
      await tx.execute(sql`
        DELETE FROM sanctions_contact_marks AS mark
        USING jsonb_to_recordset(${JSON.stringify(marks)}::text::jsonb) AS claimed("contactId" uuid, generation bigint)
        WHERE mark.organization_id = ${organizationId}
          AND mark.contact_id = claimed."contactId" AND mark.generation = claimed.generation
          AND mark.scheduled_at = ${leaseExpiresAt}::timestamptz
      `);
    });
  }
  return { claimed: claimed.marks.length, terminal: terminal.size };
};
