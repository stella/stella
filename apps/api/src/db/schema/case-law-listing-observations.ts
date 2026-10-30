import { stella, stellaIngestion } from "@/api/db/rls";
import { LISTING_OBSERVATION_REASONS } from "@/api/lib/legal-search/listing-observation-reasons";

import { caseLawSources } from "./case-law";
import { jsonb, p, safeUuid, sql, timestamptz } from "./common";

/** Immutable publisher evidence that states no usable canonical decision identity. */
export const caseLawListingObservations = p.pgTable.withRLS(
  "case_law_listing_observations",
  {
    sourceId: safeUuid<"caseLawSource">("source_id")
      .notNull()
      .references(() => caseLawSources.id, { onDelete: "cascade" }),
    fingerprint: p.varchar({ length: 64 }).notNull(),
    adapterKey: p.varchar("adapter_key", { length: 32 }).notNull(),
    reason: p
      .varchar({ length: 32, enum: LISTING_OBSERVATION_REASONS })
      .notNull(),
    /** The wrapper preserves a source's JSON null as data rather than SQL NULL. */
    payload: jsonb().$type<{ listing: unknown }>().notNull(),
    firstSeenAt: timestamptz("first_seen_at").defaultNow().notNull(),
  },
  (t) => [
    p.primaryKey({
      name: "case_law_listing_observations_pkey",
      columns: [t.sourceId, t.fingerprint],
    }),
    p.check(
      "case_law_listing_observations_fingerprint",
      sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    p.check(
      "case_law_listing_observations_reason",
      sql`${t.reason} IN (${sql.join(
        LISTING_OBSERVATION_REASONS.map((reason) => sql`${reason}`),
        sql`, `,
      )})`,
    ),
    p.pgPolicy("case_law_listing_observations_read", {
      for: "select",
      to: [stella, stellaIngestion],
      using: sql`true`,
    }),
    p.pgPolicy("case_law_listing_observations_insert", {
      for: "insert",
      to: stellaIngestion,
      withCheck: sql`true`,
    }),
  ],
);
