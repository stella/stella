import { isNotNull, sql } from "drizzle-orm";
import * as p from "drizzle-orm/pg-core";

import {
  EXTERNAL_ID_MAX_LENGTH,
  EXTERNAL_SOURCE_MAX_LENGTH,
} from "@/api/lib/imports/external-ref-limits";

import { timestamptz } from "./columns";

export const IMPORT_PROVENANCE_TABLES = [
  "contacts",
  "workspaces",
  "time_entries",
  "expenses",
  "invoices",
  "correspondence",
] as const;

/**
 * Provenance of a row brought in by an import: the system it came from, its
 * identifier there, and when the import last wrote it. All three stay null
 * for rows created in stella.
 */
export const importProvenanceColumns = () => ({
  externalSource: p.varchar("external_source", {
    length: EXTERNAL_SOURCE_MAX_LENGTH,
  }),
  externalId: p.varchar("external_id", { length: EXTERNAL_ID_MAX_LENGTH }),
  importedAt: timestamptz("imported_at"),
});

type ImportProvenanceTable = {
  organizationId: p.AnyPgColumn;
  externalSource: p.AnyPgColumn;
  externalId: p.AnyPgColumn;
  importedAt: p.AnyPgColumn;
};

/**
 * One row per external identity within an organization, which is what lets
 * a re-run import converge on `ON CONFLICT` instead of duplicating; and a
 * ref is whole (source with id) and always stamped with its import time.
 */
export const importProvenanceConstraints = (
  tableName: (typeof IMPORT_PROVENANCE_TABLES)[number],
  table: ImportProvenanceTable,
) => [
  p
    .uniqueIndex(`${tableName}_org_external_uidx`)
    .on(table.organizationId, table.externalSource, table.externalId)
    .where(isNotNull(table.externalId)),
  p.check(
    `${tableName}_external_ref_check`,
    sql`(${table.externalSource} IS NULL) = (${table.externalId} IS NULL) AND (${table.externalId} IS NULL OR ${table.importedAt} IS NOT NULL)`,
  ),
];
