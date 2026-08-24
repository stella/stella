/**
 * Populate typed decision and citation identifiers for rows written before
 * the identifier tables landed. The keyset walks are bounded and idempotent;
 * a restart revisits only rows still missing their projection.
 *
 *   bun apps/api/src/scripts/backfill-decision-identifiers.ts
 */

import { sql } from "drizzle-orm";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  decisionIdentifierTypeOfCitation,
  decisionIdentifiersFromMetadata,
  normalizeDecisionIdentifier,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { isRecord } from "@/api/lib/type-guards";

const { rootDb } = await enterCaseLawMaintenanceLane();
const BATCH_SIZE = 5000;

type DecisionRow = {
  id: string;
  caseNumber: string;
  ecli: string | null;
};

const readDecisionRows = (result: unknown): DecisionRow[] =>
  (Array.isArray(result) ? result : []).flatMap((row) =>
    isRecord(row) &&
    typeof row["id"] === "string" &&
    typeof row["caseNumber"] === "string"
      ? [
          {
            id: row["id"],
            caseNumber: row["caseNumber"],
            ecli: typeof row["ecli"] === "string" ? row["ecli"] : null,
          },
        ]
      : [],
  );

const backfillDecisionPage = async (
  after: string | null,
  total: number,
): Promise<number> => {
  const result: unknown = await rootDb.execute(sql`
      SELECT decision.id,
             decision.case_number AS "caseNumber",
             decision.ecli
      FROM case_law_decisions decision
      WHERE NOT EXISTS (
        SELECT 1
        FROM case_law_decision_identifiers identifier
        WHERE identifier.decision_id = decision.id
          AND identifier.type = 'case-number'
      )
      ${after === null ? sql`` : sql`AND decision.id > ${after}`}
      ORDER BY decision.id
      LIMIT ${BATCH_SIZE}
    `);
  const rows = readDecisionRows(result);
  const last = rows.at(-1);
  if (last === undefined) {
    return total;
  }
  const values = sql.join(
    rows.flatMap((row) =>
      decisionIdentifiersFromMetadata(row).map(
        (identifier) =>
          sql`(${row.id}::uuid, ${identifier.type}::varchar, ${identifier.value}::varchar, ${normalizeDecisionIdentifier(identifier)}::varchar)`,
      ),
    ),
    sql`, `,
  );
  await rootDb.execute(sql`
      WITH inserted AS (
        INSERT INTO case_law_decision_identifiers (
          decision_id,
          type,
          value,
          normalized_value
        ) VALUES ${values}
        ON CONFLICT ON CONSTRAINT case_law_decision_identifiers_pk DO NOTHING
        RETURNING decision_id
      )
      UPDATE case_law_decisions decision
      SET indexed_hash = NULL,
          updated_at = clock_timestamp()
      WHERE decision.id IN (SELECT decision_id FROM inserted)
    `);
  const nextTotal = total + rows.length;
  console.log(`  decisions: ${nextTotal} projected`);
  return backfillDecisionPage(last.id, nextTotal);
};

const backfillDecisions = async (): Promise<number> =>
  await backfillDecisionPage(null, 0);

type CitationRow = { id: string; citationText: string };

const readCitationRows = (result: unknown): CitationRow[] =>
  (Array.isArray(result) ? result : []).flatMap((row) =>
    isRecord(row) &&
    typeof row["id"] === "string" &&
    typeof row["citationText"] === "string"
      ? [{ id: row["id"], citationText: row["citationText"] }]
      : [],
  );

const backfillCitationPage = async (
  after: string | null,
  total: number,
): Promise<number> => {
  const result: unknown = await rootDb.execute(sql`
      SELECT id, citation_text AS "citationText"
      FROM case_law_citations
      WHERE identifier_type IS NULL
      ${after === null ? sql`` : sql`AND id > ${after}`}
      ORDER BY id
      LIMIT ${BATCH_SIZE}
    `);
  const rows = readCitationRows(result);
  const last = rows.at(-1);
  if (last === undefined) {
    return total;
  }
  const values = sql.join(
    rows.map(({ id, citationText }) => {
      const type = decisionIdentifierTypeOfCitation(citationText);
      return sql`(${id}::uuid, ${type}::varchar, ${normalizeDecisionIdentifierValue(type, citationText)}::varchar)`;
    }),
    sql`, `,
  );
  // Structured citations could not resolve through the old docket-only
  // join. Put only those terminal rows back into the standing walk.
  await rootDb.execute(sql`
      WITH projected(id, type, normalized_value) AS (VALUES ${values})
      UPDATE case_law_citations citation
      SET identifier_type = projected.type,
          normalized_identifier_value = projected.normalized_value,
          resolution_status = CASE
            WHEN projected.type = ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
              THEN citation.resolution_status
            ELSE 'pending'
          END,
          cited_decision_id = CASE
            WHEN projected.type = ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
              THEN citation.cited_decision_id
            ELSE NULL
          END,
          resolution_rule_id = CASE
            WHEN projected.type = ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
              THEN citation.resolution_rule_id
            ELSE NULL
          END
      FROM projected
      WHERE citation.id = projected.id
        AND citation.identifier_type IS NULL
    `);
  const nextTotal = total + rows.length;
  console.log(`  citations: ${nextTotal} projected`);
  return backfillCitationPage(last.id, nextTotal);
};

const backfillCitations = async (): Promise<number> =>
  await backfillCitationPage(null, 0);

console.log("=== Backfilling decision identifiers ===");
const decisions = await backfillDecisions();
const citations = await backfillCitations();
console.log(`Done. decisions ${decisions}, citations ${citations}.`);

process.exit(0);
