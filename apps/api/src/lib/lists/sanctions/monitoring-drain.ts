import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { contacts, sanctionsContactMarks } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  commitSanctionsMonitoringBatch,
  createMonitoringBatchAuditCounts,
  addMonitoringBatchAuditCounts,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { prepareMonitoringContacts } from "@/api/lib/lists/sanctions/monitoring-screen";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";

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
}: MonitoringDrainOptions) =>
  await db(async (tx) => {
    const leaseExpiresAt = new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS);

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
      return { claimed: 0, terminal: 0 };
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
    const claimed = { marks, contactRows };
    signal.throwIfAborted();
    const prepared = await prepareMonitoringContacts({
      db: async (run) => await run(tx),
      contactRows: claimed.contactRows,
      now,
    });
    const terminal = new Set(prepared.map(({ contactId }) => contactId));
    const sources = sanctionsSourceIds();
    // Process one source at a time; marks and the run audit commit only after all sources finish.
    const auditCounts = createMonitoringBatchAuditCounts();
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
          db: async (run) => await run(tx),
          organizationId,
          source,
          results,
          claim: { leaseExpiresAt, marks: claimed.marks },
          recordAuditEvent: (_auditTx, event) => {
            addMonitoringBatchAuditCounts(auditCounts, event);
          },
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
    const completedMarks = claimed.marks
      .filter(({ contactId }) => terminal.has(contactId))
      .map(({ contactId, generation }) => ({
        contactId,
        generation: generation.toString(),
      }));
    if (completedMarks.length > 0) {
      await tx.execute(sql`
        DELETE FROM sanctions_contact_marks AS mark
        USING jsonb_to_recordset(${JSON.stringify(completedMarks)}::text::jsonb) AS claimed("contactId" uuid, generation bigint)
        WHERE mark.organization_id = ${organizationId}
          AND mark.contact_id = claimed."contactId" AND mark.generation = claimed.generation
          AND mark.scheduled_at = ${leaseExpiresAt}::timestamptz
      `);
    }
    const actor = TENANT_SYSTEM_ACTOR.sanctionsMonitoringDrain;
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId,
      workspaceId: null,
      userId: actor,
      execution: {
        performer: {
          type: "service",
          id: actor,
          name: "Sanctions monitoring drain",
        },
        trigger: { type: "system", source: actor },
      },
    });
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY,
      resourceId: CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
      metadata: {
        kind: "sanctions-monitoring-drain",
        claimed: claimed.marks.length,
        terminal: terminal.size,
        ...auditCounts,
      },
    });
    return { claimed: claimed.marks.length, terminal: terminal.size };
  });
