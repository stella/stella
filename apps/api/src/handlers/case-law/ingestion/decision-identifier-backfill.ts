import { panic } from "better-result";
import { sql } from "drizzle-orm";

import {
  DECISION_IDENTIFIER_MAX_COUNT,
  DECISION_IDENTIFIER_TYPES,
} from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE,
  CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES,
} from "@/api/db/schema";
import type { CaseLawDecisionIdentifierBackfillPhase } from "@/api/db/schema";
import { lockCitationGraph } from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_RESOLUTION_STATUS,
  effectiveCitationIdentifierTypeSql,
  effectiveCitationIdentifierValueSql,
  settledCitationSql,
} from "@/api/handlers/case-law/citation-resolution-status";
import {
  decisionIdentifierTypeOfCitation,
  decisionIdentifiersFromStoredMetadata,
  normalizeDecisionIdentifier,
  normalizeDecisionIdentifierValue,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { isRecord } from "@/api/lib/type-guards";

export const DECISION_IDENTIFIER_BACKFILL_VERSION = "typed-identifiers-v1";
const POSTGRESQL_MAX_BIND_PARAMETERS = 65_535;
// Leave more than one thousand bind slots for statuses, checkpoint values,
// and future fixed query parameters beyond the page-expanded VALUES lists.
const POSTGRESQL_BIND_PARAMETER_RESERVE = 1024;
const DECISION_IDENTIFIER_BIND_PARAMETERS = 4;
const DECISION_PAGE_BIND_PARAMETERS = 1;
export const MAX_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE = Math.floor(
  (POSTGRESQL_MAX_BIND_PARAMETERS - POSTGRESQL_BIND_PARAMETER_RESERVE) /
    (DECISION_IDENTIFIER_MAX_COUNT * DECISION_IDENTIFIER_BIND_PARAMETERS +
      DECISION_PAGE_BIND_PARAMETERS),
);
export const DEFAULT_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE =
  MAX_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE;
const MAX_DECISION_IDENTIFIER_BACKFILL_RESTARTS = 3;

type RunningBackfillPhase = Exclude<
  CaseLawDecisionIdentifierBackfillPhase,
  typeof CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE
>;

type BackfillCheckpointBase = {
  version: string;
  cursorId: string | null;
  decisionsScanned: number;
  citationsScanned: number;
};

type RunningBackfillCheckpoint = BackfillCheckpointBase & {
  phase: RunningBackfillPhase;
  completedAt: null;
};

type CompleteBackfillCheckpoint = BackfillCheckpointBase & {
  phase: typeof CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE;
  cursorId: null;
  completedAt: string;
};

type BackfillCheckpoint =
  | RunningBackfillCheckpoint
  | CompleteBackfillCheckpoint;

export type DecisionIdentifierBackfillGaps = {
  decisionIdentifierMismatches: number;
  citationIdentifierMismatches: number;
  pendingTypedCitations: number;
};

type VerifiedCheckpoint = {
  checkpoint: CompleteBackfillCheckpoint;
  gaps: DecisionIdentifierBackfillGaps;
};

export type DecisionIdentifierBackfillVerification =
  | ({ status: "ready-for-cutover" } & VerifiedCheckpoint)
  | ({ status: "awaiting-resolution-drain" } & VerifiedCheckpoint)
  | {
      status: "backfill-running";
      checkpoint: RunningBackfillCheckpoint;
      gaps: DecisionIdentifierBackfillGaps;
    }
  | {
      status: "backfill-required";
      checkpoint: CompleteBackfillCheckpoint | null;
      gaps: DecisionIdentifierBackfillGaps;
    };

type DecisionIdentifierBackfillPageProgress = {
  phase: RunningBackfillPhase;
  decisionsScanned: number;
  citationsScanned: number;
};

export type DecisionIdentifierBackfillProgress =
  | { type: "page"; progress: DecisionIdentifierBackfillPageProgress }
  | {
      type: "retry";
      attempt: number;
      verification: Exclude<
        DecisionIdentifierBackfillVerification,
        { status: "ready-for-cutover" | "awaiting-resolution-drain" }
      >;
    };

export type DecisionIdentifierBackfillResult = {
  status: "complete";
  verification: Extract<
    DecisionIdentifierBackfillVerification,
    { status: "ready-for-cutover" | "awaiting-resolution-drain" }
  >;
};

type DecisionIdentifierBackfillOptions = {
  batchSize?: number;
  onProgress?: (progress: DecisionIdentifierBackfillProgress) => void;
};

const rowsOf = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const numberOf = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0
    ? number
    : panic("Decision identifier backfill count is outside the safe range");
};

const isBackfillPhase = (
  value: unknown,
): value is CaseLawDecisionIdentifierBackfillPhase =>
  typeof value === "string" &&
  CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASES.some((phase) => phase === value);

const readCheckpoint = (result: unknown): BackfillCheckpoint | null => {
  const row = rowsOf(result).at(0);
  if (row === undefined) {
    return null;
  }
  if (
    !isRecord(row) ||
    typeof row["version"] !== "string" ||
    !isBackfillPhase(row["phase"]) ||
    (row["cursorId"] !== null && typeof row["cursorId"] !== "string") ||
    (row["completedAt"] !== null &&
      typeof row["completedAt"] !== "string" &&
      !(row["completedAt"] instanceof Date))
  ) {
    return panic("Decision identifier backfill checkpoint is malformed");
  }
  const checkpointBase = {
    version: row["version"],
    cursorId: row["cursorId"],
    decisionsScanned: numberOf(row["decisionsScanned"]),
    citationsScanned: numberOf(row["citationsScanned"]),
  };
  if (row["phase"] === CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE) {
    if (row["cursorId"] !== null || row["completedAt"] === null) {
      return panic("Completed decision identifier checkpoint is malformed");
    }
    return {
      ...checkpointBase,
      phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE,
      cursorId: null,
      completedAt:
        row["completedAt"] instanceof Date
          ? row["completedAt"].toISOString()
          : row["completedAt"],
    };
  }
  if (row["completedAt"] !== null) {
    return panic("Running decision identifier checkpoint is malformed");
  }
  return { ...checkpointBase, phase: row["phase"], completedAt: null };
};

const loadCheckpoint = async (
  tx: Transaction,
  lock: "for-update" | "none",
): Promise<BackfillCheckpoint | null> =>
  readCheckpoint(
    await tx.execute(sql`
      SELECT version, phase, cursor_id AS "cursorId",
             decisions_scanned AS "decisionsScanned",
             citations_scanned AS "citationsScanned",
             completed_at AS "completedAt"
      FROM case_law_decision_identifier_backfills
      WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
      ${lock === "for-update" ? sql`FOR UPDATE` : sql``}
    `),
  );

const ensureCheckpoint = async (rootDb: CaseLawRootHandle): Promise<void> => {
  await rootDb.execute(sql`
    INSERT INTO case_law_decision_identifier_backfills (version)
    VALUES (${DECISION_IDENTIFIER_BACKFILL_VERSION})
    ON CONFLICT (version) DO NOTHING
  `);
};

type DecisionRow = {
  id: string;
  caseNumber: string;
  ecli: string | null;
  metadata: Record<string, unknown>;
};

const readDecisionRows = (result: unknown): DecisionRow[] =>
  rowsOf(result).flatMap((row) =>
    isRecord(row) &&
    typeof row["id"] === "string" &&
    typeof row["caseNumber"] === "string"
      ? [
          {
            id: row["id"],
            caseNumber: row["caseNumber"],
            ecli: typeof row["ecli"] === "string" ? row["ecli"] : null,
            metadata: isRecord(row["metadata"]) ? row["metadata"] : {},
          },
        ]
      : [],
  );

type CitationRow = {
  id: string;
  citationText: string;
  identifierType: string | null;
  normalizedIdentifierValue: string | null;
};

const readCitationRows = (result: unknown): CitationRow[] =>
  rowsOf(result).flatMap((row) =>
    isRecord(row) &&
    typeof row["id"] === "string" &&
    typeof row["citationText"] === "string" &&
    (row["identifierType"] === null ||
      typeof row["identifierType"] === "string") &&
    (row["normalizedIdentifierValue"] === null ||
      typeof row["normalizedIdentifierValue"] === "string")
      ? [
          {
            id: row["id"],
            citationText: row["citationText"],
            identifierType: row["identifierType"],
            normalizedIdentifierValue: row["normalizedIdentifierValue"],
          },
        ]
      : [],
  );

type StoredIdentifierRow = {
  decisionId: string;
  type: string;
  value: string;
  normalizedValue: string;
};

const readStoredIdentifierRows = (result: unknown): StoredIdentifierRow[] =>
  rowsOf(result).flatMap((row) =>
    isRecord(row) &&
    typeof row["decisionId"] === "string" &&
    typeof row["type"] === "string" &&
    typeof row["value"] === "string" &&
    typeof row["normalizedValue"] === "string"
      ? [
          {
            decisionId: row["decisionId"],
            type: row["type"],
            value: row["value"],
            normalizedValue: row["normalizedValue"],
          },
        ]
      : [],
  );

const decisionRowsSql = (
  cursorId: string | null,
  batchSize: number,
  lock: boolean,
) => sql`
  SELECT decision.id::text AS id, decision.case_number AS "caseNumber",
         decision.ecli, decision.metadata
  FROM case_law_decisions decision
  ${cursorId === null ? sql`` : sql`WHERE decision.id > ${cursorId}::uuid`}
  ORDER BY decision.id
  LIMIT ${batchSize}
  ${lock ? sql`FOR NO KEY UPDATE OF decision` : sql``}
`;

const citationRowsSql = (
  cursorId: string | null,
  batchSize: number,
  lock: boolean,
) => sql`
  SELECT citation.id::text AS id, citation.citation_text AS "citationText",
         citation.identifier_type AS "identifierType",
         citation.normalized_identifier_value AS "normalizedIdentifierValue"
  FROM case_law_citations citation
  ${cursorId === null ? sql`` : sql`WHERE citation.id > ${cursorId}::uuid`}
  ORDER BY citation.id
  LIMIT ${batchSize}
  ${lock ? sql`FOR UPDATE OF citation` : sql``}
`;

const resetCheckpoint = async (
  tx: Transaction,
  phase:
    | typeof CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS
    | typeof CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
): Promise<void> => {
  await tx.execute(sql`
    UPDATE case_law_decision_identifier_backfills
    SET phase = ${phase}, cursor_id = NULL,
        decisions_scanned = CASE
          WHEN ${phase} = ${CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS}
            THEN 0 ELSE decisions_scanned END,
        citations_scanned = 0, completed_at = NULL,
        updated_at = clock_timestamp()
    WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
  `);
};

const projectDecisionPage = async (
  tx: Transaction,
  checkpoint: RunningBackfillCheckpoint,
  batchSize: number,
): Promise<DecisionIdentifierBackfillPageProgress> => {
  const rows = readDecisionRows(
    await tx.execute(decisionRowsSql(checkpoint.cursorId, batchSize, true)),
  );
  const last = rows.at(-1);
  if (last === undefined) {
    await tx.execute(sql`
      UPDATE case_law_decision_identifier_backfills
      SET phase = ${CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS},
          cursor_id = NULL, updated_at = clock_timestamp()
      WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
    `);
    return {
      phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
      decisionsScanned: checkpoint.decisionsScanned,
      citationsScanned: checkpoint.citationsScanned,
    };
  }
  const projections = rows.flatMap((row) => {
    const identifiers = identifiersForStoredDecision(row);
    return identifiers === null ? [] : [{ decisionId: row.id, identifiers }];
  });
  if (projections.length > 0) {
    const expected = sql.join(
      projections.flatMap(({ decisionId, identifiers }) =>
        identifiers.map(
          (identifier) =>
            sql`(${decisionId}::uuid, ${identifier.type}::varchar, ${identifier.value}::varchar, ${normalizeDecisionIdentifier(identifier)}::varchar)`,
        ),
      ),
      sql`, `,
    );
    const page = sql.join(
      projections.map(({ decisionId }) => sql`(${decisionId}::uuid)`),
      sql`, `,
    );

    // Match ingestion's decision-row-then-graph lock order. NO KEY UPDATE
    // excludes concurrent refreshes while remaining compatible with the
    // resolver's foreign-key KEY SHARE checks.
    await lockCitationGraph(tx);
    await tx.execute(sql`
    WITH expected(decision_id, type, value, normalized_value) AS (
      VALUES ${expected}
    ), page(decision_id) AS (VALUES ${page}),
    deleted AS (
      DELETE FROM case_law_decision_identifiers stored USING page
      WHERE stored.decision_id = page.decision_id
        AND NOT EXISTS (
          SELECT 1 FROM expected
          WHERE expected.decision_id = stored.decision_id
            AND expected.type = stored.type
            AND expected.normalized_value = stored.normalized_value
        )
      RETURNING stored.decision_id, stored.type, stored.normalized_value
    ), inserted AS (
      INSERT INTO case_law_decision_identifiers (
        decision_id, type, value, normalized_value
      ) SELECT decision_id, type, value, normalized_value FROM expected
      ON CONFLICT ON CONSTRAINT case_law_decision_identifiers_pk DO UPDATE
      SET value = EXCLUDED.value
      WHERE case_law_decision_identifiers.value IS DISTINCT FROM EXCLUDED.value
      RETURNING decision_id, type, normalized_value
    ), changed_identifiers AS (
      SELECT decision_id, type, normalized_value FROM deleted
      UNION
      SELECT decision_id, type, normalized_value FROM inserted
    ), reopened AS (
      UPDATE case_law_citations citation
      SET resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING},
          cited_decision_id = NULL, resolution_rule_id = NULL,
          resolution_attempted_at = NULL
      WHERE ${settledCitationSql(sql.raw("citation.resolution_status"))}
        AND EXISTS (
          SELECT 1 FROM changed_identifiers changed
          WHERE changed.type = ${effectiveCitationIdentifierTypeSql(
            sql.raw("citation.identifier_type"),
          )}
            AND changed.normalized_value = ${effectiveCitationIdentifierValueSql(
              sql.raw("citation.normalized_identifier_value"),
              sql.raw("citation.citation_key"),
            )}
        )
      RETURNING citation.id
    ), changed_decisions AS (
      SELECT DISTINCT decision_id FROM changed_identifiers
    )
    UPDATE case_law_decisions decision
    SET indexed_hash = NULL, updated_at = clock_timestamp()
    WHERE decision.id IN (SELECT decision_id FROM changed_decisions)
  `);
  }
  const decisionsScanned = checkpoint.decisionsScanned + rows.length;
  await tx.execute(sql`
    UPDATE case_law_decision_identifier_backfills
    SET cursor_id = ${last.id}::uuid, decisions_scanned = ${decisionsScanned},
        updated_at = clock_timestamp()
    WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
  `);
  return {
    phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS,
    decisionsScanned,
    citationsScanned: checkpoint.citationsScanned,
  };
};

const citationProjection = ({ citationText }: CitationRow) => {
  const type = decisionIdentifierTypeOfCitation(citationText);
  return {
    type,
    normalizedValue: normalizeDecisionIdentifierValue(type, citationText),
  };
};

const projectCitationPage = async (
  tx: Transaction,
  checkpoint: RunningBackfillCheckpoint,
  batchSize: number,
): Promise<DecisionIdentifierBackfillPageProgress> => {
  // Resolver batches take the graph lock before citation row locks too.
  await lockCitationGraph(tx);
  const rows = readCitationRows(
    await tx.execute(citationRowsSql(checkpoint.cursorId, batchSize, true)),
  );
  const last = rows.at(-1);
  if (last === undefined) {
    await tx.execute(sql`
      UPDATE case_law_decision_identifier_backfills
      SET phase = ${CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS},
          cursor_id = NULL, updated_at = clock_timestamp()
      WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
    `);
    return {
      phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
      decisionsScanned: checkpoint.decisionsScanned,
      citationsScanned: checkpoint.citationsScanned,
    };
  }
  const projected = sql.join(
    rows.map((row) => {
      const { type, normalizedValue } = citationProjection(row);
      return sql`(${row.id}::uuid, ${type}::varchar, ${normalizedValue}::varchar)`;
    }),
    sql`, `,
  );
  await tx.execute(sql`
    WITH projected(id, type, normalized_value) AS (VALUES ${projected})
    UPDATE case_law_citations citation
    SET identifier_type = projected.type,
        normalized_identifier_value = projected.normalized_value,
        resolution_status = CASE
          WHEN citation.identifier_type IS NULL
            AND projected.type = ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
            THEN citation.resolution_status
          WHEN citation.identifier_type = projected.type
            AND citation.normalized_identifier_value = projected.normalized_value
            THEN citation.resolution_status
          ELSE ${CITATION_RESOLUTION_STATUS.PENDING} END,
        cited_decision_id = CASE
          WHEN citation.identifier_type IS NULL
            AND projected.type = ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
            THEN citation.cited_decision_id
          WHEN citation.identifier_type = projected.type
            AND citation.normalized_identifier_value = projected.normalized_value
            THEN citation.cited_decision_id
          ELSE NULL END,
        resolution_rule_id = CASE
          WHEN citation.identifier_type IS NULL
            AND projected.type = ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
            THEN citation.resolution_rule_id
          WHEN citation.identifier_type = projected.type
            AND citation.normalized_identifier_value = projected.normalized_value
            THEN citation.resolution_rule_id
          ELSE NULL END,
        resolution_attempted_at = CASE
          WHEN citation.identifier_type IS NULL
            AND projected.type = ${DECISION_IDENTIFIER_TYPES.CASE_NUMBER}
            THEN citation.resolution_attempted_at
          WHEN citation.identifier_type = projected.type
            AND citation.normalized_identifier_value = projected.normalized_value
            THEN citation.resolution_attempted_at
          ELSE NULL END
    FROM projected
    WHERE citation.id = projected.id
      AND (citation.identifier_type IS DISTINCT FROM projected.type
        OR citation.normalized_identifier_value IS DISTINCT FROM projected.normalized_value)
  `);
  const citationsScanned = checkpoint.citationsScanned + rows.length;
  await tx.execute(sql`
    UPDATE case_law_decision_identifier_backfills
    SET cursor_id = ${last.id}::uuid, citations_scanned = ${citationsScanned},
        updated_at = clock_timestamp()
    WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
  `);
  return {
    phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
    decisionsScanned: checkpoint.decisionsScanned,
    citationsScanned,
  };
};

const identifierKey = ({
  type,
  value,
  normalizedValue,
}: Omit<StoredIdentifierRow, "decisionId">): string =>
  `${type}\u0000${normalizedValue}\u0000${value}`;

const identifiersForStoredDecision = (
  row: DecisionRow,
): DecisionIdentifiers | null => {
  const caseNumberIdentifier = {
    type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
    value: row.caseNumber,
  } as const;
  return normalizeDecisionIdentifier(caseNumberIdentifier)
    ? decisionIdentifiersFromStoredMetadata(row)
    : null;
};

const decisionMismatchCount = async (
  tx: Transaction,
  rows: readonly DecisionRow[],
): Promise<number> => {
  if (rows.length === 0) {
    return 0;
  }
  const ids = sql.join(
    rows.map(({ id }) => sql`${id}`),
    sql`, `,
  );
  const stored = readStoredIdentifierRows(
    await tx.execute(sql`
    SELECT decision_id::text AS "decisionId", type, value,
           normalized_value AS "normalizedValue"
    FROM case_law_decision_identifiers
    WHERE decision_id = ANY (ARRAY[${ids}]::uuid[])
  `),
  );
  const storedByDecision = Map.groupBy(stored, ({ decisionId }) => decisionId);
  return rows.filter((row) => {
    const identifiers = identifiersForStoredDecision(row);
    if (identifiers === null) {
      return true;
    }
    const expected = new Set(
      identifiers.map((identifier) =>
        identifierKey({
          type: identifier.type,
          value: identifier.value,
          normalizedValue: normalizeDecisionIdentifier(identifier),
        }),
      ),
    );
    const actual = new Set(storedByDecision.get(row.id)?.map(identifierKey));
    return (
      expected.size !== actual.size ||
      [...expected].some((identifier) => !actual.has(identifier))
    );
  }).length;
};

const citationMismatchCount = (rows: readonly CitationRow[]): number =>
  rows.filter((row) => {
    const expected = citationProjection(row);
    return (
      row.identifierType !== expected.type ||
      row.normalizedIdentifierValue !== expected.normalizedValue
    );
  }).length;

type VerificationPageResult =
  | { status: "progress"; progress: DecisionIdentifierBackfillPageProgress }
  | { status: "retry" };

const verifyDecisionPage = async (
  tx: Transaction,
  checkpoint: RunningBackfillCheckpoint,
  batchSize: number,
): Promise<VerificationPageResult> => {
  const rows = readDecisionRows(
    await tx.execute(decisionRowsSql(checkpoint.cursorId, batchSize, false)),
  );
  const last = rows.at(-1);
  if (last === undefined) {
    await tx.execute(sql`
      UPDATE case_law_decision_identifier_backfills
      SET phase = ${CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_CITATIONS},
          cursor_id = NULL, updated_at = clock_timestamp()
      WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
    `);
    return {
      status: "progress",
      progress: {
        phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_CITATIONS,
        decisionsScanned: checkpoint.decisionsScanned,
        citationsScanned: checkpoint.citationsScanned,
      },
    };
  }
  if ((await decisionMismatchCount(tx, rows)) > 0) {
    await resetCheckpoint(
      tx,
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS,
    );
    return { status: "retry" };
  }
  await tx.execute(sql`
    UPDATE case_law_decision_identifier_backfills
    SET cursor_id = ${last.id}::uuid, updated_at = clock_timestamp()
    WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
  `);
  return {
    status: "progress",
    progress: {
      phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS,
      decisionsScanned: checkpoint.decisionsScanned,
      citationsScanned: checkpoint.citationsScanned,
    },
  };
};

const verifyCitationPage = async (
  tx: Transaction,
  checkpoint: RunningBackfillCheckpoint,
  batchSize: number,
): Promise<VerificationPageResult | { status: "completed" }> => {
  const rows = readCitationRows(
    await tx.execute(citationRowsSql(checkpoint.cursorId, batchSize, false)),
  );
  const last = rows.at(-1);
  if (last === undefined) {
    await tx.execute(sql`
      UPDATE case_law_decision_identifier_backfills
      SET phase = ${CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE},
          cursor_id = NULL, completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
    `);
    return { status: "completed" };
  }
  if (citationMismatchCount(rows) > 0) {
    await resetCheckpoint(
      tx,
      CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
    );
    return { status: "retry" };
  }
  await tx.execute(sql`
    UPDATE case_law_decision_identifier_backfills
    SET cursor_id = ${last.id}::uuid, updated_at = clock_timestamp()
    WHERE version = ${DECISION_IDENTIFIER_BACKFILL_VERSION}
  `);
  return {
    status: "progress",
    progress: {
      phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_CITATIONS,
      decisionsScanned: checkpoint.decisionsScanned,
      citationsScanned: checkpoint.citationsScanned,
    },
  };
};

type BackfillPageResult =
  | { status: "progress"; progress: DecisionIdentifierBackfillPageProgress }
  | { status: "retry" }
  | { status: "completed" };

const runBackfillPage = async (
  rootDb: CaseLawRootHandle,
  batchSize: number,
): Promise<BackfillPageResult> =>
  await rootDb.transaction(async (tx) => {
    const checkpoint = await loadCheckpoint(tx, "for-update");
    if (checkpoint === null) {
      return panic("Decision identifier backfill checkpoint is missing");
    }
    switch (checkpoint.phase) {
      case CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS:
        return {
          status: "progress",
          progress: await projectDecisionPage(tx, checkpoint, batchSize),
        };
      case CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS:
        return {
          status: "progress",
          progress: await projectCitationPage(tx, checkpoint, batchSize),
        };
      case CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_DECISIONS:
        return await verifyDecisionPage(tx, checkpoint, batchSize);
      case CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.VERIFY_CITATIONS:
        return await verifyCitationPage(tx, checkpoint, batchSize);
      case CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE:
        return { status: "completed" };
      default: {
        checkpoint satisfies never;
        return panic(`Unhandled checkpoint: ${String(checkpoint)}`);
      }
    }
  });

const normalizeBatchSize = (batchSize: number | undefined): number => {
  const normalized =
    batchSize ?? DEFAULT_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE;
  if (
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE
  ) {
    return panic(
      `Decision identifier backfill batch size must be an integer from 1 to ${MAX_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE}`,
    );
  }
  return normalized;
};

const countPendingTypedCitations = async (
  rootDb: CaseLawRootHandle,
): Promise<number> =>
  await rootDb.transaction(async (tx) => {
    const row = rowsOf(
      await tx.execute(sql`
      SELECT count(*) AS count FROM case_law_citations
      WHERE identifier_type IS NOT NULL
        AND resolution_status = ${CITATION_RESOLUTION_STATUS.PENDING}
    `),
    ).at(0);
    return isRecord(row)
      ? numberOf(row["count"])
      : panic("Citation drain verification returned no count");
  });

type ExactMismatchCounts = Pick<
  DecisionIdentifierBackfillGaps,
  "decisionIdentifierMismatches" | "citationIdentifierMismatches"
>;

type CursorPage<T> = { cursor: string | null; value: T };

const cursorPages = <T>(
  readPage: (cursor: string | null) => Promise<CursorPage<T>>,
): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: () => {
    let cursor: string | null = null;
    let exhausted = false;
    return {
      next: async () => {
        if (exhausted) {
          return { done: true, value: undefined };
        }
        const page = await readPage(cursor);
        if (page.cursor === null) {
          exhausted = true;
        } else {
          cursor = page.cursor;
        }
        return { done: false, value: page.value };
      },
    };
  },
});

const countExactMismatches = async (
  rootDb: CaseLawRootHandle,
  batchSize: number,
): Promise<ExactMismatchCounts> => {
  let decisionIdentifierMismatches = 0;
  const decisionPages = cursorPages(
    async (cursor) =>
      await rootDb.transaction(async (tx) => {
        const rows = readDecisionRows(
          await tx.execute(decisionRowsSql(cursor, batchSize, false)),
        );
        return {
          cursor: rows.at(-1)?.id ?? null,
          value: await decisionMismatchCount(tx, rows),
        };
      }),
  );
  for await (const mismatches of decisionPages) {
    decisionIdentifierMismatches += mismatches;
  }

  let citationIdentifierMismatches = 0;
  const citationPages = cursorPages(
    async (cursor) =>
      await rootDb.transaction(async (tx) => {
        const rows = readCitationRows(
          await tx.execute(citationRowsSql(cursor, batchSize, false)),
        );
        return {
          cursor: rows.at(-1)?.id ?? null,
          value: citationMismatchCount(rows),
        };
      }),
  );
  for await (const mismatches of citationPages) {
    citationIdentifierMismatches += mismatches;
  }
  return { decisionIdentifierMismatches, citationIdentifierMismatches };
};

export const verifyDecisionIdentifierBackfill = async (
  rootDb: CaseLawRootHandle,
  batchSize = DEFAULT_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE,
): Promise<DecisionIdentifierBackfillVerification> => {
  const normalizedBatchSize = normalizeBatchSize(batchSize);
  const checkpoint = await rootDb.transaction(
    async (tx) => await loadCheckpoint(tx, "none"),
  );
  const exact = await countExactMismatches(rootDb, normalizedBatchSize);
  const gaps = {
    ...exact,
    pendingTypedCitations: await countPendingTypedCitations(rootDb),
  };
  if (checkpoint === null) {
    return { status: "backfill-required", checkpoint: null, gaps };
  }
  if (
    checkpoint.phase !== CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE
  ) {
    return { status: "backfill-running", checkpoint, gaps };
  }
  if (
    gaps.decisionIdentifierMismatches > 0 ||
    gaps.citationIdentifierMismatches > 0
  ) {
    return { status: "backfill-required", checkpoint, gaps };
  }
  return gaps.pendingTypedCitations === 0
    ? { status: "ready-for-cutover", checkpoint, gaps }
    : { status: "awaiting-resolution-drain", checkpoint, gaps };
};

const restartCompletedBackfill = async (
  rootDb: CaseLawRootHandle,
  verification: Extract<
    DecisionIdentifierBackfillVerification,
    { status: "backfill-required" }
  >,
): Promise<void> => {
  if (verification.checkpoint === null) {
    return;
  }
  await rootDb.transaction(async (tx) => {
    await loadCheckpoint(tx, "for-update");
    await resetCheckpoint(
      tx,
      verification.gaps.decisionIdentifierMismatches > 0
        ? CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS
        : CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.CITATIONS,
    );
  });
};

type BackfillIteration =
  | { status: "progress"; progress: DecisionIdentifierBackfillPageProgress }
  | {
      status: "retry";
      verification: Exclude<
        DecisionIdentifierBackfillVerification,
        { status: "ready-for-cutover" | "awaiting-resolution-drain" }
      >;
    }
  | {
      status: "complete";
      verification: DecisionIdentifierBackfillResult["verification"];
    };

const advanceBackfill = async (
  rootDb: CaseLawRootHandle,
  batchSize: number,
): Promise<BackfillIteration> => {
  const result = await runBackfillPage(rootDb, batchSize);
  if (result.status === "progress") {
    return result;
  }
  const verification = await verifyDecisionIdentifierBackfill(
    rootDb,
    batchSize,
  );
  if (
    verification.status === "ready-for-cutover" ||
    verification.status === "awaiting-resolution-drain"
  ) {
    return { status: "complete", verification };
  }
  return { status: "retry", verification };
};

const backfillIterations = (
  rootDb: CaseLawRootHandle,
  batchSize: number,
): AsyncIterable<BackfillIteration> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => ({
      done: false,
      value: await advanceBackfill(rootDb, batchSize),
    }),
  }),
});

export const runDecisionIdentifierBackfill = async (
  rootDb: CaseLawRootHandle,
  {
    batchSize: requestedBatchSize,
    onProgress,
  }: DecisionIdentifierBackfillOptions = {},
): Promise<DecisionIdentifierBackfillResult> => {
  const batchSize = normalizeBatchSize(requestedBatchSize);
  await ensureCheckpoint(rootDb);
  const checkpoint = await rootDb.transaction(
    async (tx) => await loadCheckpoint(tx, "none"),
  );
  if (checkpoint === null) {
    return panic("Decision identifier backfill checkpoint was not created");
  }
  let retryCount = 0;
  for await (const result of backfillIterations(rootDb, batchSize)) {
    switch (result.status) {
      case "progress":
        onProgress?.({ type: "page", progress: result.progress });
        break;
      case "retry": {
        retryCount += 1;
        if (retryCount > MAX_DECISION_IDENTIFIER_BACKFILL_RESTARTS) {
          return panic(
            `Decision identifier backfill did not converge after ${MAX_DECISION_IDENTIFIER_BACKFILL_RESTARTS} retries: ${JSON.stringify({ status: result.verification.status, gaps: result.verification.gaps })}`,
          );
        }
        onProgress?.({
          type: "retry",
          attempt: retryCount,
          verification: result.verification,
        });
        if (result.verification.status === "backfill-required") {
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded restart: one checkpoint reset per retry, capped at three
          await restartCompletedBackfill(rootDb, result.verification);
        }
        break;
      }
      case "complete":
        return { status: "complete", verification: result.verification };
      default: {
        result satisfies never;
        return panic(`Unhandled result: ${String(result)}`);
      }
    }
  }
  return panic("Decision identifier backfill iterator ended before completion");
};
