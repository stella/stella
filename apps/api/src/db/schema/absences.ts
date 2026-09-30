import {
  ABSENCE_KINDS,
  ABSENCE_COVERAGES,
  ABSENCE_HALF_DAY_SEGMENTS,
  ABSENCE_STATUSES,
} from "@stll/api-contract";

import { absencePolicies } from "@/api/db/rls";
import type { SafeId } from "@/api/lib/branded-types";

import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  user,
  timestamptz,
} from "./common";

export const absences = p.pgTable(
  "absences",
  {
    id: pUuid<"absence">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .$type<SafeId<"user">>()
      .references(() => user.id, { onDelete: "set null" }),
    kind: p.text("kind", { enum: ABSENCE_KINDS }).notNull(),
    startDate: p.date("start_date").notNull(),
    endDate: p.date("end_date").notNull(),
    timezoneId: p.text("timezone_id").notNull(),
    coverage: p.text("coverage", { enum: ABSENCE_COVERAGES }).notNull(),
    halfDaySegment: p.text("half_day_segment", {
      enum: ABSENCE_HALF_DAY_SEGMENTS,
    }),
    status: p
      .text("status", { enum: ABSENCE_STATUSES })
      .notNull()
      .default("requested"),
    approverUserId: p
      .text("approver_user_id")
      .$type<SafeId<"user">>()
      .references(() => user.id, { onDelete: "set null" }),
    decidedAt: timestamptz("decided_at"),
    decisionComment: p.text("decision_comment"),
    version: p.integer("version").notNull().default(1),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    p
      .index("absences_org_user_start_id_idx")
      .on(table.organizationId, table.userId, table.startDate, table.id),
    p
      .index("absences_org_status_start_id_idx")
      .on(table.organizationId, table.status, table.startDate, table.id),
    // Erasure and SET NULL cascades find retained history across organizations.
    p.index("absences_user_id_idx").on(table.userId),
    p.index("absences_approver_user_id_idx").on(table.approverUserId),
    p.check(
      "absences_kind_check",
      sql`${table.kind} IN (${sql.join(
        ABSENCE_KINDS.map((value) => sql.raw(`'${value}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "absences_coverage_check",
      sql`${table.coverage} IN (${sql.join(
        ABSENCE_COVERAGES.map((value) => sql.raw(`'${value}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "absences_half_day_segment_check",
      sql`${table.halfDaySegment} IS NULL OR ${table.halfDaySegment} IN (${sql.join(
        ABSENCE_HALF_DAY_SEGMENTS.map((value) => sql.raw(`'${value}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "absences_status_check",
      sql`${table.status} IN (${sql.join(
        ABSENCE_STATUSES.map((value) => sql.raw(`'${value}'`)),
        sql`, `,
      )})`,
    ),
    p.check(
      "absences_positive_range_check",
      sql`${table.endDate} > ${table.startDate}`,
    ),
    p.check(
      "absences_half_day_shape_check",
      sql`(${table.coverage} = 'full' AND ${table.halfDaySegment} IS NULL) OR (${table.coverage} = 'half' AND ${table.halfDaySegment} IS NOT NULL AND ${table.endDate} = ${table.startDate} + 1)`,
    ),
    // Historical decision dates survive actor anonymization and account removal.
    p.check(
      "absences_decision_shape_check",
      sql`(${table.status} = 'requested' AND ${table.approverUserId} IS NULL AND ${table.decidedAt} IS NULL AND ${table.decisionComment} IS NULL) OR (${table.status} <> 'requested' AND ${table.decidedAt} IS NOT NULL)`,
    ),
    p.check(
      "absences_decision_comment_check",
      sql`${table.decisionComment} IS NULL OR (char_length(btrim(${table.decisionComment})) BETWEEN 1 AND 2000 AND char_length(${table.decisionComment}) <= 2000)`,
    ),
    p.check("absences_version_check", sql`${table.version} > 0`),
    ...absencePolicies(),
  ],
);
