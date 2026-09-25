import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";

import { stellaPublicLawReader } from "@/api/db/rls";
import { caseLawCourtWeights, caseLawFtsConfigs } from "@/api/db/schema";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CaseLawConfigReadTransaction } from "@/api/lib/case-law/case-law-config-read";
import {
  loadLocalCourtWeights,
  resetLocalCaseLawConfigForTesting,
  resolveLocalFtsConfig,
} from "@/api/lib/case-law/local-case-law-config";
import {
  loadPublicCourtWeights,
  loadPublicFtsSearchConfigs,
  resetPublicCaseLawConfigForTesting,
} from "@/api/lib/case-law/public-case-law-config";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * The public search paths and the local indexers read the same two
 * configuration tables from different databases, and each keeps its own
 * cache. These cases give the two sources deliberately different rows and
 * start every case cold, so a cache that answered from the other source's
 * rows, or a read bound to the wrong source, shows as the wrong value.
 */

const LANGUAGE = "zz";
const COUNTRY = "XZZ";
const COURT_PATTERN = "config source census court";

const LOCAL_FTS = { regconfig: "simple", useUnaccent: true };
const EXTERNAL_FTS = { regconfig: "english", useUnaccent: false };
const LOCAL_TIER = 2;
const EXTERNAL_TIER = 5;

let testDb: TestDatabase;

/**
 * The external corpus: the same database read as the public-law reader,
 * inside a transaction where its configuration differs from the committed
 * rows. The difference rolls back with the read, so only a read through this
 * handle can see it.
 */
const externalReadDb = async <T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
): Promise<T> => {
  const results: { value: T }[] = [];
  try {
    await testDb.transaction(async (tx) => {
      await tx
        .update(caseLawFtsConfigs)
        .set(EXTERNAL_FTS)
        .where(eq(caseLawFtsConfigs.language, LANGUAGE));
      await tx
        .update(caseLawCourtWeights)
        .set({ tier: EXTERNAL_TIER })
        .where(eq(caseLawCourtWeights.country, COUNTRY));
      await tx.execute(
        sql.raw(`SET LOCAL ROLE "${stellaPublicLawReader.name}"`),
      );
      results.push({
        value: await fn(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      });
      tx.rollback();
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
  }
  const result = results.at(0);
  return result === undefined
    ? panic("the external read did not complete")
    : result.value;
};

const publicFtsConfigFor = async (language: string) =>
  (await loadPublicFtsSearchConfigs()).find((config) =>
    config.languages.includes(language),
  );

const tierIn = (
  map: Awaited<ReturnType<typeof loadLocalCourtWeights>>,
): number | undefined => map.get(COUNTRY)?.at(0)?.tier;

beforeAll(
  async () => {
    testDb = await getTestDb();
    await testDb
      .insert(caseLawFtsConfigs)
      .values({ language: LANGUAGE, ...LOCAL_FTS });
    await testDb.insert(caseLawCourtWeights).values({
      country: COUNTRY,
      courtPattern: COURT_PATTERN,
      tier: LOCAL_TIER,
      tierLabel: "appellate",
      weight: 3,
    });
  },
  { timeout: 30_000 },
);

beforeEach(() => {
  // Cold caches, each bound to its test source.
  resetPublicCaseLawConfigForTesting(
    asTestRaw<CaseLawPublicReadDb>(externalReadDb),
  );
  resetLocalCaseLawConfigForTesting(
    asTestRaw<CaseLawConfigReadTransaction>(testDb),
  );
});

afterAll(async () => {
  resetPublicCaseLawConfigForTesting();
  resetLocalCaseLawConfigForTesting();
  await testDb
    .delete(caseLawCourtWeights)
    .where(eq(caseLawCourtWeights.country, COUNTRY));
  await testDb
    .delete(caseLawFtsConfigs)
    .where(eq(caseLawFtsConfigs.language, LANGUAGE));
  await releaseTestDb();
});

describe("case-law configuration sources", () => {
  test("each source reads its own rows", async () => {
    expect(await resolveLocalFtsConfig(LANGUAGE)).toEqual(LOCAL_FTS);
    expect(await publicFtsConfigFor(LANGUAGE)).toMatchObject(EXTERNAL_FTS);
    expect(tierIn(await loadLocalCourtWeights())).toBe(LOCAL_TIER);
    expect(tierIn(await loadPublicCourtWeights())).toBe(EXTERNAL_TIER);
  });

  test("a warm public cache does not answer a local read", async () => {
    await loadPublicFtsSearchConfigs();
    await loadPublicCourtWeights();

    expect(await resolveLocalFtsConfig(LANGUAGE)).toEqual(LOCAL_FTS);
    expect(tierIn(await loadLocalCourtWeights())).toBe(LOCAL_TIER);
  });

  test("a warm local cache does not answer a public read", async () => {
    await resolveLocalFtsConfig(LANGUAGE);
    await loadLocalCourtWeights();

    expect(await publicFtsConfigFor(LANGUAGE)).toMatchObject(EXTERNAL_FTS);
    expect(tierIn(await loadPublicCourtWeights())).toBe(EXTERNAL_TIER);
  });
});
