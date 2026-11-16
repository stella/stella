import { CORPUS_INDEX_ENROLLMENT_CONTRACTS } from "@/api/lib/legal-search/case-law-index-groups";
import {
  CORPUS_FAMILIES,
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  CORPUS_INDEX_GENERATION_STATUSES,
  QUICKWIT_CLUSTERS,
} from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS,
  CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS,
} from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import { CORPUS_INDEX_ID_MAX_LENGTH } from "@/api/lib/legal-search/index-naming";

import {
  globalCaseLawPolicies,
  p,
  publicLawReaderPolicies,
  sql,
  timestamptz,
} from "./common";

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql.raw(","),
  );

/**
 * Immutable binding of one corpus generation to the trusted Quickwit cluster
 * that owns it, plus the generation's small serving lifecycle. Endpoint URLs
 * remain deployment configuration: persisted state can select only a closed
 * cluster identifier, never an arbitrary internal request target.
 */
export const corpusIndexGenerations = p.pgTable(
  "corpus_index_generations",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    cluster: p.text({ enum: QUICKWIT_CLUSTERS }).notNull(),
    manifestDigest: p.varchar("manifest_digest", { length: 64 }).notNull(),
    status: p.text({ enum: CORPUS_INDEX_GENERATION_STATUSES }).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_generations_pkey",
      columns: [t.family, t.generation],
    }),
    p
      .uniqueIndex("corpus_index_generations_serving_family_uidx")
      .on(t.family)
      .where(sql`${t.status} = 'serving'`),
    p.check(
      "corpus_index_generations_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_generations_cluster_values",
      sql`${t.cluster} IN (${sqlValues(QUICKWIT_CLUSTERS)})`,
    ),
    p.check(
      "corpus_index_generations_status_values",
      sql`${t.status} IN (${sqlValues(CORPUS_INDEX_GENERATION_STATUSES)})`,
    ),
    p.check(
      "corpus_index_generations_manifest_digest_shape",
      sql`${t.manifestDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "corpus_index_generations_name_matches_family",
      sql`CASE ${t.family}
        WHEN 'case_law' THEN ${t.generation} ~ '^case_law_v[1-9][0-9]*$'
        WHEN 'legislation' THEN ${t.generation} ~ '^legislation_v[1-9][0-9]*$'
        ELSE false
      END`,
    ),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
  ],
);

/**
 * Sequence-ordered revisions for projection mutations. Writers append at most
 * one row per generation and transaction, so revision reads do not serialize
 * unrelated projection work on the generation registry row.
 */
export const corpusIndexProjectionRevisions = p.pgTable(
  "corpus_index_projection_revisions",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    revision: p.bigint({ mode: "number" }).generatedAlwaysAsIdentity({
      name: "corpus_index_projection_revisions_revision_seq",
      cache: 1,
    }),
    transactionId: p.bigint("transaction_id", { mode: "number" }).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_projection_revisions_pkey",
      columns: [t.family, t.generation, t.revision],
    }),
    p
      .foreignKey({
        name: "corpus_index_projection_revisions_generation_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerations.family,
          corpusIndexGenerations.generation,
        ],
      })
      .onDelete("cascade"),
    p
      .unique("corpus_index_projection_revisions_transaction_unique")
      .on(t.family, t.generation, t.transactionId),
    p.check(
      "corpus_index_projection_revisions_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_projection_revisions_revision_positive",
      sql`${t.revision} > 0`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

export const CORPUS_INDEX_GROUP_PROVISIONING_STATUSES = [
  "pending",
  "attested",
] as const;

export type CorpusIndexGroupProvisioningStatus =
  (typeof CORPUS_INDEX_GROUP_PROVISIONING_STATUSES)[number];

/**
 * One index group of a generation bound to the contract its physical index is
 * created under, for a group whose index the manifest cannot vouch for: one
 * under a group contract of its own, or one under the manifest's contract
 * declared after the generation was created (`base`). Groups the generation
 * was created with keep its attestation and are never enrolled.
 *
 * The binding (index id, contract version, effective digest) is written once
 * and compared on every later bind, never overwritten: the ingestion role
 * holds no UPDATE on those columns. Readiness moves separately, from
 * `pending` to `attested` once the physical index is proven to carry the
 * configuration; until then generation-wide reads leave the group out, and a
 * group under its own contract is neither read nor written. A generation's
 * rebuild deletes its registration and with it every
 * enrollment, so a rebuilt generation's groups are attested again.
 */
export const corpusIndexGroupEnrollments = p.pgTable(
  "corpus_index_group_enrollments",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    indexGroup: p.varchar("index_group", { length: 32 }).notNull(),
    physicalIndexId: p
      .varchar("physical_index_id", { length: CORPUS_INDEX_ID_MAX_LENGTH })
      .notNull(),
    contractVersion: p
      .text("contract_version", { enum: CORPUS_INDEX_ENROLLMENT_CONTRACTS })
      .notNull(),
    effectiveDigest: p.varchar("effective_digest", { length: 64 }).notNull(),
    provisioningStatus: p
      .text("provisioning_status", {
        enum: CORPUS_INDEX_GROUP_PROVISIONING_STATUSES,
      })
      .notNull(),
    attestedAt: timestamptz("attested_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_group_enrollments_pkey",
      columns: [t.family, t.generation, t.indexGroup],
    }),
    p
      .foreignKey({
        name: "corpus_index_group_enrollments_generation_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerations.family,
          corpusIndexGenerations.generation,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "corpus_index_group_enrollments_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_group_enrollments_contract_values",
      sql`${t.contractVersion} IN (${sqlValues(CORPUS_INDEX_ENROLLMENT_CONTRACTS)})`,
    ),
    p.check(
      "corpus_index_group_enrollments_status_values",
      sql`${t.provisioningStatus} IN (${sqlValues(CORPUS_INDEX_GROUP_PROVISIONING_STATUSES)})`,
    ),
    p.check(
      "corpus_index_group_enrollments_digest_shape",
      sql`${t.effectiveDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "corpus_index_group_enrollments_index_of_generation",
      sql`${t.physicalIndexId} = ${t.generation} || '_' || ${t.indexGroup}`,
    ),
    p.check(
      "corpus_index_group_enrollments_attested_at",
      sql`(${t.provisioningStatus} = 'attested') = (${t.attestedAt} IS NOT NULL)`,
    ),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
  ],
);

/**
 * Append-only trail of index-group attestation withdrawals: which group, the
 * digest it was attested against, who withdrew it and why, written in the
 * withdrawing transaction (`withdrawCorpusIndexGroupEnrollmentTx`). Global,
 * like the registry, so it cannot live in the organization-keyed audit log;
 * it has no foreign key so it outlives the enrollment a rebuild deletes.
 */
export const corpusIndexGroupWithdrawals = p.pgTable(
  "corpus_index_group_withdrawals",
  {
    id: p.bigint({ mode: "number" }).generatedAlwaysAsIdentity({
      name: "corpus_index_group_withdrawals_id_seq",
    }),
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    indexGroup: p.varchar("index_group", { length: 32 }).notNull(),
    effectiveDigest: p.varchar("effective_digest", { length: 64 }).notNull(),
    actor: p.varchar({ length: 128 }).notNull(),
    reason: p.varchar({ length: 2048 }).notNull(),
    withdrawnAt: timestamptz("withdrawn_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_group_withdrawals_pkey",
      columns: [t.id],
    }),
    p.check(
      "corpus_index_group_withdrawals_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_group_withdrawals_digest_shape",
      sql`${t.effectiveDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    p.check(
      "corpus_index_group_withdrawals_actor_shape",
      sql`${t.actor} ~ '^[a-z0-9][a-z0-9:._@/-]*$'`,
    ),
    p.check(
      "corpus_index_group_withdrawals_reason_present",
      sql`length(btrim(${t.reason})) > 0`,
    ),
    p.pgPolicy("corpus_index_group_withdrawals_owner_access", {
      for: "all",
      to: "public",
      using: sql`true`,
      withCheck: sql`true`,
    }),
    ...globalCaseLawPolicies(),
  ],
);

const jurisdictionServingOwnerAccess = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.corpus_index_jurisdiction_serving'::regclass)`;

/**
 * The generation that serves one jurisdiction when it is not the family's
 * serving generation. A row exists only after the gated flip
 * (`case-law-serving-flip.ts`) moved the jurisdiction to a partial generation
 * built beside the serving one; without a row, a jurisdiction is served by
 * the family's serving generation, which is the routing every generation
 * already has. Reads, the SQL acceptance of an indexed hit and the projection
 * of what the old generation still holds all follow this row and nothing
 * else.
 *
 * The row is deleted when a whole generation is promoted (that generation
 * holds the jurisdiction itself) and cascades with the generation it names.
 */
export const corpusIndexJurisdictionServing = p.pgTable(
  "corpus_index_jurisdiction_serving",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    jurisdiction: p.varchar({ length: 3 }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    /**
     * The generation the jurisdiction was served by until the flip: the one
     * whose copies are erased, and the only one.
     */
    fromGeneration: p
      .varchar("from_generation", {
        length: CORPUS_INDEX_GENERATION_MAX_LENGTH,
      })
      .notNull(),
    flippedAt: timestamptz("flipped_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_jurisdiction_serving_pkey",
      columns: [t.family, t.jurisdiction],
    }),
    p
      .foreignKey({
        name: "corpus_index_jurisdiction_serving_generation_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerations.family,
          corpusIndexGenerations.generation,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "corpus_index_jurisdiction_serving_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_jurisdiction_serving_jurisdiction_shape",
      sql`${t.jurisdiction} ~ '^[A-Z]{2,3}$'`,
    ),
    p.pgPolicy("corpus_index_jurisdiction_serving_owner_access", {
      for: "all",
      to: "public",
      using: jurisdictionServingOwnerAccess,
      withCheck: jurisdictionServingOwnerAccess,
    }),
    ...globalCaseLawPolicies(),
    ...publicLawReaderPolicies(),
  ],
);

/**
 * The readiness proof of one physical index (route) of a generation: the
 * census pass walking it, and the last pass that found it exactly as
 * PostgreSQL records it. A pass never restarts when the projection writes:
 * a revision applied during it was proven present at its apply, and one
 * settled or withdrawn during it was proven gone when it got that status, so
 * ordinary writes leave the row alone. Only a repair of drift the census
 * found on the route revokes it, in the repair's own transaction, and starts
 * a fresh pass. A rebuild deletes the generation's registration, and the
 * cascade deletes its proofs with it.
 */
export const corpusIndexRouteProofs = p.pgTable(
  "corpus_index_route_proofs",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    indexId: p
      .varchar("index_id", { length: CORPUS_INDEX_ID_MAX_LENGTH })
      .notNull(),
    /**
     * The pass under way, counted from the route's first: every new pass and
     * every revocation takes the next number, so a page recorded against a
     * pass that has since ended matches nothing, however close the clock
     * readings are.
     */
    passNumber: p
      .bigint("pass_number", { mode: "number" })
      .default(1)
      .notNull(),
    /** When the pass under way started, on the database clock. */
    passStartedAt: timestamptz("pass_started_at").notNull(),
    /** What the pass under way walks (`CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS`). */
    passExpectation: p
      .text("pass_expectation", {
        enum: CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS,
      })
      .notNull(),
    /** Where the pass resumes within its phase; null at the phase's start. */
    passCursor: p.uuid("pass_cursor"),
    /** Revisions the pass under way has found exactly as recorded. */
    passInspected: p
      .bigint("pass_inspected", { mode: "number" })
      .default(0)
      .notNull(),
    /** The number of the last clean pass; null until one completes. */
    provenPassNumber: p.bigint("proven_pass_number", { mode: "number" }),
    /** When the last clean pass started. */
    provenPassStartedAt: timestamptz("proven_pass_started_at"),
    /** When the last clean pass completed. */
    provenAt: timestamptz("proven_at"),
    /** Revisions the last clean pass inspected. */
    provenInspected: p.bigint("proven_inspected", { mode: "number" }),
    /** When a drift repair on the route last revoked the proof. */
    revokedAt: timestamptz("revoked_at"),
    /**
     * The pass the last revocation started: only a pass numbered this or
     * later proves the route again.
     */
    revokedPassNumber: p.bigint("revoked_pass_number", { mode: "number" }),
    /** Which drift it was (`CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS`). */
    revokeReason: p.text("revoke_reason", {
      enum: CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS,
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_route_proofs_pkey",
      columns: [t.family, t.generation, t.indexId],
    }),
    p
      .foreignKey({
        name: "corpus_index_route_proofs_generation_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerations.family,
          corpusIndexGenerations.generation,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "corpus_index_route_proofs_family_values",
      sql`${t.family} IN (${sqlValues(CORPUS_FAMILIES)})`,
    ),
    p.check(
      "corpus_index_route_proofs_index_shape",
      sql`${t.indexId} ~ '^[a-z0-9_]+$'`,
    ),
    p.check(
      "corpus_index_route_proofs_expectation_values",
      sql`${t.passExpectation} IN (${sqlValues(CORPUS_INDEX_ROUTE_CENSUS_EXPECTATIONS)})`,
    ),
    p.check(
      "corpus_index_route_proofs_inspected_nonnegative",
      sql`${t.passNumber} > 0 AND ${t.passInspected} >= 0 AND (${t.provenInspected} IS NULL OR ${t.provenInspected} >= 0)`,
    ),
    p.check(
      "corpus_index_route_proofs_proven_shape",
      sql`(${t.provenAt} IS NULL) = (${t.provenPassStartedAt} IS NULL)
        AND (${t.provenAt} IS NULL) = (${t.provenInspected} IS NULL)
        AND (${t.provenAt} IS NULL) = (${t.provenPassNumber} IS NULL)
        AND (${t.provenPassNumber} IS NULL OR ${t.provenPassNumber} < ${t.passNumber})
        AND (${t.provenAt} IS NULL OR ${t.provenAt} >= ${t.provenPassStartedAt})`,
    ),
    p.check(
      "corpus_index_route_proofs_revoke_shape",
      sql`(${t.revokedAt} IS NULL) = (${t.revokeReason} IS NULL)
        AND (${t.revokedAt} IS NULL) = (${t.revokedPassNumber} IS NULL)
        AND (${t.revokedPassNumber} IS NULL OR ${t.revokedPassNumber} <= ${t.passNumber})
        AND (${t.revokeReason} IS NULL OR ${t.revokeReason} IN (${sqlValues(CORPUS_INDEX_ROUTE_PROOF_REVOKE_REASONS)}))`,
    ),
    ...globalCaseLawPolicies(),
  ],
);
