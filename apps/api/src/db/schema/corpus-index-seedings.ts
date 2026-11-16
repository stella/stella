import {
  CORPUS_FAMILIES,
  CORPUS_INDEX_GENERATION_MAX_LENGTH,
} from "@/api/lib/legal-search/corpus-generation-contract";
import { CORPUS_INDEX_ID_MAX_LENGTH } from "@/api/lib/legal-search/index-naming";

import { globalCaseLawPolicies, p, sql, timestamptz } from "./common";
import { corpusIndexGenerations } from "./corpus-index-generations";

/** Canonical jurisdiction codes, as `country` stores them in both families. */
const JURISDICTION_LENGTH = 3;

const familyValues = sql.raw(
  CORPUS_FAMILIES.map((family) => `'${family}'`).join(","),
);

/**
 * The seeding walk of one generation: one pass over every canonical row of
 * the family in id order, giving each row the generation routes a desired
 * state where it has none. A pass records, as it begins, the routes and the
 * jurisdictions routed at that moment; when it completes, it marks exactly
 * those routes seeded (`corpus_index_route_seedings`). The cursor and the
 * counts move in the transaction that seeds the page they describe, so the
 * row never claims more than was seeded.
 *
 * Once a pass has completed, every desired writer keeps the generation
 * seeded by projecting each changed row into every active generation in its
 * own transaction. A generation that leaves the active set stops receiving
 * those writes, so the transition that takes it out deletes this row, and
 * its route rows with it; a rebuild deletes the registration and cascades.
 */
export const corpusIndexGenerationSeedingPasses = p.pgTable(
  "corpus_index_generation_seeding_passes",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    /** The pass under way or last completed, counted from the first. */
    passNumber: p
      .bigint("pass_number", { mode: "number" })
      .default(1)
      .notNull(),
    /** When the pass began, on the database clock. */
    passStartedAt: timestamptz("pass_started_at").notNull(),
    /** The routes the pass marks seeded when it completes, taken as it began. */
    routeIndexIds: p
      .varchar("route_index_ids", { length: CORPUS_INDEX_ID_MAX_LENGTH })
      .array()
      .notNull(),
    /** The jurisdictions those routes held as the pass began. */
    routeJurisdictions: p
      .varchar("route_jurisdictions", { length: JURISDICTION_LENGTH })
      .array()
      .notNull(),
    /** The last canonical id the pass accounted for; null before its first page. */
    afterEntityId: p.uuid("after_entity_id"),
    /** Canonical rows the pass has walked. */
    walkedCount: p
      .bigint("walked_count", { mode: "number" })
      .default(0)
      .notNull(),
    /** Desired states the pass has written. */
    seededCount: p
      .bigint("seeded_count", { mode: "number" })
      .default(0)
      .notNull(),
    /** When the pass walked its last page; null while it is under way. */
    completedAt: timestamptz("completed_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_generation_seeding_passes_pkey",
      columns: [t.family, t.generation],
    }),
    p
      .foreignKey({
        name: "corpus_index_generation_seeding_passes_generation_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerations.family,
          corpusIndexGenerations.generation,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "corpus_index_generation_seeding_passes_family_values",
      sql`${t.family} IN (${familyValues})`,
    ),
    p.check(
      "corpus_index_generation_seeding_passes_counts",
      sql`${t.passNumber} > 0 AND ${t.walkedCount} >= 0 AND ${t.seededCount} >= 0 AND ${t.seededCount} <= ${t.walkedCount}`,
    ),
    p.check(
      "corpus_index_generation_seeding_passes_completed_shape",
      sql`${t.completedAt} IS NULL OR ${t.completedAt} >= ${t.passStartedAt}`,
    ),
    ...globalCaseLawPolicies(),
  ],
);

/**
 * One route (physical index) of a generation that a completed seeding pass
 * covered: every canonical row the route held when that pass began was given
 * a desired state by the pass or by its writer. A route with no row here is
 * unseeded: it did not exist when the last pass began, so nothing walked it.
 * `jurisdictions` are the jurisdictions the pass found routed; a jurisdiction
 * routed to the index later is not covered, and the reader treats the route
 * as unseeded until a pass that saw it completes.
 */
export const corpusIndexRouteSeedings = p.pgTable(
  "corpus_index_route_seedings",
  {
    family: p.text({ enum: CORPUS_FAMILIES }).notNull(),
    generation: p
      .varchar({ length: CORPUS_INDEX_GENERATION_MAX_LENGTH })
      .notNull(),
    indexId: p
      .varchar("index_id", { length: CORPUS_INDEX_ID_MAX_LENGTH })
      .notNull(),
    /** The jurisdictions routed when the covering pass began. */
    jurisdictions: p.varchar({ length: JURISDICTION_LENGTH }).array().notNull(),
    /** The pass that covered the route. */
    passNumber: p.bigint("pass_number", { mode: "number" }).notNull(),
    /** When that pass began. */
    passStartedAt: timestamptz("pass_started_at").notNull(),
    /** When that pass completed. */
    seededAt: timestamptz("seeded_at").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    p.primaryKey({
      name: "corpus_index_route_seedings_pkey",
      columns: [t.family, t.generation, t.indexId],
    }),
    p
      .foreignKey({
        name: "corpus_index_route_seedings_pass_fk",
        columns: [t.family, t.generation],
        foreignColumns: [
          corpusIndexGenerationSeedingPasses.family,
          corpusIndexGenerationSeedingPasses.generation,
        ],
      })
      .onDelete("cascade"),
    p.check(
      "corpus_index_route_seedings_family_values",
      sql`${t.family} IN (${familyValues})`,
    ),
    p.check(
      "corpus_index_route_seedings_index_shape",
      sql`${t.indexId} ~ '^[a-z0-9_]+$'`,
    ),
    p.check(
      "corpus_index_route_seedings_pass_shape",
      sql`${t.passNumber} > 0 AND ${t.seededAt} >= ${t.passStartedAt}`,
    ),
    ...globalCaseLawPolicies(),
  ],
);
