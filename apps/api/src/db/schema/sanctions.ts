import type { SanctionsEntry } from "@stll/sanctions";

import { publicSanctionsReaderPolicies } from "@/api/db/rls";

import type { AnyPgColumn } from "./common";
import {
  globalCaseLawPolicies,
  jsonb,
  p,
  pUuid,
  safeUuid,
  sql,
  timestamptz,
} from "./common";

export const SANCTIONS_EDITION_STATES = [
  "staging",
  "ready",
  "rejected",
] as const;

export const SANCTIONS_REPLACEMENT_GUARD_CODES = [
  "below-minimum",
  "contracted",
  "stale",
  "source-mismatch",
] as const;

export const SANCTIONS_EDITION_REJECTION_CODES = [
  ...SANCTIONS_REPLACEMENT_GUARD_CODES,
  "invalid-stage",
  "superseded",
] as const;

export const SANCTIONS_REFRESH_FAILURE_CODES = [
  "access-denied",
  "fetch-failed",
  "metadata-invalid",
  "parse-failed",
  "unexpected-error",
] as const;

export const sanctionsSources = p.pgTable(
  "sanctions_sources",
  {
    id: p.text().primaryKey(),
    issuer: p.text().notNull(),
    licence: p.text(),
    markerUrl: p.text("marker_url").notNull(),
    activeEditionId: safeUuid<"sanctionsEdition">("active_edition_id"),
    heldEditionId: safeUuid<"sanctionsEdition">("held_edition_id"),
    heldGuardCode: p.text("held_guard_code", {
      enum: SANCTIONS_REPLACEMENT_GUARD_CODES,
    }),
    heldAt: timestamptz("held_at"),
    heldPreviousCount: p.integer("held_previous_count"),
    heldNextCount: p.integer("held_next_count"),
    lastCheckedAt: timestamptz("last_checked_at"),
    lastSuccessfulVerifiedAt: timestamptz("last_successful_verified_at"),
    lastFailureAt: timestamptz("last_failure_at"),
    lastFailureCode: p.text("last_failure_code", {
      enum: SANCTIONS_REFRESH_FAILURE_CODES,
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (table) => [
    p
      .foreignKey({
        name: "sanctions_sources_active_edition_fk",
        columns: [table.id, table.activeEditionId],
        foreignColumns: [sanctionsEditions.sourceId, sanctionsEditions.id],
      })
      .onDelete("restrict"),
    p
      .foreignKey({
        name: "sanctions_sources_held_edition_fk",
        columns: [table.id, table.heldEditionId],
        foreignColumns: [sanctionsEditions.sourceId, sanctionsEditions.id],
      })
      .onDelete("restrict"),
    p.check(
      "sanctions_sources_held_code_allowed",
      sql`${table.heldGuardCode} IS NULL OR ${table.heldGuardCode} IN (${sql.join(
        SANCTIONS_REPLACEMENT_GUARD_CODES.map((code) => sql`${code}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "sanctions_sources_held_counts_nonnegative",
      sql`(${table.heldPreviousCount} IS NULL OR ${table.heldPreviousCount} >= 0) AND (${table.heldNextCount} IS NULL OR ${table.heldNextCount} >= 0)`,
    ),
    p.check(
      "sanctions_sources_held_shape",
      sql`(${table.heldAt} IS NULL) = (${table.heldGuardCode} IS NULL) AND (${table.heldEditionId} IS NULL) = (${table.heldGuardCode} IS NULL)`,
    ),
    p.check(
      "sanctions_sources_failure_code_allowed",
      sql`${table.lastFailureCode} IS NULL OR ${table.lastFailureCode} IN (${sql.join(
        SANCTIONS_REFRESH_FAILURE_CODES.map((code) => sql`${code}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "sanctions_sources_failure_pair",
      sql`(${table.lastFailureAt} IS NULL) = (${table.lastFailureCode} IS NULL)`,
    ),
    ...globalCaseLawPolicies(),
    ...publicSanctionsReaderPolicies(),
  ],
);

export const sanctionsEditions = p.pgTable(
  "sanctions_editions",
  {
    id: pUuid<"sanctionsEdition">().primaryKey(),
    sourceId: p
      .text("source_id")
      .notNull()
      .references((): AnyPgColumn => sanctionsSources.id, {
        onDelete: "restrict",
      }),
    markerKey: p.text("marker_key").notNull(),
    publishedAt: p.text("published_at").notNull(),
    fileId: p.text("file_id"),
    contentHash: p.text("content_hash").notNull(),
    entryCount: p.integer("entry_count").notNull(),
    state: p.text({ enum: SANCTIONS_EDITION_STATES }).notNull(),
    guardCode: p.text("guard_code", {
      enum: SANCTIONS_EDITION_REJECTION_CODES,
    }),
    previousEntryCount: p.integer("previous_entry_count"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    activatedAt: timestamptz("activated_at"),
  },
  (table) => [
    p
      .uniqueIndex("sanctions_editions_marker_content_idx")
      .on(table.sourceId, table.markerKey, table.contentHash),
    p
      .unique("sanctions_editions_source_id_id_unique")
      .on(table.sourceId, table.id),
    p
      .index("sanctions_editions_source_created_idx")
      .on(table.sourceId, table.createdAt),
    p.check(
      "sanctions_editions_state_allowed",
      sql`${table.state} IN (${sql.join(
        SANCTIONS_EDITION_STATES.map((state) => sql`${state}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "sanctions_editions_entry_count_nonnegative",
      sql`${table.entryCount} >= 0 AND (${table.previousEntryCount} IS NULL OR ${table.previousEntryCount} >= 0)`,
    ),
    p.check(
      "sanctions_editions_guard_shape",
      sql`(${table.state} = 'rejected') = (${table.guardCode} IS NOT NULL)`,
    ),
    p.check(
      "sanctions_editions_guard_code_allowed",
      sql`${table.guardCode} IS NULL OR ${table.guardCode} IN (${sql.join(
        SANCTIONS_EDITION_REJECTION_CODES.map((code) => sql`${code}`),
        sql`, `,
      )})`,
    ),
    p.check(
      "sanctions_editions_hash_shape",
      sql`${table.markerKey} ~ '^[0-9a-f]{64}$' AND ${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    ...globalCaseLawPolicies(),
    ...publicSanctionsReaderPolicies(),
  ],
);

export const sanctionsEntryPayloads = p.pgTable(
  "sanctions_entry_payloads",
  {
    contentHash: p.text("content_hash").primaryKey(),
    payload: jsonb().$type<SanctionsEntry>().notNull(),
  },
  (table) => [
    p.check(
      "sanctions_entry_payloads_hash_shape",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "sanctions_entry_payloads_payload_object",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    ...globalCaseLawPolicies(),
    ...publicSanctionsReaderPolicies(),
  ],
);

export const sanctionsEditionEntries = p.pgTable(
  "sanctions_edition_entries",
  {
    editionId: safeUuid<"sanctionsEdition">("edition_id")
      .notNull()
      .references(() => sanctionsEditions.id, { onDelete: "restrict" }),
    sourceEntryId: p.text("source_entry_id").notNull(),
    contentHash: p.text("content_hash").notNull(),
  },
  (table) => [
    p.primaryKey({ columns: [table.editionId, table.sourceEntryId] }),
    p
      .foreignKey({
        name: "sanctions_edition_entries_payload_fk",
        columns: [table.contentHash],
        foreignColumns: [sanctionsEntryPayloads.contentHash],
      })
      .onDelete("restrict"),
    p.index("sanctions_edition_entries_content_hash_idx").on(table.contentHash),
    ...globalCaseLawPolicies(),
    ...publicSanctionsReaderPolicies(),
  ],
);
