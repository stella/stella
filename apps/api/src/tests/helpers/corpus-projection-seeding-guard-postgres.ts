import { beforeAll } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, corpusIndexGenerations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  lockCaseLawProjectabilitySourcesTx,
  projectCaseLawDecisionsTx,
} from "@/api/lib/legal-search/corpus-projectability-write";
import type {
  GatedTestDatabase,
  GatedTestDb,
} from "@/api/tests/gated-test-database";
import {
  type CheckedGeneration,
  CORPUS_PROJECTION_SEEDING_GUARD_TRIGGER,
  corpusProjectionSeedingGuardStatements,
} from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * Guard a Postgres suite with the seeding guard
 * (`corpus-projection-seeding-guard.ts`): register these generations as
 * building (unless a suite before it left them registered) and install the
 * guard checking only them, before the suite's tests; remove the guard after
 * them. A writer the suite runs then projects into them as into any active
 * generation, and a fixture that stands a projectable row up commits it with
 * its states (or sets the off switch for its own transaction, with a reason).
 *
 * Call it where the suite opens its database. Installing it is DDL on the
 * canonical tables, so the suite is listed in
 * `EXCLUSIVE_SHARED_TABLE_DDL_TEST_PATHS` and runs on a fresh clone.
 */
export const guardPostgresSuiteSeeding = (
  { db, sql, cleanUp }: GatedTestDatabase,
  { generations }: { generations: readonly CheckedGeneration[] },
): void => {
  beforeAll(async () => {
    await db
      .insert(corpusIndexGenerations)
      .values(
        generations.map((generation) => {
          const manifest = CORPUS_INDEX_MANIFESTS[generation];
          return {
            family: manifest.family,
            generation,
            cluster: "q09" as const,
            manifestDigest: corpusIndexManifestDigest(manifest),
            status: "building" as const,
          };
        }),
      )
      .onConflictDoNothing();
    await sql.begin(async (tx) => {
      for (const statement of corpusProjectionSeedingGuardStatements(
        generations,
      )) {
        // db-await-in-loop: a fixed handful of DDL statements, in order.
        await tx.unsafe(statement);
      }
    });
  });
  cleanUp(async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe(
        `DROP TRIGGER IF EXISTS ${CORPUS_PROJECTION_SEEDING_GUARD_TRIGGER} ON case_law_decisions`,
      );
      await tx.unsafe(
        `DROP TRIGGER IF EXISTS ${CORPUS_PROJECTION_SEEDING_GUARD_TRIGGER} ON legislation_documents`,
      );
      await tx.unsafe(
        `DROP FUNCTION IF EXISTS ${CORPUS_PROJECTION_SEEDING_GUARD_TRIGGER}()`,
      );
    });
  });
};

/**
 * Commit fixture decisions with their desired states in every active
 * generation, as the ingestion writer commits a decision it settles: the
 * fixture stands up decisions that existed before the suite's writer runs.
 */
export const insertProjectedFixtureDecisions = async (
  db: GatedTestDb,
  rows: readonly (typeof caseLawDecisions.$inferInsert & {
    id: SafeId<"caseLawDecision">;
  })[],
): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.insert(caseLawDecisions).values([...rows]);
    const writer = asTestRaw<Transaction>(tx);
    const ids = rows.map(({ id }) => id);
    const lock = await lockCaseLawProjectabilitySourcesTx(writer, ids);
    if (lock !== null) {
      await projectCaseLawDecisionsTx(writer, lock, ids);
    }
  });
};
