import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import * as p from "drizzle-orm/pg-core";

import { ABSORBED_INTO_METADATA_KEY } from "@/api/lib/case-law/decision-absorption";
import { eligibleDecisionTextSql } from "@/api/lib/case-law/fulltext-eligibility-sql";

import type { OnlineIndexDeclaration } from "./online-ddl";

const CASE_LAW_TEXT_STATE_CONSTRAINT = "case_law_decisions_text_state_valid";
const CASE_LAW_TEXT_STATE_MIGRATION = "20261029094325_case_law_fulltext_state";

const CASE_LAW_TEXT_STATE_INDEX = {
  MISSING: "case_law_decisions_text_state_missing_idx",
  DUE: "case_law_decisions_text_state_due_idx",
  FAILED: "case_law_decisions_text_state_failed_idx",
  STORED: "case_law_decisions_text_state_stored_idx",
} as const;

type CaseLawTextStateColumns = {
  sourceId: PgColumn;
  id: PgColumn;
  textState: PgColumn;
  metadata: PgColumn;
  redactedAt: PgColumn;
  fulltext: PgColumn;
  sections: PgColumn;
  documentAst: PgColumn;
  contentHash: PgColumn;
  textS3Key: PgColumn;
  normalizedS3Key: PgColumn;
  astS3Key: PgColumn;
};

/** The migration-owned validator checks the state and its stored-payload binding. */
const caseLawTextStateValidSql = (t: CaseLawTextStateColumns): SQL =>
  sql`public.case_law_decision_text_state_valid(${t.textState}, ${t.redactedAt}, ${t.fulltext}, ${t.sections}, ${t.documentAst}, ${t.contentHash}, ${t.textS3Key}, ${t.normalizedS3Key}, ${t.astS3Key})`;

export const caseLawTextStateSchemaRules = (t: CaseLawTextStateColumns) => [
  p.check(CASE_LAW_TEXT_STATE_CONSTRAINT, caseLawTextStateValidSql(t)),
  p
    .index(CASE_LAW_TEXT_STATE_INDEX.MISSING)
    .on(t.sourceId, t.id)
    .where(sql`${eligibleDecisionTextSql(t)} AND ${t.textState} IS NULL`),
  p
    .index(CASE_LAW_TEXT_STATE_INDEX.DUE)
    .on(t.sourceId, sql`(${t.textState} ->> 'nextAttemptAt')`, t.id)
    .where(
      sql`${eligibleDecisionTextSql(t)} AND ${t.textState} ->> 'status' IN ('fetch_pending', 'fetch_failed')`,
    ),
  p
    .index(CASE_LAW_TEXT_STATE_INDEX.STORED)
    .on(t.sourceId, sql`(${t.textState} ->> 'verifiedAt')`, t.id)
    .where(
      sql`${eligibleDecisionTextSql(t)} AND ${t.textState} ->> 'status' = 'stored'`,
    ),
  p
    .index(CASE_LAW_TEXT_STATE_INDEX.FAILED)
    .on(t.sourceId, t.id)
    .where(
      sql`${eligibleDecisionTextSql(t)} AND ${t.textState} ->> 'status' = 'fetch_failed'`,
    ),
];

/** Queue timestamps have a canonical UTC spelling, so text order is instant order. */
export const CASE_LAW_TEXT_STATE_INDEXES = [
  {
    introducedBy: CASE_LAW_TEXT_STATE_MIGRATION,
    createSql: `CREATE INDEX CONCURRENTLY "${CASE_LAW_TEXT_STATE_INDEX.MISSING}" ON public."case_law_decisions" USING btree ("source_id", "id") WHERE "redacted_at" IS NULL AND "metadata" -> '${ABSORBED_INTO_METADATA_KEY}' IS NULL AND "text_state" IS NULL`,
    definitionBody: `ON public.case_law_decisions USING btree (source_id, id) WHERE ((redacted_at IS NULL) AND ((metadata -> '${ABSORBED_INTO_METADATA_KEY}'::text) IS NULL) AND (text_state IS NULL))`,
    isUnique: false,
    name: CASE_LAW_TEXT_STATE_INDEX.MISSING,
    tableName: "case_law_decisions",
  },
  {
    introducedBy: CASE_LAW_TEXT_STATE_MIGRATION,
    createSql: `CREATE INDEX CONCURRENTLY "${CASE_LAW_TEXT_STATE_INDEX.DUE}" ON public."case_law_decisions" USING btree ("source_id", ("text_state" ->> 'nextAttemptAt'), "id") WHERE "redacted_at" IS NULL AND "metadata" -> '${ABSORBED_INTO_METADATA_KEY}' IS NULL AND "text_state" ->> 'status' IN ('fetch_pending', 'fetch_failed')`,
    definitionBody: `ON public.case_law_decisions USING btree (source_id, ((text_state ->> 'nextAttemptAt'::text)), id) WHERE ((redacted_at IS NULL) AND ((metadata -> '${ABSORBED_INTO_METADATA_KEY}'::text) IS NULL) AND ((text_state ->> 'status'::text) = ANY (ARRAY['fetch_pending'::text, 'fetch_failed'::text])))`,
    isUnique: false,
    name: CASE_LAW_TEXT_STATE_INDEX.DUE,
    tableName: "case_law_decisions",
  },
  {
    introducedBy: CASE_LAW_TEXT_STATE_MIGRATION,
    createSql: `CREATE INDEX CONCURRENTLY "${CASE_LAW_TEXT_STATE_INDEX.STORED}" ON public."case_law_decisions" USING btree ("source_id", ("text_state" ->> 'verifiedAt'), "id") WHERE "redacted_at" IS NULL AND "metadata" -> '${ABSORBED_INTO_METADATA_KEY}' IS NULL AND "text_state" ->> 'status' = 'stored'`,
    definitionBody: `ON public.case_law_decisions USING btree (source_id, ((text_state ->> 'verifiedAt'::text)), id) WHERE ((redacted_at IS NULL) AND ((metadata -> '${ABSORBED_INTO_METADATA_KEY}'::text) IS NULL) AND ((text_state ->> 'status'::text) = 'stored'::text))`,
    isUnique: false,
    name: CASE_LAW_TEXT_STATE_INDEX.STORED,
    tableName: "case_law_decisions",
  },
  {
    introducedBy: CASE_LAW_TEXT_STATE_MIGRATION,
    createSql: `CREATE INDEX CONCURRENTLY "${CASE_LAW_TEXT_STATE_INDEX.FAILED}" ON public."case_law_decisions" USING btree ("source_id", "id") WHERE "redacted_at" IS NULL AND "metadata" -> '${ABSORBED_INTO_METADATA_KEY}' IS NULL AND "text_state" ->> 'status' = 'fetch_failed'`,
    definitionBody: `ON public.case_law_decisions USING btree (source_id, id) WHERE ((redacted_at IS NULL) AND ((metadata -> '${ABSORBED_INTO_METADATA_KEY}'::text) IS NULL) AND ((text_state ->> 'status'::text) = 'fetch_failed'::text))`,
    isUnique: false,
    name: CASE_LAW_TEXT_STATE_INDEX.FAILED,
    tableName: "case_law_decisions",
  },
] as const satisfies readonly (OnlineIndexDeclaration & {
  introducedBy: string;
})[];
