import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { citationAuthorityBucket } from "@/api/lib/legal-search/case-law-ranking-signals";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { readCaseLawRankingSignals } from "@/api/lib/legal-search/corpus-index-projection-ranking-signals";
import {
  OBSERVATION_DETAIL,
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000501",
);
const decisionId = (suffix: string) =>
  toSafeId<"caseLawDecision">(`0198e331-e578-7000-8000-000000000${suffix}`);
/** Shares its group with a published sibling. */
const SHARED = decisionId("502");
const SHARED_SIBLING = decisionId("503");
/** Alone in its group. */
const ALONE = decisionId("504");
/** Its only sibling is a listing the publisher never served, so not published. */
const UNPUBLISHED_SIBLING_OF = decisionId("505");
const UNPUBLISHED_SIBLING = decisionId("506");
/** A legacy row without a group key. */
const UNGROUPED = decisionId("507");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const inTx = async <T>(operation: (tx: Transaction) => Promise<T>) =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

const decision = (
  id: ReturnType<typeof decisionId>,
  languageGroupKey: string | null,
  overrides: Partial<typeof caseLawDecisions.$inferInsert> = {},
): typeof caseLawDecisions.$inferInsert => ({
  id,
  sourceId: SOURCE_ID,
  caseNumber: `${id.slice(-3)} Cdo 1/2020`,
  court: "Najvyšší súd Slovenskej republiky",
  country: "SVK",
  language: "sk",
  languageGroupKey,
  contentHash: id.slice(-1).repeat(64),
  ...overrides,
});

// timeout: builds the PGlite schema from every migration.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-ranking-signals",
    name: "Projection ranking signals",
  });
  await db.insert(caseLawDecisions).values([
    decision(SHARED, "group-shared", { citationAuthority: 0.8 }),
    decision(SHARED_SIBLING, "group-shared", { language: "cs" }),
    decision(ALONE, "group-alone", { citationAuthority: 3 }),
    decision(UNPUBLISHED_SIBLING_OF, "group-unpublished"),
    decision(UNPUBLISHED_SIBLING, "group-unpublished", {
      metadata: {
        [PARTIAL_OBSERVATION_KEY]: {
          [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
          [PARTIAL_OBSERVATION_FIELD.DETAIL]: OBSERVATION_DETAIL.LISTING_ONLY,
        },
      },
    }),
    decision(UNGROUPED, null),
  ]);
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: "case_law_v10",
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v10,
    ),
    status: "building",
  });
});

afterAll(async () => {
  await client.close();
});

test("one loader reads each decision's authority bucket, group key and whether a published decision shares the group", async () => {
  const ids = [
    SHARED,
    SHARED_SIBLING,
    ALONE,
    UNPUBLISHED_SIBLING_OF,
    UNGROUPED,
  ];
  const signals = await inTx(
    async (tx) => await readCaseLawRankingSignals(tx, ids),
  );
  expect(Object.fromEntries(signals)).toEqual({
    [SHARED]: {
      citationAuthorityBucket: citationAuthorityBucket(0.8),
      languageGroupKey: "group-shared",
      languageGroupShared: true,
    },
    [SHARED_SIBLING]: {
      citationAuthorityBucket: 0,
      languageGroupKey: "group-shared",
      languageGroupShared: true,
    },
    [ALONE]: {
      citationAuthorityBucket: citationAuthorityBucket(3),
      languageGroupKey: "group-alone",
      languageGroupShared: false,
    },
    // An unpublished sibling shares nothing.
    [UNPUBLISHED_SIBLING_OF]: {
      citationAuthorityBucket: 0,
      languageGroupKey: "group-unpublished",
      languageGroupShared: false,
    },
    [UNGROUPED]: {
      citationAuthorityBucket: 0,
      languageGroupKey: null,
      languageGroupShared: false,
    },
  });
  // The fixture reaches both answers and more than one bucket.
  expect(citationAuthorityBucket(0.8)).not.toBe(citationAuthorityBucket(3));

  // A batch answers exactly what each decision answers alone.
  const alone = await inTx(
    async (tx) => await readCaseLawRankingSignals(tx, [SHARED]),
  );
  expect(alone.get(SHARED)).toEqual(signals.get(SHARED));
  // A decision the read cannot find has no entry rather than a default.
  const missing = decisionId("599");
  expect(
    (await inTx(async (tx) => await readCaseLawRankingSignals(tx, [missing])))
      .size,
  ).toBe(0);
});

const fingerprintOf = async (id: ReturnType<typeof decisionId>) =>
  (
    await db
      .select({ fingerprint: corpusIndexProjectionStates.desiredFingerprint })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, id))
  ).at(0)?.fingerprint ?? null;

const advance = async (id: ReturnType<typeof decisionId>) =>
  await inTx(
    async (tx) =>
      await advanceCorpusProjectionDesiredStateTx(tx, {
        family: "case_law",
        entityId: id,
      }),
  );

test("bootstrap and the canonical lock derive the same projection from the same signals", async () => {
  await inTx(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(tx, {
        family: "case_law",
        generation: "case_law_v10",
        limit: 10,
      }),
  );
  const bootstrapped = await fingerprintOf(ALONE);
  expect(bootstrapped).not.toBeNull();
  await db
    .delete(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, ALONE));
  await db
    .update(caseLawDecisions)
    .set({ projectionEpoch: 0n })
    .where(eq(caseLawDecisions.id, ALONE));
  await advance(ALONE);
  expect(await fingerprintOf(ALONE)).toBe(bootstrapped);
});

test("an authority write re-projects a decision only when it moves the bucket", async () => {
  await advance(ALONE);
  const before = await fingerprintOf(ALONE);
  expect(before).not.toBeNull();

  // Decay by a sliver: the same bucket, the same desired state.
  const nudged = 3.0001;
  expect(citationAuthorityBucket(nudged)).toBe(citationAuthorityBucket(3));
  await db
    .update(caseLawDecisions)
    .set({ citationAuthority: nudged })
    .where(eq(caseLawDecisions.id, ALONE));
  await advance(ALONE);
  expect(await fingerprintOf(ALONE)).toBe(before);

  // A new citation: another bucket, a new desired state.
  const cited = 4;
  expect(citationAuthorityBucket(cited)).not.toBe(citationAuthorityBucket(3));
  await db
    .update(caseLawDecisions)
    .set({ citationAuthority: cited })
    .where(eq(caseLawDecisions.id, ALONE));
  await advance(ALONE);
  expect(await fingerprintOf(ALONE)).not.toBe(before);
});

test("a sibling published into a decision's group re-projects it", async () => {
  await advance(ALONE);
  const before = await fingerprintOf(ALONE);
  await db
    .insert(caseLawDecisions)
    .values(decision(decisionId("508"), "group-alone", { language: "cs" }));
  await advance(ALONE);
  expect(await fingerprintOf(ALONE)).not.toBe(before);
});
