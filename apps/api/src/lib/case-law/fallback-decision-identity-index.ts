// parser-output-unchanged: fallback storage indexes do not change parsed source output.
import { isNotNull, sql } from "drizzle-orm";
import { index, uniqueIndex } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  FALLBACK_DECISION_CONTENT_INDEX,
  FALLBACK_DECISION_IDENTITY_INDEX,
} from "@/api/lib/case-law/fallback-decision-identity-constants";
import type { RequiredMigrationIndex } from "@/api/lib/db/migration-history";

export const FALLBACK_DECISION_INDEXES = [
  {
    createSql: `CREATE UNIQUE INDEX CONCURRENTLY "${FALLBACK_DECISION_IDENTITY_INDEX}" ON public."case_law_decisions" USING btree ("source_id", "fallback_identity_key") WHERE "source_document_id" IS NULL AND "fallback_identity_key" IS NOT NULL`,
    definitionBody:
      "ON public.case_law_decisions USING btree (source_id, fallback_identity_key) WHERE ((source_document_id IS NULL) AND (fallback_identity_key IS NOT NULL))",
    isUnique: true,
    name: FALLBACK_DECISION_IDENTITY_INDEX,
    tableName: "case_law_decisions",
  },
  {
    createSql: `CREATE UNIQUE INDEX CONCURRENTLY "${FALLBACK_DECISION_CONTENT_INDEX}" ON public."case_law_decisions" USING btree ("source_id", "fallback_content_hash") WHERE "source_document_id" IS NULL AND "fallback_content_hash" IS NOT NULL`,
    definitionBody:
      "ON public.case_law_decisions USING btree (source_id, fallback_content_hash) WHERE ((source_document_id IS NULL) AND (fallback_content_hash IS NOT NULL))",
    isUnique: true,
    name: FALLBACK_DECISION_CONTENT_INDEX,
    tableName: "case_law_decisions",
  },
  {
    createSql:
      'CREATE INDEX CONCURRENTLY "case_law_decisions_source_fallback_cohort_idx" ON public."case_law_decisions" USING btree ("source_id", "fallback_cohort_key") WHERE "fallback_cohort_key" IS NOT NULL',
    definitionBody:
      "ON public.case_law_decisions USING btree (source_id, fallback_cohort_key) WHERE (fallback_cohort_key IS NOT NULL)",
    isUnique: false,
    name: "case_law_decisions_source_fallback_cohort_idx",
    tableName: "case_law_decisions",
  },
] as const satisfies readonly (RequiredMigrationIndex & {
  createSql: string;
})[];

type FallbackDecisionIndexColumns = {
  sourceId: AnyPgColumn;
  sourceDocumentId: AnyPgColumn;
  fallbackIdentityKey: AnyPgColumn;
  fallbackCohortKey: AnyPgColumn;
  fallbackContentHash: AnyPgColumn;
};

/** Schema and online declarations have one owning index module. */
export const fallbackDecisionIdentityIndexes = (
  columns: FallbackDecisionIndexColumns,
) => [
  uniqueIndex(FALLBACK_DECISION_IDENTITY_INDEX)
    .on(columns.sourceId, columns.fallbackIdentityKey)
    .where(
      sql`${columns.sourceDocumentId} IS NULL AND ${columns.fallbackIdentityKey} IS NOT NULL`,
    ),
  uniqueIndex(FALLBACK_DECISION_CONTENT_INDEX)
    .on(columns.sourceId, columns.fallbackContentHash)
    .where(
      sql`${columns.sourceDocumentId} IS NULL AND ${columns.fallbackContentHash} IS NOT NULL`,
    ),
  index("case_law_decisions_source_fallback_cohort_idx")
    .on(columns.sourceId, columns.fallbackCohortKey)
    .where(isNotNull(columns.fallbackCohortKey)),
];
