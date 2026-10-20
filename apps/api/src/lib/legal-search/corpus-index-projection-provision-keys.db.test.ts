import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { PROVISION_KEYS_MAX_COUNT } from "@/api/lib/case-law/provision-keys";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { readCaseLawProvisionKeys } from "@/api/lib/legal-search/corpus-index-projection-provision-keys";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000401",
);
const CZE_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000402",
);
const EMPTY_CZE_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000403",
);
const POL_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000404",
);

const WORK = "262/2006 Sb.";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const insertLink = async ({
  decisionId,
  jurisdiction,
  work = WORK,
  anchor,
  spanStart,
}: {
  decisionId: typeof CZE_DECISION_ID;
  jurisdiction: string;
  work?: string;
  anchor: string;
  spanStart: number;
}) =>
  await db.execute(sql`INSERT INTO case_law_provision_citations
    (id, decision_id, jurisdiction, work_identifier, work_number, work_year,
     work_collection, unit, section, anchor, span_start, span_end, sentence_text,
     confidence)
    VALUES (${createSafeId<"caseLawProvisionCitation">()}, ${decisionId},
      ${jurisdiction}, ${work}, 262, 2006, 'Sb.', 'section', 316, ${anchor},
      ${spanStart}, ${spanStart + 5}, ${`citation ${String(spanStart)}`}, 1)`);

const inTx = async <T>(operation: (tx: Transaction) => Promise<T>) =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawProvisionCitations).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-provision-keys",
    name: "Projection provision keys",
  });
  await db.insert(caseLawDecisions).values([
    {
      id: CZE_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "4 As 3/2008",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "a".repeat(64),
    },
    {
      id: EMPTY_CZE_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "4 As 4/2008",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "b".repeat(64),
    },
    {
      id: POL_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "III SA/Wa 1/2026",
      court: "Test court",
      country: "POL",
      language: "pl",
      contentHash: "c".repeat(64),
    },
  ]);
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: "case_law_v9",
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v9,
    ),
    status: "building",
  });
});

afterAll(async () => {
  await client.close();
});

test("one loader reads the prefixes of every recorded anchor, distinct and sorted, and reads nothing for a group without the field", async () => {
  await insertLink({
    decisionId: CZE_DECISION_ID,
    jurisdiction: "CZE",
    anchor: "par_316-odst_2-pism_a",
    spanStart: 10,
  });
  // The same provision cited twice, and a second one under the same section.
  await insertLink({
    decisionId: CZE_DECISION_ID,
    jurisdiction: "CZE",
    anchor: "par_316-odst_2-pism_a",
    spanStart: 40,
  });
  await insertLink({
    decisionId: CZE_DECISION_ID,
    jurisdiction: "CZE",
    anchor: "par_316-odst_3",
    spanStart: 70,
  });
  // Another work's links never mix into this work's keys.
  await insertLink({
    decisionId: CZE_DECISION_ID,
    jurisdiction: "CZE",
    work: "89/2012 Sb.",
    anchor: "par_1",
    spanStart: 100,
  });
  await insertLink({
    decisionId: POL_DECISION_ID,
    jurisdiction: "POL",
    anchor: "par_1",
    spanStart: 10,
  });

  const keys = await inTx(
    async (tx) =>
      await readCaseLawProvisionKeys(tx, [
        { id: CZE_DECISION_ID, jurisdiction: "CZE" },
        { id: EMPTY_CZE_DECISION_ID, jurisdiction: "CZE" },
        { id: POL_DECISION_ID, jurisdiction: "POL" },
      ]),
  );
  expect(keys.get(CZE_DECISION_ID)).toEqual([
    "262/2006 Sb.|par_316",
    "262/2006 Sb.|par_316-odst_2",
    "262/2006 Sb.|par_316-odst_2-pism_a",
    "262/2006 Sb.|par_316-odst_3",
    "89/2012 Sb.|par_1",
  ]);
  expect(keys.get(EMPTY_CZE_DECISION_ID)).toEqual([]);
  // Poland's group carries no provision keys, so its links are not read.
  expect(keys.get(POL_DECISION_ID)).toEqual([]);

  // A batch answers exactly what each decision answers alone, which is what
  // the lock read, the batched material read and the bootstrap rely on.
  const alone = await inTx(
    async (tx) =>
      await readCaseLawProvisionKeys(tx, [
        { id: CZE_DECISION_ID, jurisdiction: "CZE" },
      ]),
  );
  expect(alone.get(CZE_DECISION_ID)).toEqual(keys.get(CZE_DECISION_ID));
});

test("a decision past the key cap keeps the cap, shallowest first", async () => {
  await db.execute(sql`INSERT INTO case_law_provision_citations
    (id, decision_id, jurisdiction, work_identifier, work_number, work_year,
     work_collection, unit, section, anchor, span_start, span_end, sentence_text,
     confidence)
    SELECT gen_random_uuid(), ${CZE_DECISION_ID}, 'CZE', ${WORK}, 262, 2006,
      'Sb.', 'section', n, 'par_' || n::text || '-odst_1', n * 10, n * 10 + 5,
      'citation ' || n::text, 1
    FROM generate_series(1, ${PROVISION_KEYS_MAX_COUNT}) AS n`);
  const keys = (
    await inTx(
      async (tx) =>
        await readCaseLawProvisionKeys(tx, [
          { id: CZE_DECISION_ID, jurisdiction: "CZE" },
        ]),
    )
  ).get(CZE_DECISION_ID);
  // 256 sections and 256 subsections are 512 keys; the cap keeps 256, and
  // every one of them is a section key because those answer the broadest
  // filter.
  expect(keys).toHaveLength(PROVISION_KEYS_MAX_COUNT);
  expect(keys?.every((key) => !key.includes("odst_"))).toBe(true);
});

test("bootstrap and the canonical lock derive the same projection from the same links", async () => {
  const stateOf = async () =>
    (
      await db
        .select({
          fingerprint: corpusIndexProjectionStates.desiredFingerprint,
          indexId: corpusIndexProjectionStates.desiredIndexId,
        })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, CZE_DECISION_ID))
    ).at(0);
  const reset = async () => {
    await db
      .delete(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, CZE_DECISION_ID));
    await db
      .update(caseLawDecisions)
      .set({ projectionEpoch: 0n })
      .where(eq(caseLawDecisions.id, CZE_DECISION_ID));
  };
  const bootstrap = async () =>
    await inTx(
      async (tx) =>
        await bootstrapCorpusProjectionDesiredStateBatchTx(tx, {
          family: "case_law",
          generation: "case_law_v9",
          limit: 10,
        }),
    );

  await bootstrap();
  const withoutLinks = await stateOf();
  expect(withoutLinks?.indexId).toBe("case_law_v9_cze");

  await insertLink({
    decisionId: CZE_DECISION_ID,
    jurisdiction: "CZE",
    anchor: "par_316-odst_2",
    spanStart: 10,
  });
  await reset();
  await bootstrap();
  const bootstrapped = await stateOf();

  await reset();
  await inTx(
    async (tx) =>
      await advanceCorpusProjectionDesiredStateTx(tx, {
        family: "case_law",
        entityId: CZE_DECISION_ID,
      }),
  );
  const locked = await stateOf();

  expect(bootstrapped?.fingerprint).toBe(locked?.fingerprint ?? null);
  // A recorded link is a change the fingerprint covers.
  expect(bootstrapped?.fingerprint).not.toBe(withoutLinks?.fingerprint);
});
