import type {
  GatedTestClientScope,
  GatedTestDb,
} from "@/api/tests/gated-test-database";

import {
  type CorpusReadBudgetSeed,
  seedCorpusReadBudgets,
} from "./corpus-seed";
import { createQueryPerfDeadline, type QueryPerfDeadline } from "./deadline";
import { dropRetainedQueryPerfFixture, withQueryPerfFixture } from "./fixture";
import { queryPerfDatabaseName } from "./profiles";

const SEEDED_CORPUS = `${queryPerfDatabaseName("corpus")}_seeded`;

let seeded:
  { databaseUrl: string; seed: Promise<CorpusReadBudgetSeed> } | undefined;

type SeededCorpusOptions<T> = {
  databaseUrl: string;
  /** The test's whole budget: the seed when this test is first, the clone and its work. */
  timeoutMs: number;
  run: (fixture: {
    db: GatedTestDb;
    deadline: QueryPerfDeadline;
    openClient: GatedTestClientScope["openClient"];
    seed: CorpusReadBudgetSeed;
  }) => Promise<T>;
};

/**
 * A fresh clone of the seeded corpus. The corpus is seeded once per run into a
 * kept database, and each test measures its own copy of it, so a test pays
 * for its own measurements (and, if it is the first, for the seed) rather
 * than for every phase another test's measurements add.
 */
export const withSeededCorpus = async <T>({
  databaseUrl,
  timeoutMs,
  run,
}: SeededCorpusOptions<T>) => {
  const deadline = createQueryPerfDeadline({ profileId: "corpus", timeoutMs });
  seeded ??= {
    databaseUrl,
    seed: withQueryPerfFixture({
      databaseUrl,
      profileId: "corpus",
      deadline,
      retainAs: SEEDED_CORPUS,
      run: async (db, phases) =>
        await phases.run("seed", async () => await seedCorpusReadBudgets(db)),
    }),
  };
  const seed = await seeded.seed;
  return await withQueryPerfFixture({
    databaseUrl,
    profileId: "corpus",
    deadline,
    template: SEEDED_CORPUS,
    run: async (db, phases, openClient) =>
      await run({ db, deadline: phases, openClient, seed }),
  });
};

/** Drops the seeded corpus once its tests have run; a no-op when none seeded it. */
export const dropSeededCorpus = async () => {
  if (seeded === undefined) {
    return;
  }
  const { databaseUrl } = seeded;
  seeded = undefined;
  await dropRetainedQueryPerfFixture({
    databaseUrl,
    name: SEEDED_CORPUS,
    profileId: "corpus",
  });
};
