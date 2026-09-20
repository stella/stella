import {
  FEEDBACK_AREAS,
  FEEDBACK_KINDS,
  FEEDBACK_VIAS,
} from "@stll/api-contract/feedback";
import type {
  FeedbackDelivery,
  FeedbackReportContext,
} from "@stll/api-contract/feedback";

import {
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";

const FEEDBACK_KIND_SQL_VALUES = FEEDBACK_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);
const FEEDBACK_AREA_SQL_VALUES = FEEDBACK_AREAS.map((area) =>
  sql.raw(`'${area}'`),
);

const FEEDBACK_VIA_SQL_VALUES = FEEDBACK_VIAS.map((via) => sql.raw(`'${via}'`));

/**
 * One filed feedback report, stored before any delivery is attempted so a
 * receipt always addresses a row even when the deployment has no channel
 * configured.
 *
 * Every text column holds SANITIZED content only: the raw text a reporter
 * wrote never lands here. `context.requestId` is the one exception to the
 * redaction passes (a narrow character class is validated instead), because it
 * is the key a maintainer correlates with server logs.
 *
 * This is a system table, not tenant data: it has no read surface, no
 * workspace column, and no policy admitting the request role. RLS is enabled
 * with no policy and the migration revokes every privilege from `stella`, so
 * only the owner connection behind `lib/feedback/report-store.ts` can reach
 * it. `userId` / `organizationId` record who filed a report for the
 * maintainer's private view and drop to NULL when the account or firm is
 * deleted, which is why neither is a cascade.
 */
export const feedbackReports = p.pgTable.withRLS(
  "feedback_reports",
  {
    id: pUuid<"feedbackReport">().primaryKey(),
    /** `FB-XXXX-XXXX`, the only identifier a reporter is given. */
    receipt: p.text().notNull(),
    kind: p.text({ enum: FEEDBACK_KINDS }).notNull(),
    area: p.text({ enum: FEEDBACK_AREAS }).notNull(),
    title: p.text().notNull(),
    whatHappened: p.text("what_happened").notNull(),
    expected: p.text(),
    steps: p.text(),
    evidence: p.text(),
    context: jsonb().$type<FeedbackReportContext>(),
    serverVersion: p.text("server_version").notNull(),
    /** Self-reported by the public intake; absent for an authenticated report. */
    instance: p.text(),
    via: p.text({ enum: FEEDBACK_VIAS }).notNull(),
    userId: p.text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    organizationId: safeOrganizationId("organization_id").references(
      () => organization.id,
      { onDelete: "set null" },
    ),
    redactions: p.integer().notNull(),
    /** SHA-256 over the sanitized content; the dedupe identity. */
    fingerprint: p.text().notNull(),
    deliveries: jsonb()
      .$type<FeedbackDelivery[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p.uniqueIndex("feedback_reports_receipt_uidx").on(table.receipt),
    // The dedupe lookup is "this exact content, filed in the last day", so the
    // window bound is part of the index rather than a filter over every row a
    // fingerprint ever had.
    p
      .index("feedback_reports_fingerprint_created_idx")
      .on(table.fingerprint, table.createdAt.desc()),
    p.check(
      "feedback_reports_kind_check",
      sql`${table.kind} in (${sql.join(FEEDBACK_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "feedback_reports_area_check",
      sql`${table.area} in (${sql.join(FEEDBACK_AREA_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "feedback_reports_via_check",
      sql`${table.via} in (${sql.join(FEEDBACK_VIA_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "feedback_reports_receipt_format_check",
      sql`${table.receipt} ~ '^FB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$'`,
    ),
    p.check(
      "feedback_reports_redactions_nonnegative_check",
      sql`${table.redactions} >= 0`,
    ),
  ],
);
