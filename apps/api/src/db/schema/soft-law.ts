import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import type { SoftLawMetadata } from "@/api/lib/legal-search/soft-law-types";
import {
  SOFT_LAW_EXTRACTION_QUALITIES,
  SOFT_LAW_KINDS,
  SOFT_LAW_LISTING_STATES,
  SOFT_LAW_RUN_STATES,
  SOFT_LAW_STATED_STATES,
  SOFT_LAW_VALIDITY_BASES,
  SOFT_LAW_VALIDITY_STATES,
} from "@/api/lib/legal-search/soft-law-types";

import { jsonb, p, pUuid, safeUuid, sql, timestamptz } from "./common";

const values = (items: readonly string[]) =>
  sql.join(
    items.map((item) => sql.raw(`'${item}'`)),
    sql.raw(","),
  );
const ownerPolicy = (table: string) =>
  p.pgPolicy("soft_law_owner_access", {
    for: "all",
    to: "public",
    using: sql.raw(
      `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.${table}'::regclass)`,
    ),
    withCheck: sql.raw(
      `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.${table}'::regclass)`,
    ),
  });

/** Global ingestion state; ordinary application roles have no access. */
export const softLawSources = p.pgTable.withRLS(
  "soft_law_sources",
  {
    id: pUuid<"softLawSource">().primaryKey(),
    adapterKey: p.text("adapter_key").notNull().unique(),
    descriptor: jsonb().$type<CorpusSourceDescriptor>().notNull(),
    syncCursor: p.text("sync_cursor"),
    lastSyncAt: timestamptz("last_sync_at"),
    runState: p
      .text("run_state", { enum: SOFT_LAW_RUN_STATES })
      .default("idle")
      .notNull(),
    runId: p.uuid("run_id"),
    runStartedAt: timestamptz("run_started_at"),
    leaseToken: safeUuid<"softLawIngestionLease">("lease_token"),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    failureTag: p.text("failure_tag"),
  },
  (t) => [
    ownerPolicy("soft_law_sources"),
    p.check(
      "soft_law_sources_state_check",
      sql`${t.runState} IN (${values(SOFT_LAW_RUN_STATES)})`,
    ),
    p.check(
      "soft_law_sources_run_check",
      sql`(${t.runState} = 'idle' AND ${t.runId} IS NULL AND ${t.runStartedAt} IS NULL AND ${t.syncCursor} IS NULL) OR (${t.runState} <> 'idle' AND ${t.runId} IS NOT NULL AND ${t.runStartedAt} IS NOT NULL)`,
    ),
    p.check(
      "soft_law_sources_lease_check",
      sql`(${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL) OR (${t.runState} = 'running' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
  ],
);

export const softLawDocuments = p.pgTable.withRLS(
  "soft_law_documents",
  {
    id: pUuid<"softLawDocument">().primaryKey(),
    sourceId: safeUuid<"softLawSource">("source_id")
      .notNull()
      .references(() => softLawSources.id),
    identityKey: p.text("identity_key").notNull(),
    jurisdiction: p.text().notNull(),
    authority: p.text().notNull(),
    kind: p.text({ enum: SOFT_LAW_KINDS }).notNull(),
    title: p.text().notNull(),
    statedReference: p.text("stated_reference"),
    statedReferenceState: p
      .text("stated_reference_state", { enum: SOFT_LAW_STATED_STATES })
      .notNull(),
    issuedOn: p.date("issued_on"),
    issuedOnState: p
      .text("issued_on_state", { enum: SOFT_LAW_STATED_STATES })
      .notNull(),
    listingState: p
      .text("listing_state", { enum: SOFT_LAW_LISTING_STATES })
      .notNull(),
    validityState: p
      .text("validity_state", { enum: SOFT_LAW_VALIDITY_STATES })
      .notNull(),
    validityBasis: p
      .text("validity_basis", { enum: SOFT_LAW_VALIDITY_BASES })
      .notNull(),
    supersededBy: safeUuid<"softLawDocument">("superseded_by"),
    firstSeenAt: timestamptz("first_seen_at").notNull(),
    lastSeenAt: timestamptz("last_seen_at").notNull(),
    lastSeenRun: p.uuid("last_seen_run").notNull(),
  },
  (t) => [
    ownerPolicy("soft_law_documents"),
    p
      .unique("soft_law_documents_identity_unique")
      .on(t.sourceId, t.identityKey),
    p.index("soft_law_documents_run_idx").on(t.sourceId, t.lastSeenRun),
    p.foreignKey({
      columns: [t.supersededBy],
      foreignColumns: [t.id],
      name: "soft_law_documents_superseded_by_fk",
    }),
    p.check(
      "soft_law_documents_kind_check",
      sql`${t.kind} IN (${values(SOFT_LAW_KINDS)})`,
    ),
    p.check(
      "soft_law_documents_listing_check",
      sql`${t.listingState} IN (${values(SOFT_LAW_LISTING_STATES)})`,
    ),
    p.check(
      "soft_law_documents_validity_check",
      sql`${t.validityState} IN (${values(SOFT_LAW_VALIDITY_STATES)}) AND ${t.validityBasis} IN (${values(SOFT_LAW_VALIDITY_BASES)}) AND (${t.supersededBy} IS NULL OR ${t.validityState} = 'superseded')`,
    ),
    p.check(
      "soft_law_documents_reference_check",
      sql`(${t.statedReferenceState} = 'stated' AND ${t.statedReference} IS NOT NULL AND length(btrim(${t.statedReference})) > 0) OR (${t.statedReferenceState} = 'not_stated' AND ${t.statedReference} IS NULL)`,
    ),
    p.check(
      "soft_law_documents_issued_check",
      sql`(${t.issuedOnState} = 'stated' AND ${t.issuedOn} IS NOT NULL) OR (${t.issuedOnState} = 'not_stated' AND ${t.issuedOn} IS NULL)`,
    ),
  ],
);

export const softLawDocumentVersions = p.pgTable.withRLS(
  "soft_law_document_versions",
  {
    id: pUuid<"softLawDocumentVersion">().primaryKey(),
    documentId: safeUuid<"softLawDocument">("document_id")
      .notNull()
      .references(() => softLawDocuments.id),
    sequence: p.integer().notNull(),
    contentHash: p.text("content_hash").notNull(),
    rawObjects: jsonb("raw_objects")
      .$type<readonly { role: string; key: string; contentType: string }[]>()
      .notNull(),
    metadata: jsonb().$type<SoftLawMetadata>().notNull(),
    extractedText: p.text("extracted_text"),
    extractionQuality: p
      .text("extraction_quality", { enum: SOFT_LAW_EXTRACTION_QUALITIES })
      .notNull(),
    sourceDates: jsonb("source_dates")
      .$type<Readonly<Record<string, string>>>()
      .notNull(),
    observedFrom: timestamptz("observed_from").notNull(),
    observedTo: timestamptz("observed_to"),
  },
  (t) => [
    ownerPolicy("soft_law_document_versions"),
    p.unique("soft_law_versions_sequence_unique").on(t.documentId, t.sequence),
    p
      .uniqueIndex("soft_law_versions_open_unique")
      .on(t.documentId)
      .where(sql`${t.observedTo} IS NULL`),
    p.check(
      "soft_law_versions_quality_check",
      sql`${t.extractionQuality} IN (${values(SOFT_LAW_EXTRACTION_QUALITIES)})`,
    ),
    p.check("soft_law_versions_sequence_check", sql`${t.sequence} > 0`),
    p.check(
      "soft_law_versions_window_check",
      sql`${t.observedTo} IS NULL OR ${t.observedTo} >= ${t.observedFrom}`,
    ),
  ],
);

export const softLawDocumentLocators = p.pgTable.withRLS(
  "soft_law_document_locators",
  {
    id: pUuid<"softLawDocumentLocator">().primaryKey(),
    documentId: safeUuid<"softLawDocument">("document_id")
      .notNull()
      .references(() => softLawDocuments.id),
    url: p.text().notNull(),
    firstSeenAt: timestamptz("first_seen_at").notNull(),
    lastSeenAt: timestamptz("last_seen_at").notNull(),
  },
  (t) => [
    ownerPolicy("soft_law_document_locators"),
    p.unique("soft_law_locators_url_unique").on(t.documentId, t.url),
    p.index("soft_law_locators_url_idx").on(t.url),
  ],
);
