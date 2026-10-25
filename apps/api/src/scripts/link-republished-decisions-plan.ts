import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import { republishedRulingCourtPredicate } from "@/api/handlers/case-law/ingestion/pipeline/ruling-identity-match";
import type { SafeId } from "@/api/lib/branded-types";
import { lockCaseLawRepublication } from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Database plan for `link-republished-decisions.ts`.
 *
 * This module has no entrypoint side effects, so its complete selection and
 * mutation can be exercised against PostgreSQL. A candidate is deliberately
 * narrower than a probable duplicate: both rows must have the same complete
 * ruling identity, come from different publishers, and be each other's only
 * cross-publisher match.
 */

export const SOURCE_AUTHORITY = {
  [ADAPTER_KEYS.CZ_REGIONAL]: 0,
  [ADAPTER_KEYS.CZ_NS]: 0,
  [ADAPTER_KEYS.CZ_NSS]: 0,
  [ADAPTER_KEYS.CZ_US]: 0,
  [ADAPTER_KEYS.CZ_UOHS]: 0,
  [ADAPTER_KEYS.BR_TST]: 0,
  [ADAPTER_KEYS.SK_COURTS]: 1,
  [ADAPTER_KEYS.SK_US]: 0,
  [ADAPTER_KEYS.PL_COURTS]: 1,
  [ADAPTER_KEYS.PL_SN]: 0,
  [ADAPTER_KEYS.PL_KIO]: 0,
  [ADAPTER_KEYS.PL_TK]: 0,
  [ADAPTER_KEYS.PL_NSA]: 0,
  [ADAPTER_KEYS.PL_NCOURT]: 0,
  [ADAPTER_KEYS.AT_COURTS]: 1,
  [ADAPTER_KEYS.AT_VFGH]: 0,
  [ADAPTER_KEYS.AT_VWGH]: 0,
  [ADAPTER_KEYS.AT_BVWG]: 0,
  [ADAPTER_KEYS.AT_LVWG]: 0,
  [ADAPTER_KEYS.AT_ASYLGH]: 0,
  [ADAPTER_KEYS.AT_UBAS]: 0,
  [ADAPTER_KEYS.AT_UVS]: 0,
  [ADAPTER_KEYS.AT_VERG]: 0,
  [ADAPTER_KEYS.AT_UMSE]: 0,
  [ADAPTER_KEYS.AT_BKS]: 0,
  [ADAPTER_KEYS.AT_FINDOK]: 1,
  [ADAPTER_KEYS.EU_ECJ]: 0,
  [ADAPTER_KEYS.HU_BHGY]: 0,
  [ADAPTER_KEYS.PL_KIS]: 0,
  [ADAPTER_KEYS.PL_UODO]: 0,
  [ADAPTER_KEYS.PL_UOKIK]: 0,
} as const satisfies Record<AdapterKey, number>;

type CandidateSide = {
  adapterKey: AdapterKey;
  createdAt: Date;
  id: SafeId<"caseLawDecision">;
};

type PlanTransaction = {
  execute: (query: SQL) => PromiseLike<unknown>;
};

export type RepublishedDecisionReport = {
  outcomes: {
    linked: number;
    separateAliasGroupSurvivor: number;
    separateAlreadyRetired: number;
    separateAmbiguous: number;
    separatePartial: {
      dateAbsent: number;
      dateDiffers: number;
      signatureAbsent: number;
      typeAbsent: number;
      typeDiffers: number;
    };
  };
  bySource: ReadonlyMap<string, number>;
};

export type RepublishedDecisionCandidate = {
  canonical: CandidateSide;
  duplicate: CandidateSide;
  disposition: CandidateDisposition;
};

type CandidateDisposition =
  "link" | "separate_alias_group_survivor" | "separate_already_retired";

export type ApplyRepublishedDecisionOutcome =
  | { type: "linked"; retiredId: SafeId<"caseLawDecision"> }
  | {
      type: "separate_alias_group_survivor";
      retiredId: SafeId<"caseLawDecision">;
    }
  | {
      type: "separate_already_retired";
      retiredId: SafeId<"caseLawDecision">;
    }
  | { type: "skipped_erased"; retiredId: SafeId<"caseLawDecision"> };

export type ReverseRepublishedDecisionOutcome =
  | { type: "reversed"; retiredId: SafeId<"caseLawDecision"> }
  | { type: "refused_erased"; retiredId: SafeId<"caseLawDecision"> }
  | { type: "refused_unrestorable"; retiredId: SafeId<"caseLawDecision"> };

const isAdapterKey = (value: string): value is AdapterKey =>
  Object.values(ADAPTER_KEYS).some((candidate) => candidate === value);

const adapterKey = (value: unknown): AdapterKey => {
  if (typeof value !== "string" || !isAdapterKey(value)) {
    return panic(
      "Republished-decision selection returned an unknown adapter key",
    );
  }
  return value;
};

const side = (
  row: Record<string, unknown>,
  prefix: "left" | "right",
): CandidateSide => {
  const id = row[`${prefix}Id`];
  const rawCreatedAt = row[`${prefix}CreatedAt`];
  if (
    typeof id !== "string" ||
    (typeof rawCreatedAt !== "string" && !(rawCreatedAt instanceof Date))
  ) {
    return panic("Republished-decision selection returned an invalid row");
  }
  const createdAt =
    rawCreatedAt instanceof Date ? rawCreatedAt : new Date(rawCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    return panic(
      "Republished-decision selection returned an invalid timestamp",
    );
  }
  return {
    adapterKey: adapterKey(row[`${prefix}AdapterKey`]),
    createdAt,
    id: brandPersistedCaseLawDecisionId(id),
  };
};

const pairStateSql = (duplicateId: SQL, canonicalId: SQL) => {
  const survivor = sql`EXISTS (SELECT 1 FROM case_law_decision_aliases alias
                                WHERE alias.canonical_decision_id = ${duplicateId})`;
  const alreadyRetired = sql`EXISTS (SELECT 1 FROM case_law_decision_aliases alias
                                     WHERE alias.retired_decision_id IN (${duplicateId}, ${canonicalId}))`;
  return {
    actionable: sql`NOT (${survivor}) AND NOT (${alreadyRetired})`,
    alreadyRetired,
    survivor,
  };
};

const sourceAuthoritySql = (sourceAdapterKey: SQL): SQL =>
  sqlCaseFragment({
    branches: Object.entries(SOURCE_AUTHORITY).map(
      ([key, authority]) => sql`WHEN ${key} THEN ${authority}`,
    ),
    fallback: sql`2147483647`,
    operand: sourceAdapterKey,
  });

const candidatePairsSql = (until: Date): SQL => {
  const sameCourt = republishedRulingCourtPredicate(
    { court: sql`a.court`, courtId: sql`a.court_id` },
    { court: sql`b.court`, courtId: sql`b.court_id` },
  );
  const leftFirst = sql`(
    ${sourceAuthoritySql(sql`a_source.adapter_key`)} < ${sourceAuthoritySql(sql`b_source.adapter_key`)}
    OR (${sourceAuthoritySql(sql`a_source.adapter_key`)} = ${sourceAuthoritySql(sql`b_source.adapter_key`)}
        AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id < b.id)))
  )`;
  return sql`
    pairs AS MATERIALIZED (
      SELECT a.id AS left_id, b.id AS right_id
        FROM case_law_decisions a
        JOIN case_law_decisions b
          ON a.id < b.id
         AND a.source_id <> b.source_id
         AND a.country = b.country
         AND ${sameCourt}
         AND a.docket_family_key = b.docket_family_key
         AND a.decision_date = b.decision_date
         AND lower(a.decision_type) = lower(b.decision_type)
       WHERE a.docket_family_key IS NOT NULL
         AND a.redacted_at IS NULL
         AND b.redacted_at IS NULL
         AND a.created_at <= ${until}::timestamptz
         AND b.created_at <= ${until}::timestamptz
         AND a.decision_date IS NOT NULL
         AND a.decision_type IS NOT NULL
    ), singles AS MATERIALIZED (
      SELECT p.*
        FROM pairs p
       WHERE (SELECT count(*) FROM pairs q WHERE q.left_id = p.left_id OR q.right_id = p.left_id) = 1
         AND (SELECT count(*) FROM pairs q WHERE q.left_id = p.right_id OR q.right_id = p.right_id) = 1
    ), classified AS MATERIALIZED (
      SELECT CASE WHEN ${leftFirst} THEN a.id ELSE b.id END AS canonical_id,
             CASE WHEN ${leftFirst} THEN b.id ELSE a.id END AS duplicate_id
        FROM singles p
        JOIN case_law_decisions a ON a.id = p.left_id
        JOIN case_law_sources a_source ON a_source.id = a.source_id
        JOIN case_law_decisions b ON b.id = p.right_id
        JOIN case_law_sources b_source ON b_source.id = b.source_id
    )`;
};

/** One bounded, stable page. A complete identity requires date, type and docket. */
export const selectRepublishedDecisionCandidatesStatement = (
  limit: number,
  until: Date = new Date("9999-12-31T23:59:59.999Z"),
) => {
  const pairState = pairStateSql(sql`p.duplicate_id`, sql`p.canonical_id`);
  return sql`
  WITH ${candidatePairsSql(until)}, actionable AS (
    SELECT p.*
      FROM classified p
     WHERE ${pairState.actionable}
     ORDER BY p.canonical_id, p.duplicate_id
     LIMIT ${limit}
  )
  SELECT l.id AS "leftId", ls.adapter_key AS "leftAdapterKey", l.created_at AS "leftCreatedAt",
         r.id AS "rightId", rs.adapter_key AS "rightAdapterKey", r.created_at AS "rightCreatedAt"
    FROM actionable p
    JOIN case_law_decisions l ON l.id = p.canonical_id
    JOIN case_law_sources ls ON ls.id = l.source_id
    JOIN case_law_decisions r ON r.id = p.duplicate_id
    JOIN case_law_sources rs ON rs.id = r.source_id
   ORDER BY l.id, r.id
`;
};

export const selectRepublishedDecisionCandidates = async (
  tx: PlanTransaction,
  limit: number,
  until?: Date,
): Promise<RepublishedDecisionCandidate[]> =>
  executedRows(
    await tx.execute(
      selectRepublishedDecisionCandidatesStatement(limit, until),
    ),
  ).map((value) => {
    if (!isRecord(value)) {
      return panic("Republished-decision selection returned a non-row");
    }
    return {
      canonical: side(value, "left"),
      disposition: "link",
      duplicate: side(value, "right"),
    } satisfies RepublishedDecisionCandidate;
  });

const reportCount = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    return panic("Republished-decision report returned an invalid count");
  }
  return Number(value);
};

/** Re-read the current corpus rather than predicting the effect of a repair page. */
export const selectRepublishedDecisionReport = async (
  tx: PlanTransaction,
): Promise<RepublishedDecisionReport> => {
  const candidates = await selectRepublishedDecisionCandidates(
    tx,
    2_147_483_647,
  );
  const pairState = pairStateSql(sql`p.duplicate_id`, sql`p.canonical_id`);
  const refusalRows = executedRows(
    await tx.execute(sql`
      WITH ${candidatePairsSql(new Date("9999-12-31T23:59:59.999Z"))}
      SELECT count(*) FILTER (WHERE ${pairState.survivor}) AS "survivor",
             count(*) FILTER (WHERE NOT (${pairState.survivor}) AND ${pairState.alreadyRetired}) AS "alreadyRetired"
        FROM classified p
    `),
  );
  const refusalRow = refusalRows.at(0);
  if (!isRecord(refusalRow)) {
    return panic("Republished-decision refusal report returned an invalid row");
  }
  const bySource = new Map<string, number>();
  for (const { disposition, duplicate } of candidates) {
    if (disposition !== "link") {
      continue;
    }
    bySource.set(
      duplicate.adapterKey,
      (bySource.get(duplicate.adapterKey) ?? 0) + 1,
    );
  }

  const rows = executedRows(
    await tx.execute(sql`
      WITH active AS MATERIALIZED (
        SELECT d.*
          FROM case_law_decisions d
         WHERE NOT EXISTS (
           SELECT 1 FROM case_law_decision_aliases a
            WHERE a.retired_decision_id = d.id
         )
      ), comparable AS MATERIALIZED (
        SELECT d.id,
               d.decision_date,
               d.decision_type,
               d.docket_family_key,
               count(p.id) FILTER (
                 WHERE d.decision_date = p.decision_date
                   AND lower(d.decision_type) = lower(p.decision_type)
               ) AS exact_count,
               bool_or(d.decision_date <> p.decision_date) AS date_differs
          FROM active d
          JOIN active p
            ON p.id <> d.id
           AND p.source_id <> d.source_id
           AND p.country = d.country
           AND p.court = d.court
           AND (d.docket_family_key IS NULL OR p.docket_family_key = d.docket_family_key)
         GROUP BY d.id, d.decision_date, d.decision_type, d.docket_family_key
      )
      SELECT count(*) FILTER (WHERE docket_family_key IS NOT NULL AND decision_date IS NULL) AS "dateAbsent",
             count(*) FILTER (WHERE docket_family_key IS NOT NULL AND decision_date IS NOT NULL AND decision_type IS NULL) AS "typeAbsent",
             count(*) FILTER (WHERE docket_family_key IS NULL) AS "signatureAbsent",
             count(*) FILTER (WHERE docket_family_key IS NOT NULL AND decision_date IS NOT NULL AND decision_type IS NOT NULL AND exact_count > 1) AS "separateAmbiguous",
             count(*) FILTER (WHERE docket_family_key IS NOT NULL AND decision_date IS NOT NULL AND decision_type IS NOT NULL AND exact_count = 0 AND date_differs) AS "dateDiffers",
             count(*) FILTER (WHERE docket_family_key IS NOT NULL AND decision_date IS NOT NULL AND decision_type IS NOT NULL AND exact_count = 0 AND NOT date_differs) AS "typeDiffers"
        FROM comparable
    `),
  );
  const row = rows.at(0);
  if (!isRecord(row)) {
    return panic("Republished-decision report returned an invalid row");
  }
  return {
    outcomes: {
      linked: candidates.filter(({ disposition }) => disposition === "link")
        .length,
      separateAliasGroupSurvivor: reportCount(refusalRow, "survivor"),
      separateAlreadyRetired: reportCount(refusalRow, "alreadyRetired"),
      separateAmbiguous: reportCount(row, "separateAmbiguous"),
      separatePartial: {
        dateAbsent: reportCount(row, "dateAbsent"),
        dateDiffers: reportCount(row, "dateDiffers"),
        signatureAbsent: reportCount(row, "signatureAbsent"),
        typeAbsent: reportCount(row, "typeAbsent"),
        typeDiffers: reportCount(row, "typeDiffers"),
      },
    },
    bySource,
  };
};

type Reconcile = (
  candidates: readonly RepublishedDecisionCandidate[],
  direction: "apply" | "reverse",
) => Promise<void>;

const decisionIdArray = (
  candidates: readonly RepublishedDecisionCandidate[],
  candidateSide: "canonical" | "duplicate",
): SQL =>
  sql`ARRAY[${sql.join(
    candidates.map((candidate) => sql`${candidate[candidateSide].id}`),
    sql`, `,
  )}]::uuid[]`;

/** Apply one selected page atomically. No decision or identity row is inserted. */
export const applyRepublishedDecisionBatch = async (
  tx: PlanTransaction,
  candidates: readonly RepublishedDecisionCandidate[],
  reconcile: Reconcile,
): Promise<ApplyRepublishedDecisionOutcome[]> => {
  if (candidates.length === 0) {
    return [];
  }
  await lockCaseLawRepublication({ tx, mode: "exclusive" });
  const pairState = pairStateSql(
    sql`requested.retired_id`,
    sql`requested.canonical_id`,
  );
  const rows = executedRows(
    await tx.execute(sql`
      WITH requested AS MATERIALIZED (
        SELECT retired_id, canonical_id
          FROM unnest(
            ${decisionIdArray(candidates, "duplicate")},
            ${decisionIdArray(candidates, "canonical")}
          ) AS pair(retired_id, canonical_id)
      ), pairs AS MATERIALIZED (
        SELECT requested.retired_id, requested.canonical_id,
               retired.redacted_at IS NOT NULL OR canonical.redacted_at IS NOT NULL AS erased,
               ${pairState.survivor} AS survivor,
               ${pairState.alreadyRetired} AS already_retired,
               ${pairState.actionable} AS actionable
          FROM requested
          JOIN case_law_decisions retired ON retired.id = requested.retired_id
          JOIN case_law_decisions canonical ON canonical.id = requested.canonical_id
      ), moved AS (
        UPDATE case_law_decision_source_identities identity
           SET decision_id = pair.canonical_id
          FROM pairs pair
         WHERE NOT pair.erased
           AND pair.actionable
           AND identity.decision_id = pair.retired_id
        RETURNING pair.retired_id, pair.canonical_id,
                  identity.source_id, identity.source_document_id
      ), aliases AS (
        INSERT INTO case_law_decision_aliases
          (retired_decision_id, canonical_decision_id)
        SELECT DISTINCT retired_id, canonical_id
          FROM moved
        RETURNING retired_decision_id
      ), moved_identities AS (
        INSERT INTO case_law_decision_alias_moved_identities
          (retired_decision_id, source_id, source_document_id)
        SELECT moved.retired_id, moved.source_id, moved.source_document_id
          FROM moved
          JOIN aliases ON aliases.retired_decision_id = moved.retired_id
        RETURNING retired_decision_id
      )
      SELECT pairs.retired_id AS "retiredId", pairs.erased AS "skippedErased",
             pairs.survivor AS "survivor", pairs.already_retired AS "alreadyRetired"
        FROM pairs
        LEFT JOIN aliases ON aliases.retired_decision_id = pairs.retired_id
       WHERE (SELECT count(*) FROM moved_identities) >= 0
         AND (pairs.erased OR pairs.survivor OR pairs.already_retired
              OR aliases.retired_decision_id IS NOT NULL)
       ORDER BY pairs.retired_id
    `),
  );
  const appliedIds = new Set<string>();
  const outcomes: ApplyRepublishedDecisionOutcome[] = [];
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row["retiredId"] !== "string" ||
      typeof row["skippedErased"] !== "boolean"
    ) {
      return panic("Republished-decision apply returned an invalid row");
    }
    const retiredId = brandPersistedCaseLawDecisionId(row["retiredId"]);
    if (row["survivor"] === true) {
      outcomes.push({ type: "separate_alias_group_survivor", retiredId });
      continue;
    }
    if (row["alreadyRetired"] === true) {
      outcomes.push({ type: "separate_already_retired", retiredId });
      continue;
    }
    if (row["skippedErased"]) {
      outcomes.push({ type: "skipped_erased", retiredId });
      continue;
    }
    appliedIds.add(retiredId);
    outcomes.push({ type: "linked", retiredId });
  }
  const applied = candidates.filter(({ duplicate }) =>
    appliedIds.has(duplicate.id),
  );
  if (applied.length > 0) {
    await reconcile(applied, "apply");
  }
  return outcomes;
};

/** Undo aliases in a bounded page and restore identities to their stored owner. */
export const reverseRepublishedDecisionBatch = async (
  tx: PlanTransaction,
  limit: number,
  reconcile: Reconcile,
): Promise<ReverseRepublishedDecisionOutcome[]> => {
  // Like apply: the erasure check below stays valid for the whole page only
  // while no erasure can run beside it.
  await lockCaseLawRepublication({ tx, mode: "exclusive" });
  const rows = executedRows(
    await tx.execute(sql`
    WITH selected AS MATERIALIZED (
      SELECT a.retired_decision_id, a.canonical_decision_id,
             ds.adapter_key AS retired_adapter_key,
             d.created_at AS retired_created_at,
             cs.adapter_key AS canonical_adapter_key,
             c.created_at AS canonical_created_at,
             (c.redacted_at IS NOT NULL OR d.redacted_at IS NOT NULL) AS either_erased,
             -- All or nothing: one moved identity removed or reassigned since
             -- apply leaves the pair aliased, with its recovery record intact.
             EXISTS (SELECT 1
                       FROM case_law_decision_alias_moved_identities m
                      WHERE m.retired_decision_id = a.retired_decision_id
                        AND NOT EXISTS (
                          SELECT 1
                            FROM case_law_decision_source_identities i
                           WHERE i.source_id = m.source_id
                             AND i.source_document_id = m.source_document_id
                             AND i.decision_id = a.canonical_decision_id
                        )) AS unrestorable
        FROM case_law_decision_aliases a
        JOIN case_law_decisions d ON d.id = a.retired_decision_id
        JOIN case_law_decisions c ON c.id = a.canonical_decision_id
        JOIN case_law_sources ds ON ds.id = d.source_id
        JOIN case_law_sources cs ON cs.id = c.source_id
       WHERE d.source_id <> c.source_id
         AND EXISTS (SELECT 1 FROM case_law_decision_alias_moved_identities m
                      WHERE m.retired_decision_id = a.retired_decision_id)
       ORDER BY either_erased, unrestorable, a.retired_decision_id
       LIMIT ${limit}
    ), restored AS (
      UPDATE case_law_decision_source_identities identity
         SET decision_id = selected.retired_decision_id
        FROM selected
       WHERE NOT selected.either_erased
         AND NOT selected.unrestorable
         AND identity.decision_id = selected.canonical_decision_id
         AND (identity.source_id, identity.source_document_id) IN (
           SELECT moved.source_id, moved.source_document_id
             FROM case_law_decision_alias_moved_identities moved
            WHERE moved.retired_decision_id = selected.retired_decision_id
         )
      RETURNING selected.retired_decision_id
    ), restored_page AS (
      SELECT DISTINCT retired_decision_id FROM restored
    ), deleted AS (
      DELETE FROM case_law_decision_aliases alias
       USING selected, restored_page
       WHERE alias.retired_decision_id = selected.retired_decision_id
         AND restored_page.retired_decision_id = selected.retired_decision_id
      RETURNING selected.retired_decision_id AS "retiredId",
                selected.canonical_decision_id AS "canonicalId",
                selected.retired_adapter_key AS "retiredAdapterKey",
                selected.retired_created_at AS "retiredCreatedAt",
                selected.canonical_adapter_key AS "canonicalAdapterKey",
                selected.canonical_created_at AS "canonicalCreatedAt"
    )
    SELECT selected.retired_decision_id AS "retiredId",
           selected.canonical_decision_id AS "canonicalId",
           selected.retired_adapter_key AS "retiredAdapterKey",
           selected.retired_created_at AS "retiredCreatedAt",
           selected.canonical_adapter_key AS "canonicalAdapterKey",
           selected.canonical_created_at AS "canonicalCreatedAt",
           selected.either_erased AS "refusedErased",
           deleted."retiredId" IS NOT NULL AS "aliasDeleted"
      FROM selected
      LEFT JOIN deleted
        ON deleted."retiredId" = selected.retired_decision_id
     ORDER BY selected.retired_decision_id
  `),
  );
  const reversed: RepublishedDecisionCandidate[] = [];
  const outcomes: ReverseRepublishedDecisionOutcome[] = [];
  for (const value of rows) {
    if (
      !isRecord(value) ||
      typeof value["retiredId"] !== "string" ||
      typeof value["canonicalId"] !== "string"
    ) {
      return panic(
        "Republished-decision reverse selection returned an invalid row",
      );
    }
    const retiredId = brandPersistedCaseLawDecisionId(value["retiredId"]);
    if (value["refusedErased"] === true) {
      outcomes.push({ type: "refused_erased", retiredId });
      continue;
    }
    // Only a deleted alias is a reversal; an unrestorable pair keeps its alias
    // and must not be reconciled as live.
    if (value["aliasDeleted"] !== true) {
      outcomes.push({ type: "refused_unrestorable", retiredId });
      continue;
    }
    const canonicalId = brandPersistedCaseLawDecisionId(value["canonicalId"]);
    const retired = side(
      {
        rightId: retiredId,
        rightAdapterKey: value["retiredAdapterKey"],
        rightCreatedAt: value["retiredCreatedAt"],
      },
      "right",
    );
    const canonical = side(
      {
        leftId: canonicalId,
        leftAdapterKey: value["canonicalAdapterKey"],
        leftCreatedAt: value["canonicalCreatedAt"],
      },
      "left",
    );
    reversed.push({ canonical, disposition: "link", duplicate: retired });
    outcomes.push({ type: "reversed", retiredId });
  }
  if (reversed.length > 0) {
    await reconcile(reversed, "reverse");
  }
  return outcomes;
};
