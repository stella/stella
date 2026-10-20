import { panic } from "better-result";
import { type SQL, sql } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  ADAPTER_KEYS,
  type AdapterKey,
} from "@/api/lib/legal-search/ingestion-constants";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
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

const SOURCE_AUTHORITY = {
  [ADAPTER_KEYS.CZ_REGIONAL]: 0,
  [ADAPTER_KEYS.CZ_NS]: 0,
  [ADAPTER_KEYS.CZ_NSS]: 0,
  [ADAPTER_KEYS.CZ_US]: 0,
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

export type RepublishedDecisionCandidate = {
  canonical: CandidateSide;
  duplicate: CandidateSide;
};

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

const canonicalFirst = (left: CandidateSide, right: CandidateSide): boolean => {
  const authority =
    SOURCE_AUTHORITY[left.adapterKey] - SOURCE_AUTHORITY[right.adapterKey];
  if (authority !== 0) {
    return authority < 0;
  }
  const stored = left.createdAt.getTime() - right.createdAt.getTime();
  return stored === 0 ? left.id < right.id : stored < 0;
};

/** One bounded, stable page. A complete identity requires date, type and docket. */
export const selectRepublishedDecisionCandidatesStatement = (
  limit: number,
) => sql`
  WITH pairs AS MATERIALIZED (
    SELECT a.id AS left_id, b.id AS right_id
      FROM case_law_decisions a
      JOIN case_law_decisions b
        ON a.id < b.id
       AND a.source_id <> b.source_id
       AND a.country = b.country
       AND a.court = b.court
       AND a.docket_family_key = b.docket_family_key
       AND a.decision_date = b.decision_date
       AND lower(a.decision_type) = lower(b.decision_type)
     WHERE a.docket_family_key IS NOT NULL
       AND a.decision_date IS NOT NULL
       AND a.decision_type IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM case_law_decision_aliases x WHERE x.retired_decision_id IN (a.id, b.id))
  ), singles AS (
    SELECT p.*
      FROM pairs p
     WHERE (SELECT count(*) FROM pairs q WHERE q.left_id = p.left_id OR q.right_id = p.left_id) = 1
       AND (SELECT count(*) FROM pairs q WHERE q.left_id = p.right_id OR q.right_id = p.right_id) = 1
     ORDER BY p.left_id, p.right_id
     LIMIT ${limit}
  )
  SELECT l.id AS "leftId", ls.adapter_key AS "leftAdapterKey", l.created_at AS "leftCreatedAt",
         r.id AS "rightId", rs.adapter_key AS "rightAdapterKey", r.created_at AS "rightCreatedAt"
    FROM singles p
    JOIN case_law_decisions l ON l.id = p.left_id
    JOIN case_law_sources ls ON ls.id = l.source_id
    JOIN case_law_decisions r ON r.id = p.right_id
    JOIN case_law_sources rs ON rs.id = r.source_id
   ORDER BY l.id, r.id
`;

export const selectRepublishedDecisionCandidates = async (
  tx: PlanTransaction,
  limit: number,
): Promise<RepublishedDecisionCandidate[]> =>
  executedRows(
    await tx.execute(selectRepublishedDecisionCandidatesStatement(limit)),
  ).map((value) => {
    if (!isRecord(value)) {
      return panic("Republished-decision selection returned a non-row");
    }
    const left = side(value, "left");
    const right = side(value, "right");
    return canonicalFirst(left, right)
      ? { canonical: left, duplicate: right }
      : { canonical: right, duplicate: left };
  });

type Reconcile = (
  candidate: RepublishedDecisionCandidate,
  direction: "apply" | "reverse",
) => Promise<void>;

/** Apply one selected page atomically. No decision or identity row is inserted. */
export const applyRepublishedDecisionBatch = async (
  tx: PlanTransaction,
  candidates: readonly RepublishedDecisionCandidate[],
  reconcile: Reconcile,
): Promise<number> => {
  let applied = 0;
  for (const candidate of candidates) {
    const identities = executedRows(
      await tx.execute(sql`
      UPDATE case_law_decision_source_identities
         SET decision_id = ${candidate.canonical.id}
       WHERE decision_id = ${candidate.duplicate.id}
      RETURNING decision_id
    `),
    );
    if (identities.length === 0) {
      continue;
    }
    await tx.execute(sql`
      INSERT INTO case_law_decision_aliases (retired_decision_id, canonical_decision_id)
      VALUES (${candidate.duplicate.id}, ${candidate.canonical.id})
    `);
    await reconcile(candidate, "apply");
    applied++;
  }
  return applied;
};

/** Undo aliases in a bounded page and restore identities to their stored owner. */
export const reverseRepublishedDecisionBatch = async (
  tx: PlanTransaction,
  limit: number,
  reconcile: Reconcile,
): Promise<number> => {
  const rows = executedRows(
    await tx.execute(sql`
    SELECT a.retired_decision_id AS "retiredId",
           a.canonical_decision_id AS "canonicalId",
           d.source_id AS "sourceId"
      FROM case_law_decision_aliases a
      JOIN case_law_decisions d ON d.id = a.retired_decision_id
      JOIN case_law_decisions c ON c.id = a.canonical_decision_id
     WHERE d.source_id <> c.source_id
       AND EXISTS (
         SELECT 1 FROM case_law_decision_source_identities i
          WHERE i.source_id = d.source_id
            AND i.decision_id = a.canonical_decision_id
       )
     ORDER BY a.retired_decision_id
     LIMIT ${limit}
  `),
  );
  for (const value of rows) {
    if (
      !isRecord(value) ||
      typeof value["retiredId"] !== "string" ||
      typeof value["canonicalId"] !== "string" ||
      typeof value["sourceId"] !== "string"
    ) {
      return panic(
        "Republished-decision reverse selection returned an invalid row",
      );
    }
    const retiredId = brandPersistedCaseLawDecisionId(value["retiredId"]);
    const canonicalId = brandPersistedCaseLawDecisionId(value["canonicalId"]);
    await tx.execute(sql`
      UPDATE case_law_decision_source_identities
         SET decision_id = ${retiredId}
       WHERE decision_id = ${canonicalId}
         AND source_id = ${value["sourceId"]}
    `);
    await tx.execute(
      sql`DELETE FROM case_law_decision_aliases WHERE retired_decision_id = ${retiredId}`,
    );
    const candidates = await selectRepublishedDecisionCandidates(tx, 1);
    const candidate = candidates.at(0) ?? {
      canonical: {
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        createdAt: new Date(0),
        id: canonicalId,
      },
      duplicate: {
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        createdAt: new Date(0),
        id: retiredId,
      },
    };
    await reconcile(candidate, "reverse");
  }
  return rows.length;
};
