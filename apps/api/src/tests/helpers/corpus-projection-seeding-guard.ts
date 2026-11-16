/**
 * A test-database guard on every canonical write, enforcing the seeding rule
 * (`corpus-index-route-seeding.ts`): at commit, a decision or legislation
 * document that was inserted, or whose projection epoch, jurisdiction or
 * projectability was written, has a desired state in EVERY active generation
 * that routes it, or in NONE of them, and none only while it is not
 * projectable (`corpus-projectability.ts`, the definition the seeding walk
 * reads).
 *
 * A writer that seeds some generations and not others, or leaves a settled row
 * without states, would make the seeding fact lie without failing anything
 * else. The guard is on by default in every PGlite test database (the build
 * behind `createTestPglite` installs it), so it fails the commit that breaks
 * the rule in whichever suite the writer runs.
 *
 * A Postgres suite installs it for itself (`guardPostgresSuiteSeeding` in
 * `corpus-projection-seeding-guard-postgres.ts`),
 * checking only the generations it registers: in the shared test database a
 * generation one suite left registered is active for every suite after it,
 * so a database-wide guard would fail unrelated fixtures rather than writers.
 * The install is DDL on the canonical tables, so such a suite runs in an
 * exclusive process on a fresh clone (`scripts/postgres-test-plan.ts`).
 *
 * It checks that states exist, not that they are current: a writer that
 * changes a projection input of a row that already has states is caught by
 * the ownership rule on those columns (`scripts/ownership/
 * case-law-projectability-write.ts`, `legislation-projectability-write.ts`)
 * where its write is visible to it, and by its own suite's assertions.
 *
 * A suite that cannot keep the rule opts out with a written reason
 * (`optOutOfCorpusProjectionSeedingGuard`); a fixture that stands one row up
 * as pre-existing data sets the off switch for its own transaction.
 */
import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { PgDialect } from "drizzle-orm/pg-core";

import { CORPUS_INDEX_ACTIVE_GENERATION_STATUSES } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestScopeJurisdictions,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_ROW_PROJECTABLE } from "@/api/lib/legal-search/corpus-projectability";

/** The guard's function and its trigger on both canonical tables. */
export const CORPUS_PROJECTION_SEEDING_GUARD_TRIGGER =
  "test_corpus_projection_seeding_guard";
const GUARD_FUNCTION = CORPUS_PROJECTION_SEEDING_GUARD_TRIGGER;
const STATEMENT_BREAK = "-- statement break";

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

/**
 * The guard's function and triggers. The function runs as its owner, so a
 * writer role that may not read the generation registry or the states is
 * still checked.
 */
export const corpusProjectionSeedingGuardStatements = (
  checked: readonly CheckedGeneration[] | null = null,
): string[] =>
  corpusProjectionSeedingGuardSql(checked)
    .split(STATEMENT_BREAK)
    .map((statement) => statement.trim().replace(/;$/u, ""))
    .filter((statement) => statement.length > 0);

export type CheckedGeneration = keyof typeof CORPUS_INDEX_MANIFESTS;

/** All active generations, or only the ones a Postgres suite registered. */
const checkedScope = (checked: readonly CheckedGeneration[] | null): string =>
  checked === null
    ? "true"
    : `g.generation IN (${checked.map(quoted).join(", ")})`;

const corpusProjectionSeedingGuardSql = (
  checked: readonly CheckedGeneration[] | null,
): string => {
  const active = CORPUS_INDEX_ACTIVE_GENERATION_STATUSES.map(quoted).join(", ");
  const dialect = new PgDialect();
  const projectable = {
    case_law: dialect.sqlToQuery(CORPUS_ROW_PROJECTABLE.case_law).sql,
    legislation: dialect.sqlToQuery(CORPUS_ROW_PROJECTABLE.legislation).sql,
  };
  return `
    CREATE OR REPLACE FUNCTION ${GUARD_FUNCTION}() RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_catalog, pg_temp
    AS $$
    DECLARE
      v_family text;
      v_country text;
      v_projectable boolean;
      v_missing text;
      v_present integer;
    BEGIN
      IF current_setting('${CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING}', true) = 'off' THEN
        RETURN NULL;
      END IF;
      -- The first epoch claim of a row no generation has projected, when it is
      -- the only change (a seeding walk numbering it for one generation),
      -- changes nothing canonical and cannot open a gap: a row at epoch 0 has
      -- a state nowhere, so no walk has passed it yet, and every active
      -- generation's walk still reaches it. Any other write is checked.
      IF TG_OP = 'UPDATE' AND OLD.projection_epoch = 0
        AND to_jsonb(OLD) - 'projection_epoch' - 'updated_at'
          = to_jsonb(NEW) - 'projection_epoch' - 'updated_at' THEN
        RETURN NULL;
      END IF;
      IF TG_TABLE_NAME = 'case_law_decisions' THEN
        v_family := 'case_law';
        SELECT country, ${projectable.case_law}
          INTO v_country, v_projectable
          FROM case_law_decisions WHERE id = NEW.id;
      ELSE
        v_family := 'legislation';
        SELECT country, ${projectable.legislation}
          INTO v_country, v_projectable
          FROM legislation_documents WHERE id = NEW.id;
      END IF;
      -- Deleted again before the commit: nothing to project.
      IF v_country IS NULL THEN
        RETURN NULL;
      END IF;
      SELECT g.generation INTO v_missing
        FROM corpus_index_generations g
       WHERE g.family = v_family
         AND g.status IN (${active})
         AND ${checkedScope(checked)}
         AND ${partialScopes()}
         AND NOT EXISTS (
           SELECT 1 FROM corpus_index_projection_states s
            WHERE s.family = v_family
              AND s.generation = g.generation
              AND s.entity_id = NEW.id
         )
       ORDER BY g.generation
       LIMIT 1;
      IF v_missing IS NULL THEN
        RETURN NULL;
      END IF;
      SELECT count(*) INTO v_present
        FROM corpus_index_generations g
        JOIN corpus_index_projection_states s
          ON s.family = v_family
         AND s.generation = g.generation
         AND s.entity_id = NEW.id
       WHERE g.family = v_family
         AND g.status IN (${active})
         AND ${checkedScope(checked)}
         AND ${partialScopes()};
      -- None of them: allowed only while the row is not projectable; its
      -- settle transaction seeds every active generation at once.
      IF v_present = 0 AND NOT v_projectable THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION
        '% % (%) committed with no desired state in active generation % (states in % other active generations, projectable %)',
        v_family, NEW.id, v_country, v_missing, v_present, v_projectable;
      RETURN NULL;
    END;
    $$;
    ${STATEMENT_BREAK}
    DROP TRIGGER IF EXISTS ${GUARD_FUNCTION} ON case_law_decisions;
    ${STATEMENT_BREAK}
    CREATE CONSTRAINT TRIGGER ${GUARD_FUNCTION}
      AFTER INSERT OR UPDATE OF projection_epoch, country, corpus_mirror_status
      ON case_law_decisions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${GUARD_FUNCTION}();
    ${STATEMENT_BREAK}
    DROP TRIGGER IF EXISTS ${GUARD_FUNCTION} ON legislation_documents;
    ${STATEMENT_BREAK}
    CREATE CONSTRAINT TRIGGER ${GUARD_FUNCTION}
      AFTER INSERT OR UPDATE OF projection_epoch, country, content_hash
      ON legislation_documents
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION ${GUARD_FUNCTION}();
  `;
};

/** Install the guard; the test database builds call this, suites do not. */
export const installCorpusProjectionSeedingGuard = async (
  client: Pick<PGlite, "exec">,
): Promise<void> => {
  await client.exec(
    corpusProjectionSeedingGuardStatements()
      .map((statement) => `${statement};`)
      .join("\n"),
  );
};

/**
 * Turn the guard off for the rest of this PGlite session (the whole suite).
 * The reason is the review record: say which writer the suite runs and why
 * it cannot keep the all-or-none rule.
 */
export const optOutOfCorpusProjectionSeedingGuard = async (
  client: Pick<PGlite, "query">,
  { reason }: { reason: string },
): Promise<void> => {
  if (reason.trim().length < 20) {
    panic("A seeding guard opt-out needs a written reason");
  }
  await client.query(
    "SELECT set_config('stella_test.corpus_projection_seeding_guard', 'off', false)",
  );
};
