import {
  SANCTIONS_REVIEW_DISPOSITIONS,
  SANCTIONS_MATCH_STATES,
  SANCTIONS_MONITORING_EVENT_TYPES,
} from "@/api/lib/lists/sanctions/monitoring-vocabulary";
import type { SanctionsPossibleMatch } from "@/api/lib/lists/sanctions/screening-service";

import {
  orgPolicies,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  sql,
  timestamptz,
  user,
} from "./common";
import { contacts } from "./contacts";
import { sanctionsEditions, sanctionsSources } from "./sanctions";

const monitoringPolicies = (tableName: string) => {
  const owner = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = ${tableName}::regclass)`;
  return [
    ...orgPolicies(),
    p.pgPolicy(`${tableName}_owner_access`, {
      for: "all",
      to: "public",
      using: owner,
      withCheck: owner,
    }),
  ];
};

export const sanctionsContactMarks = p.pgTable(
  "sanctions_contact_marks",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: safeUuid<"contact">("contact_id").primaryKey(),
    generation: p.bigint({ mode: "bigint" }).notNull().default(1n),
    markedAt: timestamptz("marked_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .index("sanctions_contact_marks_org_cursor_idx")
      .on(table.organizationId, table.contactId),
    p.check(
      "sanctions_contact_marks_generation_check",
      sql`${table.generation} > 0`,
    ),
    p
      .foreignKey({
        columns: [table.organizationId, table.contactId],
        foreignColumns: [contacts.organizationId, contacts.id],
      })
      .onDelete("cascade"),
    ...monitoringPolicies("sanctions_contact_marks"),
  ],
);

// Enablement is a durable request to start an organization cursor, not a bulk
// insert of every contact in the settings transaction.
export const sanctionsOrganizationMarks = p.pgTable(
  "sanctions_organization_marks",
  {
    organizationId: safeOrganizationId("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    generation: p.bigint({ mode: "bigint" }).notNull().default(1n),
    markedAt: timestamptz("marked_at").notNull().defaultNow(),
  },
  (table) => [
    p.check(
      "sanctions_organization_marks_generation_check",
      sql`${table.generation} > 0`,
    ),
    ...monitoringPolicies("sanctions_organization_marks"),
  ],
);

export const sanctionsContactScreenings = p.pgTable(
  "sanctions_contact_screenings",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: safeUuid<"contact">("contact_id").notNull(),
    sourceId: p
      .text("source_id")
      .notNull()
      .references(() => sanctionsSources.id),
    editionId: safeUuid<"sanctionsEdition">("edition_id")
      .notNull()
      .references(() => sanctionsEditions.id),
    contactFingerprint: p.text("contact_fingerprint").notNull(),
    checkedAt: timestamptz("checked_at").notNull(),
  },
  (table) => [
    p.primaryKey({
      columns: [table.organizationId, table.contactId, table.sourceId],
    }),
    p
      .foreignKey({
        columns: [table.organizationId, table.contactId],
        foreignColumns: [contacts.organizationId, contacts.id],
      })
      .onDelete("cascade"),
    ...monitoringPolicies("sanctions_contact_screenings"),
  ],
);

export const sanctionsContactMatches = p.pgTable(
  "sanctions_contact_matches",
  {
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: safeUuid<"contact">("contact_id").notNull(),
    sourceId: p
      .text("source_id")
      .notNull()
      .references(() => sanctionsSources.id),
    sourceEntryId: p.text("source_entry_id").notNull(),
    editionId: safeUuid<"sanctionsEdition">("edition_id")
      .notNull()
      .references(() => sanctionsEditions.id),
    state: p.text({ enum: SANCTIONS_MATCH_STATES }).notNull(),
    disposition: p
      .text({ enum: SANCTIONS_REVIEW_DISPOSITIONS })
      .notNull()
      .default("needs-review"),
    reviewedBy: p
      .text("reviewed_by")
      .references(() => user.id, { onDelete: "set null" }),
    reviewReason: p.text("review_reason"),
    contactFingerprint: p.text("contact_fingerprint").notNull(),
    entryHash: p.text("entry_hash").notNull(),
    match: p.jsonb().$type<SanctionsPossibleMatch>().notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
  },
  (table) => [
    p.primaryKey({
      columns: [
        table.organizationId,
        table.contactId,
        table.sourceId,
        table.sourceEntryId,
      ],
    }),
    p.check(
      "sanctions_contact_matches_state_check",
      sql`${table.state} IN (${sql.join(
        SANCTIONS_MATCH_STATES.map((state) => sql`${state}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "sanctions_contact_matches_disposition_check",
      sql`${table.disposition} IN (${sql.join(
        SANCTIONS_REVIEW_DISPOSITIONS.map((disposition) => sql`${disposition}`),
        sql`, `,
      )})`,
    ),
    p
      .foreignKey({
        columns: [table.organizationId, table.contactId],
        foreignColumns: [contacts.organizationId, contacts.id],
      })
      .onDelete("cascade"),
    ...monitoringPolicies("sanctions_contact_matches"),
  ],
);

export const sanctionsScreeningEvents = p.pgTable(
  "sanctions_screening_events",
  {
    id: pUuid<"sanctionsScreeningEvent">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contactId: safeUuid<"contact">("contact_id").notNull(),
    sourceId: p
      .text("source_id")
      .notNull()
      .references(() => sanctionsSources.id),
    sourceEntryId: p.text("source_entry_id").notNull(),
    type: p.text({ enum: SANCTIONS_MONITORING_EVENT_TYPES }).notNull(),
    oldEditionId: safeUuid<"sanctionsEdition">("old_edition_id").references(
      () => sanctionsEditions.id,
    ),
    newEditionId: safeUuid<"sanctionsEdition">("new_edition_id")
      .notNull()
      .references(() => sanctionsEditions.id),
    reason: p.text().notNull(),
    oldMatch: p.jsonb("old_match").$type<SanctionsPossibleMatch>(),
    newMatch: p.jsonb("new_match").$type<SanctionsPossibleMatch>(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (table) => [
    p
      .index("sanctions_screening_events_org_contact_time_idx")
      .on(table.organizationId, table.contactId, table.createdAt, table.id),
    p.check(
      "sanctions_screening_events_type_check",
      sql`${table.type} IN (${sql.join(
        SANCTIONS_MONITORING_EVENT_TYPES.map((type) => sql`${type}`),
        sql`, `,
      )})`,
    ),
    p
      .foreignKey({
        columns: [table.organizationId, table.contactId],
        foreignColumns: [contacts.organizationId, contacts.id],
      })
      .onDelete("cascade"),
    ...monitoringPolicies("sanctions_screening_events"),
    p.pgPolicy("events_no_update", {
      as: "restrictive",
      for: "update",
      to: "public",
      using: sql`false`,
    }),
    p.pgPolicy("events_no_delete", {
      as: "restrictive",
      for: "delete",
      to: "public",
      using: sql`false`,
    }),
  ],
);
