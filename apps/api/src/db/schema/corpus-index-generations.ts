import { CORPUS_INDEX_ENROLLMENT_CONTRACTS } from "@/api/lib/legal-search/case-law-index-groups";
import {
  CORPUS_FAMILIES,
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  CORPUS_INDEX_GENERATION_STATUSES,
  QUICKWIT_CLUSTERS,
} from "@/api/lib/legal-search/corpus-generation-contract";
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
