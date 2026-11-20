import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  assignDecisionCourtIdsTx,
  writeDecisionCourtIdentityTx,
} from "@/api/lib/case-law/decision-court-assignment";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { bootstrapCorpusProjectionDesiredStateBatchTx } from "@/api/lib/legal-search/corpus-index-projection-bootstrap";
import {
  advanceCorpusProjectionDesiredStateTx,
  CorpusIndexProjectionSubjectMissingError,
  lockActiveCorpusProjectionSourceTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { readReservedCorpusProjectionMaterialsTx } from "@/api/lib/legal-search/corpus-index-projection-materials";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const FIXTURES = [
  {
    country: "SVK",
    language: "sk",
    court: "Najvyšší súd Slovenskej republiky",
    courtId: "NSSR",
  },
  { country: "CZE", language: "cs", court: "Nejvyšší soud", courtId: "NS" },
].map((fixture) => ({
  ...fixture,
  sourceId: createSafeId<"caseLawSource">(),
  decisionId: createSafeId<"caseLawDecision">(),
}));
const GENERATIONS = ["case_law_v10", "case_law_v11"] as const;
const STORED_AT = new Date("2026-01-01T00:00:00Z");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const inTx = async <T>(run: (tx: Transaction) => Promise<T>) =>
  await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));

// timeout: the isolated PGlite fixture installs the complete schema before seeding.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values(
    FIXTURES.map(({ sourceId, country }) => ({
      id: sourceId,
      adapterKey: `court-assignment-${country}`,
      name: country,
    })),
  );
  await db.insert(caseLawDecisions).values(
    FIXTURES.map(({ sourceId, decisionId, country, language, court }) => ({
      id: decisionId,
      sourceId,
      country,
      language,
      court,
      caseNumber: "1 C 1/2020",
      contentHash: "a".repeat(64),
      textS3Key: "fixture/text.zst",
      astS3Key: null,
      updatedAt: STORED_AT,
    })),
  );
  await db.insert(corpusIndexGenerations).values(
    GENERATIONS.map((generation) => ({
      family: "case_law" as const,
      generation,
      cluster: "q09" as const,
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[generation],
      ),
      status:
        generation === "case_law_v10"
          ? ("serving" as const)
          : ("building" as const),
    })),
  );
  for (const generation of GENERATIONS) {
    // db-await-in-loop: seed each active generation through its production owner.
    await inTx(
      async (tx) =>
        await bootstrapCorpusProjectionDesiredStateBatchTx(tx, {
          family: "case_law",
          generation,
          limit: 10,
        }),
    );
  }
}, 120_000);

afterAll(async () => {
  await client.close();
});

test.each(FIXTURES)(
  "court ID assignment keeps $country seeded materials current across active generations and replay",
  async (fixture) => {
    const states = async () =>
      await db
        .select()
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, fixture.decisionId))
        .orderBy(asc(corpusIndexProjectionStates.generation));
    const before = await states();
    expect(before.map(({ generation }) => generation)).toEqual([
      ...GENERATIONS,
    ]);
    const assignments = [
      {
        decisionId: fixture.decisionId,
        court: fixture.court,
        courtId: fixture.courtId,
      },
    ];
    const storedBefore = await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fixture.decisionId));
    expect(
      await rejectionOf(
        inTx(async (tx) => {
          await assignDecisionCourtIdsTx(tx, {
            sourceId: fixture.sourceId,
            assignments,
          });
          return panic("Abort the court assignment transaction");
        }),
      ),
    ).toMatchObject({ message: "Abort the court assignment transaction" });
    expect(await states()).toEqual(before);
    expect(
      await db
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, fixture.decisionId)),
    ).toEqual(storedBefore);
    expect(
      await inTx(
        async (tx) =>
          await assignDecisionCourtIdsTx(tx, {
            sourceId: fixture.sourceId,
            assignments,
          }),
      ),
    ).toEqual([fixture.decisionId]);
    const after = await states();
    expect(after.map(({ desiredEpoch }) => desiredEpoch)).toEqual(
      before.map(({ desiredEpoch }) => desiredEpoch + 1n),
    );
    expect(
      after.map(({ desiredFingerprint }) => desiredFingerprint),
    ).not.toEqual(before.map(({ desiredFingerprint }) => desiredFingerprint));
    for (const state of after) {
      const fingerprint =
        state.desiredFingerprint ?? panic("Expected an upsert fingerprint");
      const indexId = state.desiredIndexId ?? panic("Expected an upsert index");
      const intentId = createSafeId<"corpusIndexProjectionIntent">();
      const leaseToken = createSafeId<"corpusIndexProjectionIntent">();
      const leaseExpiresAt = new Date("2100-01-01T00:00:00Z");
      const lease = {
        intentId,
        family: "case_law",
        generation: state.generation,
        entityId: fixture.decisionId,
        epoch: state.desiredEpoch,
        fingerprint,
        indexId,
        leaseToken,
        leaseExpiresAt,
        appendMode: "batchable",
      } as const;
      // db-await-in-loop: each material read names one generation's exact reservation.
      await db.insert(corpusIndexProjectionIntents).values({
        id: intentId,
        family: lease.family,
        generation: lease.generation,
        entityId: lease.entityId,
        epoch: lease.epoch,
        fingerprint,
        indexId,
        status: "reserved",
        leaseToken,
        leaseExpiresAt,
      });
      // db-await-in-loop: check the production material postfilter for every generation.
      const materials = await inTx(
        async (tx) =>
          await readReservedCorpusProjectionMaterialsTx(tx, {
            leases: [lease],
          }),
      );
      expect(materials.rejected).toEqual([]);
      expect(materials.ready).toHaveLength(1);
      expect(materials.ready.at(0)?.input).toMatchObject({
        courtId: fixture.courtId,
      });
    }
    const stored = await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fixture.decisionId));
    expect(stored.at(0)?.updatedAt).toEqual(STORED_AT);
    expect(
      await inTx(
        async (tx) =>
          await assignDecisionCourtIdsTx(tx, {
            sourceId: fixture.sourceId,
            assignments,
          }),
      ),
    ).toEqual([]);
    expect(await states()).toEqual(after);
    expect(
      await db
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, fixture.decisionId)),
    ).toEqual(stored);
  },
);

test("court ID assignment refuses a changed printed court and another source", async () => {
  const first = FIXTURES.at(0) ?? panic("Missing fixture");
  const other = FIXTURES.at(1) ?? panic("Missing source fixture");
  const id = createSafeId<"caseLawDecision">();
  await inTx(async (tx) => {
    await tx.insert(caseLawDecisions).values({
      id,
      sourceId: first.sourceId,
      country: first.country,
      language: first.language,
      court: first.court,
      caseNumber: "2 C 2/2020",
    });
    await advanceCorpusProjectionDesiredStateTx(tx, {
      family: "case_law",
      entityId: id,
    });
  });
  expect(
    await inTx(
      async (tx) =>
        await assignDecisionCourtIdsTx(tx, {
          sourceId: first.sourceId,
          assignments: [
            {
              decisionId: id,
              court: "Different court",
              courtId: first.courtId,
            },
          ],
        }),
    ),
  ).toEqual([]);
  expect(
    await inTx(
      async (tx) =>
        await assignDecisionCourtIdsTx(tx, {
          sourceId: other.sourceId,
          assignments: [
            { decisionId: id, court: first.court, courtId: first.courtId },
          ],
        }),
    ),
  ).toEqual([]);
  await db
    .update(caseLawDecisions)
    .set({ sourceId: other.sourceId })
    .where(eq(caseLawDecisions.id, id));
  expect(
    await inTx(
      async (tx) =>
        await assignDecisionCourtIdsTx(tx, {
          sourceId: first.sourceId,
          assignments: [
            { decisionId: id, court: first.court, courtId: first.courtId },
          ],
        }),
    ),
  ).toEqual([]);
  expect(
    (
      await db
        .select({ courtId: caseLawDecisions.courtId })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.id, id),
            eq(caseLawDecisions.sourceId, other.sourceId),
          ),
        )
    ).at(0)?.courtId,
  ).toBeNull();
});

test("a missing decision is unchanged without invoking its court identity write", async () => {
  const decisionId = createSafeId<"caseLawDecision">();
  expect(
    await rejectionOf(
      inTx(
        async (tx) =>
          await lockActiveCorpusProjectionSourceTx(tx, {
            family: "case_law",
            entityId: decisionId,
          }),
      ),
    ),
  ).toBeInstanceOf(CorpusIndexProjectionSubjectMissingError);
  let writes = 0;
  expect(
    await inTx(
      async (tx) =>
        await writeDecisionCourtIdentityTx(tx, {
          decisionId,
          write: async () => {
            writes += 1;
            return true;
          },
        }),
    ),
  ).toBe(false);
  expect(writes).toBe(0);
});

test("clearing a court ID reconciles every active generation and remains replayable", async () => {
  const base = FIXTURES.at(0) ?? panic("Missing source fixture");
  const fixture = { ...base, decisionId: createSafeId<"caseLawDecision">() };
  await inTx(async (tx) => {
    await tx.insert(caseLawDecisions).values({
      id: fixture.decisionId,
      sourceId: fixture.sourceId,
      country: fixture.country,
      language: fixture.language,
      court: fixture.court,
      courtId: fixture.courtId,
      caseNumber: "3 C 3/2020",
      contentHash: "a".repeat(64),
      textS3Key: "fixture/clear-court-id.zst",
      updatedAt: STORED_AT,
    });
    await advanceCorpusProjectionDesiredStateTx(tx, {
      family: "case_law",
      entityId: fixture.decisionId,
    });
  });
  const states = async () =>
    await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, fixture.decisionId))
      .orderBy(asc(corpusIndexProjectionStates.generation));
  const before = await states();
  const clear = async () =>
    await inTx(
      async (tx) =>
        await writeDecisionCourtIdentityTx(tx, {
          decisionId: fixture.decisionId,
          write: async (writer) =>
            (
              await writer
                .update(caseLawDecisions)
                .set({ courtId: null, updatedAt: caseLawDecisions.updatedAt })
                .where(
                  and(
                    eq(caseLawDecisions.id, fixture.decisionId),
                    eq(caseLawDecisions.courtId, fixture.courtId),
                  ),
                )
                .returning({ id: caseLawDecisions.id })
            ).length > 0,
        }),
    );
  expect(await clear()).toBe(true);
  const after = await states();
  expect(after.map(({ desiredEpoch }) => desiredEpoch)).toEqual(
    before.map(({ desiredEpoch }) => desiredEpoch + 1n),
  );
  expect(after.map(({ desiredFingerprint }) => desiredFingerprint)).not.toEqual(
    before.map(({ desiredFingerprint }) => desiredFingerprint),
  );
  expect(await clear()).toBe(false);
  expect(await states()).toEqual(after);
  expect(
    (
      await db
        .select({
          courtId: caseLawDecisions.courtId,
          updatedAt: caseLawDecisions.updatedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, fixture.decisionId))
    ).at(0),
  ).toEqual({ courtId: null, updatedAt: STORED_AT });
});
