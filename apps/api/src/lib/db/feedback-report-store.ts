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
import { and, desc, eq, gte, sql } from "drizzle-orm";

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

export type StoredFeedbackReport = { id: SafeId<"feedbackReport"> };

/**
 * The persistence seam the submit service drives. A test passes an in-memory
 * implementation rather than mocking the module, which is what keeps the
 * service's dedupe and delivery behaviour testable without a database.
 */
export type FeedbackReportStore = {
  /** The receipt of an identical report filed at or after `since`, if any. */
  findRecentByFingerprint: (input: {
    fingerprint: string;
    since: Date;
  }) => Promise<string | undefined>;
  /** Insert the report and its audit row in one transaction. */
  insert: (row: FeedbackReportRow) => Promise<StoredFeedbackReport>;
  recordDeliveries: (input: {
    id: SafeId<"feedbackReport">;
    deliveries: readonly FeedbackDelivery[];
  }) => Promise<void>;
};

export const feedbackReportStore: FeedbackReportStore = {
  findRecentByFingerprint: async ({ fingerprint, since }) => {
    const [existing] = await rootDb
      .select({ receipt: feedbackReports.receipt })
      .from(feedbackReports)
      .where(
        and(
          eq(feedbackReports.fingerprint, fingerprint),
          // Cast so the cutoff is compared at the column's own precision.
          gte(
            feedbackReports.createdAt,
            sql`${since.toISOString()}::timestamptz`,
          ),
        ),
      )
      .orderBy(desc(feedbackReports.createdAt))
      .limit(1);
    return existing?.receipt;
  },

  insert: async (row) =>
    await rootDb.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(feedbackReports)
        .values(row)
        .returning({ id: feedbackReports.id });
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

      return inserted;
    }),

  recordDeliveries: async ({ deliveries, id }) => {
    await rootDb
      .update(feedbackReports)
      .set({ deliveries: [...deliveries] })
      .where(eq(feedbackReports.id, id));
  },
};
