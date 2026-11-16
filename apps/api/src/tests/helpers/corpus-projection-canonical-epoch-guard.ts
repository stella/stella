/**
 * A test-database guard on every desired-state write: the desired epoch a
 * writer stores is the canonical row's projection epoch at that moment.
 *
 * Comparing two generations' applied epochs, as the flip parity read does
 * (`corpus-index-flip-parity.ts`), is sound only while every generation's
 * epoch is a reading of the one per-decision counter. A writer that numbers a
 * generation's epochs on its own, or writes ahead of the canonical row, would
 * make that comparison lie without failing anything else. Installed in every
 * suite that runs a desired-state writer (seeding, advance, reconcile, batch
 * reconcile, retirement, the ranking-signal drain), it fails the statement
 * that breaks the rule. A state no writer touches may trail the counter; the
 * guard never looks at it.
 *
 * Why it is not a production trigger. The rule is not one comparison on the
 * written row: it reads the canonical row of another table on every
 * desired-state write, the projection's hottest path (seeding writes one row
 * per decision and generation). Under concurrent writers it is also not the
 * writer's invariant: a writer stamps the epoch it read, and a canonical
 * update committed between that read and the trigger's own statement
 * snapshot would fail a correct write, so the trigger would need every
 * writer to hold the canonical row's lock first, which not all do. A
 * weaker, race-free form (never ahead of the canonical epoch) does not catch
 * the defect it exists for, a per-generation counter that trails. So the rule
 * stays a property every writer suite checks, and the flip parity read
 * (`corpus-index-flip-parity.ts`) states that it depends on it.
 */
import type { PGlite } from "@electric-sql/pglite";

const GUARD_FUNCTION = "test_corpus_projection_canonical_epoch_guard";

/**
 * Set to `off` with `set_config(..., true)` inside one transaction, only by a
 * fixture that puts back a state as a writer left it alone (a generation
 * whose epoch trails because nothing wrote it).
 */
export const CORPUS_PROJECTION_CANONICAL_EPOCH_GUARD_OFF_SETTING =
  "stella_test.corpus_projection_canonical_epoch_guard";
const GUARD_OFF_SETTING = CORPUS_PROJECTION_CANONICAL_EPOCH_GUARD_OFF_SETTING;

export const installCorpusProjectionCanonicalEpochGuard = async (
  client: PGlite,
): Promise<void> => {
  await client.exec(`
    CREATE OR REPLACE FUNCTION ${GUARD_FUNCTION}() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      canonical bigint;
    BEGIN
      -- A fixture restoring a row as no writer left it, never a writer.
      IF current_setting('${GUARD_OFF_SETTING}', true) = 'off' THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE'
        AND NEW.desired_epoch IS NOT DISTINCT FROM OLD.desired_epoch
        AND NEW.desired_action IS NOT DISTINCT FROM OLD.desired_action
        AND NEW.desired_fingerprint IS NOT DISTINCT FROM OLD.desired_fingerprint
        AND NEW.desired_index_id IS NOT DISTINCT FROM OLD.desired_index_id
      THEN
        RETURN NEW;
      END IF;
      IF NEW.family = 'case_law' THEN
        SELECT projection_epoch INTO canonical
          FROM case_law_decisions WHERE id = NEW.entity_id;
      ELSE
        SELECT projection_epoch INTO canonical
          FROM legislation_documents WHERE id = NEW.entity_id;
      END IF;
      IF canonical IS DISTINCT FROM NEW.desired_epoch THEN
        RAISE EXCEPTION
          'desired epoch % of %/% is not the canonical projection epoch %',
          NEW.desired_epoch, NEW.generation, NEW.entity_id, canonical;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS ${GUARD_FUNCTION} ON corpus_index_projection_states;
    CREATE TRIGGER ${GUARD_FUNCTION}
      BEFORE INSERT OR UPDATE ON corpus_index_projection_states
      FOR EACH ROW EXECUTE FUNCTION ${GUARD_FUNCTION}();
  `);
};
