/**
 * A test-database guard on every canonical write: at commit, a decision or
 * legislation document that was inserted, or whose projection epoch or
 * jurisdiction was written, has a desired state in every active generation
 * that routes it.
 *
 * The seeding fact (`corpus-index-route-seeding.ts`) says a route stays
 * seeded after its walk because every desired writer projects a changed row
 * into every active generation in the writing transaction. A writer that
 * seeds later, or only some generations, would make that fact lie without
 * failing anything else. Installed in every suite that runs a canonical
 * writer (ingestion, batch reconcile, retirement, the ranking-signal drain,
 * withdrawal and erasure, legislation ingestion, the repair scripts), it
 * fails the commit that breaks the rule.
 *
 * Not yet installed where the corpus ingestion writers create rows (the
 * case-law pipeline suite, legislation ingestion, and the withdrawal suite
 * that ingests through it): those writers project a new row first when its
 * corpus text settles, in a later transaction than its insert, and the guard
 * fails that insert's commit.
 */
import type { PGlite } from "@electric-sql/pglite";

import { CORPUS_INDEX_ACTIVE_GENERATION_STATUSES } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestScopeJurisdictions,
} from "@/api/lib/legal-search/corpus-index-manifest";

const GUARD_FUNCTION = "test_corpus_projection_seeding_guard";

/**
 * Set to `off` with `set_config(..., true)` inside one transaction, only by a
 * fixture that stands a canonical row up as data a writer never touched (a
 * row that predates the generation, which the seeding walk must find).
 */
export const CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING =
  "stella_test.corpus_projection_seeding_guard";

const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** The generations that hold some jurisdictions only, with those jurisdictions. */
const partialScopes = (): string => {
  const pairs = Object.values(CORPUS_INDEX_MANIFESTS).flatMap((manifest) =>
    (corpusIndexManifestScopeJurisdictions(manifest) ?? []).map(
      (jurisdiction) =>
        `(${quoted(manifest.generation)}, ${quoted(jurisdiction)})`,
    ),
  );
  const partial = Object.values(CORPUS_INDEX_MANIFESTS)
    .filter(
      (manifest) => corpusIndexManifestScopeJurisdictions(manifest) !== null,
    )
    .map((manifest) => quoted(manifest.generation));
  return partial.length === 0
    ? "true"
    : `(g.generation NOT IN (${partial.join(", ")}) OR (g.generation, v_country) IN (VALUES ${pairs.join(", ")}))`;
};

export const installCorpusProjectionSeedingGuard = async (
  client: PGlite,
): Promise<void> => {
  const active = CORPUS_INDEX_ACTIVE_GENERATION_STATUSES.map(quoted).join(", ");
  await client.exec(`
    CREATE OR REPLACE FUNCTION ${GUARD_FUNCTION}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_family text;
      v_country text;
      v_missing text;
    BEGIN
      IF current_setting('${CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING}', true) = 'off' THEN
        RETURN NULL;
      END IF;
      -- The first epoch claim of a row no generation has projected (a seeding
      -- walk numbering it for one generation) changes nothing canonical, and
      -- cannot open a gap: a row at epoch 0 has a state nowhere, so no walk
      -- has passed it yet, and every active generation's walk still reaches
      -- it. Any later epoch write is a claimed change.
      IF TG_OP = 'UPDATE' AND OLD.projection_epoch = 0
        AND OLD.country IS NOT DISTINCT FROM NEW.country THEN
        RETURN NULL;
      END IF;
      IF TG_TABLE_NAME = 'case_law_decisions' THEN
        v_family := 'case_law';
        SELECT country INTO v_country FROM case_law_decisions WHERE id = NEW.id;
      ELSE
        v_family := 'legislation';
        SELECT country INTO v_country FROM legislation_documents WHERE id = NEW.id;
      END IF;
      -- Deleted again before the commit: nothing to project.
      IF v_country IS NULL THEN
        RETURN NULL;
      END IF;
      SELECT g.generation INTO v_missing
        FROM corpus_index_generations g
       WHERE g.family = v_family
         AND g.status IN (${active})
         AND ${partialScopes()}
         AND NOT EXISTS (
           SELECT 1 FROM corpus_index_projection_states s
            WHERE s.family = v_family
              AND s.generation = g.generation
              AND s.entity_id = NEW.id
         )
       ORDER BY g.generation
       LIMIT 1;
      IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
          '% % (%) committed with no desired state in active generation %',
          v_family, NEW.id, v_country, v_missing;
      END IF;
      RETURN NULL;
    END;
    $$;
    DROP TRIGGER IF EXISTS ${GUARD_FUNCTION} ON case_law_decisions;
    CREATE CONSTRAINT TRIGGER ${GUARD_FUNCTION}
      AFTER INSERT OR UPDATE OF projection_epoch, country ON case_law_decisions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${GUARD_FUNCTION}();
    DROP TRIGGER IF EXISTS ${GUARD_FUNCTION} ON legislation_documents;
    CREATE CONSTRAINT TRIGGER ${GUARD_FUNCTION}
      AFTER INSERT OR UPDATE OF projection_epoch, country ON legislation_documents
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${GUARD_FUNCTION}();
  `);
};
