/**
 * Owner-level DB access for the feedback pipeline.
 *
 * `feedback_reports` is a system table: RLS is enabled with no policy and the
 * migration revokes every privilege from `stella`, so the request role can
 * neither read a report nor file one under another reporter's identity. Per
 * /conventions-security ("Handlers must not import the root db module. Use
 * ctx.scopedDb, or move owner-level DB access into a narrow lib helper"), all
 * `rootDb` access for this slice lives here.
 *
 * The insert and its audit row share one transaction, so a stored report is
 * never missing from the trail. Delivery happens after the transaction
 * commits: the channels are network I/O and must not hold a lock.
 */

import { panic } from "better-result";
import { and, eq, gte, sql } from "drizzle-orm";

import type {
  FeedbackDelivery,
  FeedbackReportContext,
  FeedbackArea,
  FeedbackKind,
  FeedbackVia,
} from "@stll/api-contract/feedback";

import { rootDb } from "@/api/db/root";
import { feedbackReports } from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";

export type FeedbackReportRow = {
  kind: FeedbackKind;
  area: FeedbackArea;
  receipt: string;
  title: string;
  whatHappened: string;
  expected: string | null;
  steps: string | null;
  evidence: string | null;
  context: FeedbackReportContext | null;
  serverVersion: string;
  instance: string | null;
  via: FeedbackVia;
  userId: SafeId<"user"> | null;
  organizationId: SafeId<"organization"> | null;
  redactions: number;
  fingerprint: string;
};

type StoredFeedbackReport = { id: SafeId<"feedbackReport"> };
type FeedbackInsertResult = StoredFeedbackReport & {
  receipt: string;
  inserted: boolean;
};

/**
 * The persistence seam the submit service drives. A test passes an in-memory
 * implementation rather than mocking the module, which is what keeps the
 * service's dedupe and delivery behaviour testable without a database.
 */
export type FeedbackReportStore = {
  /** Find or insert atomically so concurrent identical submissions converge. */
  insertIfAbsent: (input: {
    row: FeedbackReportRow;
    since: Date;
  }) => Promise<FeedbackInsertResult>;
  recordDeliveries: (input: {
    id: SafeId<"feedbackReport">;
    deliveries: readonly FeedbackDelivery[];
  }) => Promise<void>;
};

export const feedbackReportStore: FeedbackReportStore = {
  insertIfAbsent: async ({ row, since }) =>
    await rootDb.transaction(async (tx) => {
      // A time-window uniqueness constraint cannot be expressed as a partial
      // index because `now()` is not immutable. Serialize one fingerprint at
      // a time instead, while keeping unrelated reports fully concurrent.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${row.fingerprint}, 0))`,
      );
      const [existing] = await tx
        .select({ id: feedbackReports.id, receipt: feedbackReports.receipt })
        .from(feedbackReports)
        .where(
          and(
            eq(feedbackReports.fingerprint, row.fingerprint),
            gte(
              feedbackReports.createdAt,
              sql`${since.toISOString()}::timestamptz`,
            ),
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        return { ...existing, inserted: false };
      }

      const [inserted] = await tx
        .insert(feedbackReports)
        .values(row)
        .returning({
          id: feedbackReports.id,
          receipt: feedbackReports.receipt,
        });
      if (!inserted) {
        panic("feedback report insert returned no row");
      }

      const { organizationId, userId } = row;
      // No identity means the public intake: there is no tenant trail to write
      // the event into, and inventing one would file a stranger's report under
      // someone's firm.
      if (organizationId !== null && userId !== null) {
        const recordAuditEvent = createBackgroundAuditRecorder({
          execution: {
            performer: { id: userId, type: "user" },
            trigger:
              row.via === "mcp"
                ? { type: "direct", source: "mcp" }
                : { type: "direct" },
          },
          organizationId,
          workspaceId: null,
          userId,
        });
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.FEEDBACK_REPORT,
          resourceId: row.receipt,
          // Never the content: the trail records that a report was filed, by
          // whom, about what area. What it said lives in the row alone.
          metadata: { kind: row.kind, area: row.area, via: row.via },
        });
      }

      return { ...inserted, inserted: true };
    }),

  recordDeliveries: async ({ deliveries, id }) => {
    await rootDb
      .update(feedbackReports)
      .set({ deliveries: [...deliveries] })
      .where(eq(feedbackReports.id, id));
  },
};
