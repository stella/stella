import { type SQL, sql } from "drizzle-orm";

/**
 * The guard functions and triggers production runs on the two projection
 * tables, from the migrations that last define each. A PGlite test database
 * is pushed from the schema, which carries the checks but no triggers, so a
 * test that models projection transitions installs these to run against
 * both, as production does.
 */
const GUARD_MIGRATION_URLS = [
  "20260825142000_corpus_index_projection_intents",
  "20260826003700_corpus_projection_work_schedule",
  "20261115120000_corpus_projection_offline_delivery",
].map(
  (name) => new URL(`../../../drizzle/${name}/migration.sql`, import.meta.url),
);
const GUARDED_FUNCTIONS = [
  "guard_corpus_index_projection_intent_insert",
  "guard_corpus_index_projection_intent_update",
  "corpus_index_projection_intent_transition_allowed",
  "guard_corpus_index_projection_state",
  "guard_corpus_index_projection_expected_document_count",
  "guard_corpus_index_projection_work_state",
] as const;

export const installCorpusProjectionGuards = async (db: {
  execute: (query: SQL) => Promise<unknown>;
}): Promise<void> => {
  for (const url of GUARD_MIGRATION_URLS) {
    const migration = await Bun.file(url).text();
    for (const statement of migration.split("--> statement-breakpoint")) {
      const ddl = statement
        .trim()
        .replace(/^(?:--[^\n]*(?:\n|$)\s*)+/u, "")
        .trim();
      const guardsProjection =
        GUARDED_FUNCTIONS.some((name) => ddl.includes(`"${name}"`)) &&
        (ddl.startsWith("CREATE FUNCTION") ||
          ddl.startsWith("CREATE OR REPLACE FUNCTION") ||
          ddl.startsWith("CREATE TRIGGER"));
      if (guardsProjection) {
        await db.execute(sql.raw(ddl));
      }
    }
  }
};
