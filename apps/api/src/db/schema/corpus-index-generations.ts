import {
  CORPUS_FAMILIES,
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
  CORPUS_INDEX_GENERATION_STATUSES,
  QUICKWIT_CLUSTERS,
} from "@/api/lib/legal-search/corpus-generation-contract";

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
    // Compatibility for pre-transaction-revision readers during rollout.
    // Drop after those binaries have left the rollback window.
    projectionRevision: p
      .bigint("projection_revision", { mode: "number" })
      .default(1)
      .notNull(),
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
      "corpus_index_generations_projection_revision_positive",
      sql`${t.projectionRevision} > 0`,
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
    revision: p
      .bigint({ mode: "number" })
      .generatedAlwaysAsIdentity({
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
