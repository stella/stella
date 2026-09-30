import {
  caseLawDecisions as decisions,
  caseLawDecisionSupplements as supplements,
  caseLawTextRetentionVerdicts as verdicts,
} from "@/api/db/schema";
import * as schema from "@/api/db/schema";
// eslint-disable-next-line no-facade-imports/no-facade-imports -- exercises the write guard for a direct schema import
import { caseLawTextRetentionVerdicts as directVerdicts } from "@/api/db/schema/case-law-text-retention";
import {
  TRIMMED_CORPUS_PAYLOAD_COLUMNS,
  corpusMirrorColumns,
} from "@/api/lib/legal-search/corpus-storage";
import { confirmedRawRelocationColumns } from "@/api/lib/legal-search/raw-source-storage";

declare const tx: {
  delete: (table: unknown) => unknown;
  update: (table: unknown) => { set: (values: unknown) => unknown };
  insert: (table: unknown) => {
    select: (query: unknown) => unknown;
    values: (values: unknown) => {
      onConflictDoUpdate: (options: unknown) => unknown;
    };
  };
  execute: (source: string) => unknown;
};
declare const opaque: Record<string, unknown>;
declare const unrelated: unknown;
declare const dynamicKey: string;
declare const sql: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;

// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: direct text writes are forbidden
const _text = tx.update(decisions).set({ fulltext: "new text" });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: supplement AST writes share the final-payload boundary
const _supplement = tx.update(supplements).set({ documentAst: { blocks: [] } });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: namespace pointer writes are forbidden
const _namespace = tx
  .update(schema.caseLawDecisions)
  .set({ astS3Key: "new-key" });
const alias = decisions;
const payload = { sections: [] };
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: stable aliases cannot hide the table or payload
const _alias = tx.update(alias).set(payload);
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: opaque spreads cannot conceal protected columns
const _spread = tx.update(decisions).set({ ...opaque, updatedAt: new Date() });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: dynamic keys cannot hide protected columns
const _computed = tx.update(decisions).set({ [dynamicKey]: "text" });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: unknown update objects are not a validated write
const _opaque = tx.update(decisions).set(opaque);
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: inserts are governed by the same payload contract
const _insert = tx.insert(decisions).values({ fulltext: "insert text" });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: insert-select cannot conceal new payload columns
const _insertSelect = tx.insert(decisions).select(opaque);
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: upsert conflict updates cannot bypass validation
const _conflict = tx
  .insert(decisions)
  .values({ fulltext: null })
  .onConflictDoUpdate({ set: { fulltext: "updated text" } });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: script SQL AST rewrites must use validated persistence
const _sql = sql`UPDATE case_law_decisions SET document_ast = '{}'::jsonb WHERE id = 'fixture'`;
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: SQL table interpolation must preserve the write boundary
const _sqlTable = sql`UPDATE ${decisions} SET fulltext = 'new text' WHERE id = 'fixture'`;
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: direct SQL strings cannot bypass the boundary
const _sqlString = tx.execute(
  "INSERT INTO case_law_decisions (id, fulltext) VALUES (1, 2)",
);
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: the mirror constructor is limited to explicit relocation owners
const _unownedMirror = tx
  .update(decisions)
  .set(corpusMirrorColumns({ status: "settled", written: opaque }));

// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: verdict inserts must use the snapshot-fenced shared writer
const _verdictInsert = tx.insert(verdicts).values({ status: "assessed" });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: namespace verdict updates cannot manufacture a passing result
const _verdictUpdate = tx
  .update(schema.caseLawTextRetentionVerdicts)
  .set({ retainedRatio: 1 });
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: direct schema imports retain verdict ownership
const _verdictSelect = tx.insert(directVerdicts).select(opaque);
const verdictAlias = verdicts;
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: even empty verdict inserts cross the owner boundary
const _verdictBuilder = tx.insert(verdictAlias).values({});
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: aliased upsert builders cannot refresh a certificate
const _verdictConflict = _verdictBuilder.onConflictDoUpdate({
  set: { oracleVersion: 2 },
});
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: literal SQL cannot forge a verdict without listing columns
const _verdictSqlInsert = tx.execute(
  "INSERT INTO case_law_text_retention_verdicts VALUES (1)",
);
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: template table interpolation cannot bypass verdict ownership
const _verdictSqlUpdate = sql`UPDATE ${verdicts} SET retained_ratio = 1`;
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: null verdict updates also change the certified tuple
const _verdictSqlClear = sql`UPDATE public.case_law_text_retention_verdicts SET missing_sample_hash = NULL`;
// oxlint-disable-next-line no-direct-case-law-text-write/no-direct-case-law-text-write -- fixture: SQL merge cannot create or replace a certificate
const _verdictSqlMerge = sql`MERGE INTO "case_law_text_retention_verdicts" USING source ON true WHEN MATCHED THEN UPDATE SET oracle_version = 2`;
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _verdictDelete = tx.delete(verdicts);
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _verdictSqlDelete = sql`DELETE FROM ${verdicts} WHERE decision_id = 'fixture'`;
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _verdictSqlRead = sql`SELECT retained_ratio FROM ${verdicts}`;

// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _clear = tx
  .update(decisions)
  .set({ fulltext: null, sections: null, documentAst: null, astS3Key: null });
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _emptyClear = tx.update(decisions).set({ fulltext: "" });
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _mirrorClear = tx
  .update(decisions)
  .set(corpusMirrorColumns({ status: "settled", written: null }));
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _trim = tx.update(decisions).set(TRIMMED_CORPUS_PAYLOAD_COLUMNS);
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _metadata = tx
  .update(decisions)
  .set({ metadata: { title: "Allowed metadata" } });
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _unrelated = tx.update(unrelated).set({ fulltext: "unrelated table" });
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _sqlMetadata = sql`UPDATE case_law_decisions SET metadata = '{}'::jsonb WHERE fulltext IS NULL`;
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _sqlClear = sql`UPDATE case_law_decisions SET document_ast = NULL, fulltext = NULL WHERE id = 'fixture'`;
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _sqlRead = sql`UPDATE case_law_decisions SET metadata = fulltext WHERE id = 'fixture'`;
// expect-clean: no-direct-case-law-text-write/no-direct-case-law-text-write
const _verifiedRawRelocation = tx.update(decisions).set(
  confirmedRawRelocationColumns({
    type: "copy",
    owner: { family: "case-law", sourceId: "fixture", documentId: "fixture" },
    storedKey: "fixture",
    writtenKey: "fixture",
    contentType: null,
  }),
);
// oxlint-disable-next-line eslint/no-shadow -- fixture: a shadowed table binding is unrelated
const _shadow = (decisions: unknown) =>
  tx.update(decisions).set({ fulltext: "unrelated" });
export const __noDirectCaseLawTextWriteFixture = {
  _text,
  _supplement,
  _namespace,
  _alias,
  _spread,
  _computed,
  _opaque,
  _insert,
  _insertSelect,
  _conflict,
  _sql,
  _sqlTable,
  _sqlString,
  _unownedMirror,
  _verdictInsert,
  _verdictUpdate,
  _verdictSelect,
  _verdictBuilder,
  _verdictConflict,
  _verdictSqlInsert,
  _verdictSqlUpdate,
  _verdictSqlClear,
  _verdictSqlMerge,
  _verdictDelete,
  _verdictSqlDelete,
  _verdictSqlRead,
  _clear,
  _emptyClear,
  _mirrorClear,
  _trim,
  _metadata,
  _unrelated,
  _sqlMetadata,
  _sqlClear,
  _sqlRead,
  _verifiedRawRelocation,
  _shadow,
};
