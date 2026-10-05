import { panic, Result, TaggedError } from "better-result";
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
import { readCursorPage } from "@/api/lib/db/read-bounded";
import {
  commitSanctionsMonitoringBatch,
  createMonitoringBatchAuditCounts,
  addMonitoringBatchAuditCounts,
  SANCTIONS_MONITORING_BATCH_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-diff";
import { lockSanctionsMonitoring } from "@/api/lib/lists/sanctions/monitoring-lock";
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

const processSanctionsContactMarks = async (
  { db, organizationId, now, signal }: MonitoringDrainOptions,
  attempted: Pick<
    typeof sanctionsContactMarks.$inferSelect,
    "contactId" | "generation"
  >[],
) =>
  await db(async (tx) => {
    const leaseExpiresAt = new Date(now.getTime() + SANCTIONS_MARK_LEASE_MS);

    // All monitoring writers take the organization fence, then ordered contacts, then marks.
    await lockSanctionsMonitoring(tx, organizationId);
    const page = await readCursorPage(
      tx
        .select({ contactId: sanctionsContactMarks.contactId })
        .from(sanctionsContactMarks)
        .where(
          and(
            eq(sanctionsContactMarks.organizationId, organizationId),
            sql`${sanctionsContactMarks.scheduledAt} <= ${now}::timestamptz`,
            sql`${sanctionsContactMarks.nextAttemptAt} <= ${now}::timestamptz`,
          ),
        )
        .orderBy(
          asc(sanctionsContactMarks.nextAttemptAt),
          asc(sanctionsContactMarks.scheduledAt),
          asc(sanctionsContactMarks.contactId),
        ),
      {
        limit: SANCTIONS_MONITORING_BATCH_SIZE,
        cursorForItem: ({ contactId }) => contactId,
      },
    );
    const candidates = page.items;
    // readCursorPage enforces SANCTIONS_MONITORING_BATCH_SIZE before constructing these ID fences.
    if (candidates.length > SANCTIONS_MONITORING_BATCH_SIZE) {
      panic("Sanctions drain candidate batch exceeds its bound");
    }
    if (candidates.length === 0) {
      return { claimed: 0, terminal: 0, hasMore: page.nextCursor !== null };
    }
    const contactRows = await tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          inArray(
            contacts.id,
            candidates.map(({ contactId }) => contactId),
          ),
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(candidates.length)
      .for("no key update");
    if (contactRows.length === 0) {
      return { claimed: 0, terminal: 0, hasMore: page.nextCursor !== null };
    }
    const marks = await tx
      .select()
      .from(sanctionsContactMarks)
      .where(
        and(
          eq(sanctionsContactMarks.organizationId, organizationId),
          inArray(
            sanctionsContactMarks.contactId,
            contactRows.map(({ id }) => id),
          ),
          sql`${sanctionsContactMarks.scheduledAt} <= ${now}::timestamptz`,
          sql`${sanctionsContactMarks.nextAttemptAt} <= ${now}::timestamptz`,
        ),
      )
      .orderBy(asc(sanctionsContactMarks.contactId))
      .limit(contactRows.length)
      .for("update", { skipLocked: true });
    if (marks.length === 0) {
      return { claimed: 0, terminal: 0, hasMore: page.nextCursor !== null };
    }
    attempted.push(
      ...marks.map(({ contactId, generation }) => ({ contactId, generation })),
    );
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
    const claimed = {
      marks,
      contactRows: contactRows.filter(({ id }) => ids.includes(id)),
    };
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
    return {
      claimed: claimed.marks.length,
      terminal: terminal.size,
      hasMore: page.nextCursor !== null,
    };
  });

export class SanctionsDrainAttemptFailed extends TaggedError(
  "SanctionsDrainAttemptFailed",
)<{
  message: string;
  cause: unknown;
}> {}

const DRAIN_RETRY_BASE_MS = 60_000;
const DRAIN_RETRY_MAX_MS = 60 * 60_000;

type RecordFailedDrainOptions = MonitoringDrainOptions & {
  attempted: readonly Pick<
    typeof sanctionsContactMarks.$inferSelect,
    "contactId" | "generation"
  >[];
};

const recordFailedDrain = async ({
  db,
  organizationId,
  now,
  attempted,
}: RecordFailedDrainOptions) =>
  await db(async (tx) => {
    await lockSanctionsMonitoring(tx, organizationId);
    const ids = attempted.map(({ contactId }) => contactId);
    // attempted is constructed only from the SANCTIONS_MONITORING_BATCH_SIZE candidate fence.
    if (attempted.length > SANCTIONS_MONITORING_BATCH_SIZE) {
      panic("Sanctions retry batch exceeds its bound");
    }
    await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          inArray(contacts.id, ids),
        ),
      )
      .orderBy(asc(contacts.id))
      .limit(ids.length)
      .for("no key update");
    const changed = await tx.execute(sql`
      UPDATE sanctions_contact_marks AS mark
      SET attempt_count = LEAST(mark.attempt_count::bigint + 1, 2147483647)::integer,
          next_attempt_at = ${now}::timestamptz +
            LEAST(${DRAIN_RETRY_MAX_MS}, ${DRAIN_RETRY_BASE_MS} * power(2, LEAST(mark.attempt_count, 6))) * interval '1 millisecond'
      FROM jsonb_to_recordset(${JSON.stringify(attempted.map(({ contactId, generation }) => ({ contactId, generation: generation.toString() })))}::text::jsonb)
        AS attempted("contactId" uuid, generation bigint)
      WHERE mark.organization_id = ${organizationId}
        AND mark.contact_id = attempted."contactId" AND mark.generation = attempted.generation
      RETURNING mark.contact_id
    `);
    if (changed.length === 0) {
      return;
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
        kind: "sanctions-monitoring-drain-attempt-failed",
        attempted: changed.length,
      },
    });
  });

export const drainSanctionsContactMarks = async (
  options: MonitoringDrainOptions,
) => {
  const attempted: Pick<
    typeof sanctionsContactMarks.$inferSelect,
    "contactId" | "generation"
  >[] = [];
  const outcome = await Result.tryPromise(
    async () => await processSanctionsContactMarks(options, attempted),
  );
  if (outcome.isOk()) {
    return Result.ok(outcome.value);
  }
  if (options.signal.aborted || attempted.length === 0) {
    return Result.err(outcome.error);
  }
  const backoff = await Result.tryPromise(
    async () => await recordFailedDrain({ ...options, attempted }),
  );
  if (backoff.isErr()) {
    return Result.err(backoff.error);
  }
  return Result.err(
    new SanctionsDrainAttemptFailed({
      message: "Sanctions drain attempt failed after recording retry backoff",
      cause: outcome.error,
    }),
  );
};
