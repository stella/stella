import { panic } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawRankingSignalChanges,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { drainCaseLawRankingSignalChanges } from "@/api/lib/legal-search/case-law-ranking-signal-drain";
import {
  CITATION_AUTHORITY_BUCKETS,
  citationAuthorityBucket,
} from "@/api/lib/legal-search/case-law-ranking-signals";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";
import {
  OBSERVATION_DETAIL,
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000601",
);
const decisionId = (suffix: string) =>
  toSafeId<"caseLawDecision">(`0198e331-e578-7000-8000-000000000${suffix}`);
const CITED = decisionId("602");
const MEMBER = decisionId("603");
const JOINER = decisionId("604");
const LISTING = decisionId("605");

const LISTING_ONLY_METADATA = {
  [PARTIAL_OBSERVATION_KEY]: {
    [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
    [PARTIAL_OBSERVATION_FIELD.DETAIL]: OBSERVATION_DETAIL.LISTING_ONLY,
  },
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <T>(work: (tx: Transaction) => Promise<T>) =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const decision = (
  id: ReturnType<typeof decisionId>,
  languageGroupKey: string | null,
  overrides: Partial<typeof caseLawDecisions.$inferInsert> = {},
): typeof caseLawDecisions.$inferInsert => ({
  id,
  sourceId: SOURCE_ID,
  caseNumber: `${id.slice(-3)} Cdo 1/2020`,
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  languageGroupKey,
  contentHash: id.slice(-1).repeat(64),
  ...overrides,
});

const queued = async () =>
  Object.fromEntries(
    (
      await db
        .select({
          id: caseLawRankingSignalChanges.decisionId,
          count: caseLawRankingSignalChanges.changeCount,
        })
        .from(caseLawRankingSignalChanges)
    ).map(({ id, count }) => [id, count]),
  );

const setAuthority = async (
  id: ReturnType<typeof decisionId>,
  authority: number,
) =>
  await db
    .update(caseLawDecisions)
    .set({ citationAuthority: authority })
    .where(eq(caseLawDecisions.id, id));

// timeout: builds the PGlite schema from every migration.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawRankingSignalChanges).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "ranking-signal-changes",
    name: "Ranking signal changes",
  });
  await db
    .insert(caseLawDecisions)
    .values([decision(CITED, "group-cited"), decision(MEMBER, "group-pair")]);
  // Inserting the fixture enqueued its own groups; each test starts empty.
  await db.delete(caseLawRankingSignalChanges).where(sql`true`);
});

afterAll(async () => {
  await client.close();
});

test("the database's bucket function is the TypeScript bucket on every edge", async () => {
  const authorities = [0, -1, 1e-12, 0.5, 1, 3, 63, 1e6, Number.MAX_VALUE];
  for (let cell = 1; cell < CITATION_AUTHORITY_BUCKETS; cell += 1) {
    const saturated = cell / CITATION_AUTHORITY_BUCKETS;
    const edge = saturated / (1 - saturated);
    authorities.push(
      edge,
      edge * (1 - Number.EPSILON),
      edge * (1 + Number.EPSILON),
    );
  }
  const rows = await db.execute<{ bucket: number }>(sql`
    SELECT case_law_citation_authority_bucket(authority) AS bucket
    FROM (VALUES ${sql.join(
      authorities.map(
        (authority, position) =>
          sql`(${sql.raw(`${String(position)}, ${authority.toPrecision(17)}::double precision`)})`,
      ),
      sql`, `,
    )}) AS edge (position, authority)
    ORDER BY position
  `);
  expect(rows.rows.map(({ bucket }) => bucket)).toEqual(
    authorities.map((authority) => citationAuthorityBucket(authority)),
  );
  expect(new Set(rows.rows.map(({ bucket }) => bucket)).size).toBe(
    CITATION_AUTHORITY_BUCKETS + 1,
  );
});

test("an authority write is enqueued only when it moves the decision's bucket", async () => {
  await setAuthority(CITED, 3);
  expect(await queued()).toEqual({ [CITED]: 1n });
  // Decay by a sliver: the same bucket, nothing new.
  expect(citationAuthorityBucket(3.0001)).toBe(citationAuthorityBucket(3));
  await setAuthority(CITED, 3.0001);
  expect(await queued()).toEqual({ [CITED]: 1n });
  // A new citation moves the bucket again and bumps the waiting row.
  await setAuthority(CITED, 4);
  expect(await queued()).toEqual({ [CITED]: 2n });
});

test("a publication into or out of a language group enqueues every member", async () => {
  await db.insert(caseLawDecisions).values(decision(JOINER, "group-pair"));
  expect(await queued()).toEqual({ [MEMBER]: 1n, [JOINER]: 1n });

  // A listing the publisher never served joins nothing.
  await db.delete(caseLawRankingSignalChanges).where(sql`true`);
  await db.insert(caseLawDecisions).values(
    decision(LISTING, "group-pair", {
      metadata: LISTING_ONLY_METADATA,
    }),
  );
  expect(await queued()).toEqual({});

  // Its detail arriving publishes it into the group.
  await db
    .update(caseLawDecisions)
    .set({ metadata: {} })
    .where(eq(caseLawDecisions.id, LISTING));
  expect(Object.keys(await queued()).toSorted()).toEqual(
    [MEMBER, JOINER, LISTING].toSorted(),
  );

  // An edit that leaves publication and group alone enqueues nothing.
  await db.delete(caseLawRankingSignalChanges).where(sql`true`);
  await db
    .update(caseLawDecisions)
    .set({ metadata: { note: "edited" } })
    .where(eq(caseLawDecisions.id, LISTING));
  expect(await queued()).toEqual({});

  // Leaving a group enqueues the members left behind and the old group.
  await db
    .update(caseLawDecisions)
    .set({ languageGroupKey: "group-elsewhere" })
    .where(eq(caseLawDecisions.id, JOINER));
  expect(Object.keys(await queued()).toSorted()).toEqual(
    [MEMBER, JOINER, LISTING].toSorted(),
  );
});

const registerV10 = async () => {
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: "case_law_v10",
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v10,
    ),
    status: "building",
  });
  await runInTransaction(
    async (tx) =>
      await bootstrapCorpusProjectionDesiredStateBatchTx(tx, {
        family: "case_law",
        generation: "case_law_v10",
        limit: 10,
      }),
  );
};

const fingerprintOf = async (id: ReturnType<typeof decisionId>) =>
  (
    await db
      .select({ fingerprint: corpusIndexProjectionStates.desiredFingerprint })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, id))
  ).at(0)?.fingerprint ?? panic(`No desired state for ${id}`);

test("the drain reconciles a moved decision's desired state and consumes its row", async () => {
  await registerV10();
  const before = await fingerprintOf(CITED);
  await setAuthority(CITED, 3);
  expect(await queued()).toEqual({ [CITED]: 1n });

  expect(await drainCaseLawRankingSignalChanges({ runInTransaction })).toEqual({
    claimed: 1,
    reconciled: 1,
    dropped: 0,
    requeued: 0,
  });
  expect(await fingerprintOf(CITED)).not.toBe(before);
  expect(await queued()).toEqual({});
  // Nothing left: the next drain claims nothing.
  expect(await drainCaseLawRankingSignalChanges({ runInTransaction })).toEqual({
    claimed: 0,
    reconciled: 0,
    dropped: 0,
    requeued: 0,
  });
});

test("a change that arrives while a drain runs stays for the next drain", async () => {
  await registerV10();
  await setAuthority(CITED, 3);
  let transactions = 0;
  // The reconcile transaction is the drain's third: claim, source read,
  // reconcile. A change lands just before it, as a concurrent sweep would.
  const interleaved = async <T>(work: (tx: Transaction) => Promise<T>) => {
    transactions += 1;
    if (transactions === 3) {
      await setAuthority(CITED, 5);
    }
    return await runInTransaction(work);
  };
  expect(
    await drainCaseLawRankingSignalChanges({ runInTransaction: interleaved }),
  ).toEqual({ claimed: 1, reconciled: 1, dropped: 0, requeued: 1 });
  expect(await queued()).toEqual({ [CITED]: 2n });
  // The newer change releases the claim, so the next drain takes it at once.
  expect(
    (await drainCaseLawRankingSignalChanges({ runInTransaction })).claimed,
  ).toBe(1);
  expect(await queued()).toEqual({});
});

test("a queued decision that no longer exists is dropped", async () => {
  await registerV10();
  const gone = decisionId("699");
  await db.execute(
    sql`INSERT INTO case_law_ranking_signal_changes (decision_id) VALUES (${gone})`,
  );
  expect(await drainCaseLawRankingSignalChanges({ runInTransaction })).toEqual({
    claimed: 1,
    reconciled: 0,
    dropped: 1,
    requeued: 0,
  });
  expect(await queued()).toEqual({});
});
