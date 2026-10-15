/**
 * The gated flip of Czech decisions to the group built beside the serving one,
 * against a real PostgreSQL registry with the search engine replaced by a
 * fake: what is owed to both indexes while v9 builds, that nothing short of
 * the flip moves a reader (attestation included), what the flip refuses, what
 * it moves, and how the old copies are scheduled for erasure afterwards.
 */
import { Result } from "better-result";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexJurisdictionServing,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { currentCaseLawCorpusProjection } from "@/api/lib/legal-search/case-law-corpus-projection";
import {
  flipCaseLawJurisdictionServing,
  purgeFlippedJurisdictionBatchTx,
  type CaseLawServingFlipContext,
  type CaseLawServingFlipOptions,
} from "@/api/lib/legal-search/case-law-serving-flip";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { resolveCorpusIndexGroupContract } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  attestCorpusIndexGroupEnrollmentTx,
  bindCorpusIndexGroupEnrollmentTx,
  readServingCorpusIndexTargetTx,
} from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  advanceCorpusProjectionDesiredStateTx,
  ensureCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const V8 = CORPUS_INDEX_MANIFESTS.case_law_v8;
const V9 = CORPUS_INDEX_MANIFESTS.case_law_v9;
const CZE = { manifest: V9, indexGroup: "cze" } as const;
const CZE_CONTRACT = resolveCorpusIndexGroupContract(CZE);
const CZE_DIGEST =
  CZE_CONTRACT.type === "provision_keys_v1"
    ? CZE_CONTRACT.effectiveDigest
    : "cze is not under its own contract";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000501",
);
const CZE_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000502",
);
const SVK_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000503",
);
const V9_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000509",
);
const NOW = new Date("2026-08-26T00:00:00.000Z");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let seededSnapshot: Blob;

const inTx = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));

beforeAll(async () => {
  await using template = await createTestPglite();
  const templateDb = drizzle({ client: template });
  await templateDb.insert(corpusIndexGenerations).values([
    {
      family: "case_law",
      generation: V8.generation,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(V8),
      status: "serving",
    },
    {
      family: "case_law",
      generation: V9.generation,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(V9),
      status: "building",
    },
  ]);
  seededSnapshot = await template.dumpDataDir();
});

beforeEach(async () => {
  client = await createTestPglite(seededSnapshot);
  db = drizzle({ client });
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "serving-flip",
    name: "Serving flip",
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
      id: SVK_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "1 Sžo 3/2008",
      court: "Najvyšší súd Slovenskej republiky",
      country: "SVK",
      language: "sk",
      contentHash: "b".repeat(64),
    },
  ]);
});

afterEach(async () => {
  await client.close();
});

const advance = async (entityId: typeof CZE_DECISION_ID) =>
  await inTx(
    async (tx) =>
      await advanceCorpusProjectionDesiredStateTx(tx, {
        family: "case_law",
        entityId,
      }),
  );

const statesOf = async (entityId: typeof CZE_DECISION_ID) =>
  await db
    .select({
      generation: corpusIndexProjectionStates.generation,
      desiredAction: corpusIndexProjectionStates.desiredAction,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
      desiredFingerprint: corpusIndexProjectionStates.desiredFingerprint,
      desiredIndexId: corpusIndexProjectionStates.desiredIndexId,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, entityId))
    .orderBy(corpusIndexProjectionStates.generation);

/** The projection has applied a generation's copy of the decision. */
const applyDesired = async (
  generation: string,
  entityId: typeof CZE_DECISION_ID,
  revision: ReturnType<typeof toSafeId<"corpusIndexProjectionIntent">>,
) => {
  const [state] = await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, entityId),
      ),
    );
  if (
    state?.desiredFingerprint === undefined ||
    state.desiredFingerprint === null ||
    state.desiredIndexId === null
  ) {
    throw new Error("the generation owes this decision no copy");
  }
  await db.insert(corpusIndexProjectionIntents).values({
    id: revision,
    family: "case_law",
    generation,
    entityId,
    epoch: state.desiredEpoch,
    fingerprint: state.desiredFingerprint,
    indexId: state.desiredIndexId,
    status: "applied",
    appendStartedAt: NOW,
    appendCommittedAt: NOW,
    expectedDocumentCount: 1,
    appliedAt: NOW,
  });
  await db
    .update(corpusIndexProjectionStates)
    .set({
      appliedAction: "upsert",
      appliedEpoch: state.desiredEpoch,
      appliedRevision: revision,
      appliedFingerprint: state.desiredFingerprint,
      appliedIndexId: state.desiredIndexId,
      appliedAt: NOW,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, entityId),
      ),
    );
  return state.desiredIndexId;
};

const attestCze = async () => {
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, CZE));
  await inTx(
    async (tx) =>
      await attestCorpusIndexGroupEnrollmentTx(tx, {
        ...CZE,
        effectiveDigest: CZE_DIGEST,
      }),
  );
};

const read = async (jurisdiction: string | undefined) => {
  const served = await inTx(
    async (tx) =>
      await readServingCorpusIndexTargetTx(tx, {
        family: "case_law",
        jurisdiction,
      }),
  );
  if (served.isErr()) {
    throw new Error(`refused: ${served.error.message}`);
  }
  return served.value;
};

const acceptedBy = async (generation: string) =>
  (
    await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(currentCaseLawCorpusProjection(generation))
  )
    .map(({ id }) => id)
    .toSorted();

type Engine = {
  documents: Map<string, number>;
  revisions: Map<string, Map<string, number>>;
};

const PROJECTION_REVISION_TERM = /projection_revision:"(?<revision>[^"]+)"/gu;

const flipContext = (engine: Engine): CaseLawServingFlipContext => ({
  readTransaction: inTx,
  writeTransaction: inTx,
  indexClient: () => ({
    aggregate: async ({ indexId, query }) =>
      Result.ok({
        projection_revisions: {
          buckets: [...query.matchAll(PROJECTION_REVISION_TERM)].flatMap(
            ({ groups }) => {
              const revision = groups?.["revision"];
              const count =
                revision === undefined
                  ? undefined
                  : engine.revisions.get(indexId)?.get(revision);
              return count === undefined
                ? []
                : [{ key: revision, doc_count: count }];
            },
          ),
          doc_count_error_upper_bound: 0,
          sum_other_doc_count: 0,
        },
      }),
    search: async ({ indexId }) => {
      const documents = engine.documents.get(indexId);
      return documents === undefined
        ? Result.err(
            new CorpusIndexError({
              message: `index ${indexId} not found`,
              status: 404,
            }),
          )
        : Result.ok({ numHits: documents, hits: [], snippets: [] });
    },
  }),
});

const flip = async (
  engine: Engine,
  mode: CaseLawServingFlipOptions["mode"] = "apply",
  generation: string = V9.generation,
) =>
  await flipCaseLawJurisdictionServing(flipContext(engine), {
    jurisdiction: "CZE",
    generation,
    mode,
  });

const pointerRows = async () =>
  await db.select().from(corpusIndexJurisdictionServing);

/** v9 holds a converged, published copy of the Czech decision. */
const buildV9 = async (): Promise<Engine> => {
  await advance(CZE_DECISION_ID);
  await advance(SVK_DECISION_ID);
  const indexId = await applyDesired(
    "case_law_v9",
    CZE_DECISION_ID,
    V9_REVISION,
  );
  await attestCze();
  return {
    documents: new Map([[indexId, 1]]),
    revisions: new Map([[indexId, new Map([[V9_REVISION, 1]])]]),
  };
};

test("a Czech decision is owed both indexes while v9 builds, and a Slovak one only the serving one", async () => {
  await advance(CZE_DECISION_ID);
  await advance(SVK_DECISION_ID);
  const cze = await statesOf(CZE_DECISION_ID);
  expect(
    cze.map(({ generation, desiredIndexId }) => [generation, desiredIndexId]),
  ).toEqual([
    ["case_law_v8", "case_law_v8_cs_sk"],
    ["case_law_v9", "case_law_v9_cze"],
  ]);
  expect(cze.every(({ desiredAction }) => desiredAction === "upsert")).toBe(
    true,
  );
  // One canonical epoch, two owed copies with their own fingerprints.
  expect(new Set(cze.map(({ desiredEpoch }) => desiredEpoch)).size).toBe(1);
  expect(
    new Set(cze.map(({ desiredFingerprint }) => desiredFingerprint)).size,
  ).toBe(2);
  // The partial generation owes a jurisdiction it does not hold nothing.
  expect(
    (await statesOf(SVK_DECISION_ID)).map(({ generation }) => generation),
  ).toEqual(["case_law_v8"]);
});

test("cze attested and empty: Czech reads are still served by cs_sk", async () => {
  await advance(CZE_DECISION_ID);
  const before = {
    scoped: await read("CZE"),
    global: await read(undefined),
  };
  await attestCze();
  const after = {
    scoped: await read("CZE"),
    global: await read(undefined),
  };
  // Attestation admits appends into the building group and nothing else.
  expect(after.scoped.serving.generation).toBe("case_law_v8");
  expect(after.scoped.route).toEqual({
    indexId: "case_law_v8_cs_sk",
    jurisdictionClause: "CZE",
  });
  expect(after.scoped.route).toEqual(before.scoped.route);
  expect(after.global.route).toEqual(before.global.route);
  expect(after.global.cursorTarget).toBe(before.global.cursorTarget);
  expect(after.global.route.indexId).not.toContain("case_law_v9");
  expect(await pointerRows()).toEqual([]);
});

test("reads during the build serve cs_sk and the SQL acceptance follows the same pointer", async () => {
  await buildV9();
  await applyDesired(
    "case_law_v8",
    CZE_DECISION_ID,
    toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-000000000508",
    ),
  );
  expect((await read("CZE")).route.indexId).toBe("case_law_v8_cs_sk");
  expect((await read("CZE")).serving.generation).toBe("case_law_v8");
  // The serving generation's copy is accepted, the building one's is not asked.
  expect(await acceptedBy("case_law_v8")).toEqual([CZE_DECISION_ID]);
});

test("the flip is refused while the group is not attested, not complete, or not converged", async () => {
  const engine = await buildV9();
  // Not attested.
  await db.execute(sql`UPDATE corpus_index_group_enrollments
    SET provisioning_status = 'pending', attested_at = NULL`);
  expect((await flip(engine)).isErr()).toBe(true);
  expect(
    (await flip(engine)).match({
      ok: () => "ok",
      err: (error) => error._tag,
    }),
  ).toBe("CaseLawServingFlipNotAttestedError");
  await db.execute(sql`UPDATE corpus_index_group_enrollments
    SET provisioning_status = 'attested', attested_at = now()`);

  // Not complete: a decision of the jurisdiction v9 was never seeded with.
  await db
    .delete(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, "case_law_v9"),
        eq(corpusIndexProjectionStates.entityId, CZE_DECISION_ID),
      ),
    );
  expect(
    (await flip(engine)).match({ ok: () => "ok", err: (error) => error._tag }),
  ).toBe("CaseLawServingFlipIncompleteError");

  // Seeded but pending: nothing applied yet.
  await advance(CZE_DECISION_ID);
  expect(
    (await flip(engine)).match({ ok: () => "ok", err: (error) => error._tag }),
  ).toBe("CorpusGenerationNotConvergedError");
  expect(await pointerRows()).toEqual([]);
  expect((await read("CZE")).route.indexId).toBe("case_law_v8_cs_sk");
});

test("the flip is refused for an index the engine does not hold or one that drifted", async () => {
  const engine = await buildV9();
  const missing = { ...engine, documents: new Map<string, number>() };
  expect(
    (await flip(missing)).match({ ok: () => "ok", err: (error) => error._tag }),
  ).toBe("CorpusGenerationIndexMissingError");
  const empty = {
    ...engine,
    documents: new Map([["case_law_v9_cze", 0]]),
  };
  expect(
    (await flip(empty)).match({ ok: () => "ok", err: (error) => error._tag }),
  ).toBe("CorpusGenerationIndexEmptyError");
  const drifted = {
    ...engine,
    revisions: new Map<string, Map<string, number>>(),
  };
  expect(
    (await flip(drifted)).match({
      ok: () => "ok",
      err: (error) => error._tag,
    }),
  ).toBe("CorpusGenerationCensusDriftError");
  expect(await pointerRows()).toEqual([]);
});

test("only a partial generation that holds the jurisdiction can be flipped to", async () => {
  const engine = await buildV9();
  expect(
    (await flip(engine, "apply", "case_law_v8")).match({
      ok: () => "ok",
      err: (error) => error._tag,
    }),
  ).toBe("CaseLawServingFlipUndeclaredError");
  expect(
    (
      await flipCaseLawJurisdictionServing(flipContext(engine), {
        jurisdiction: "SVK",
        generation: V9.generation,
        mode: "apply",
      })
    ).match({ ok: () => "ok", err: (error) => error._tag }),
  ).toBe("CaseLawServingFlipUndeclaredError");
});

test("a dry run proves the gates and writes nothing", async () => {
  const engine = await buildV9();
  const proven = await flip(engine, "dry_run");
  expect(proven.isOk() ? proven.value.type : proven.error._tag).toBe("proven");
  expect(await pointerRows()).toEqual([]);
  expect((await read("CZE")).route.indexId).toBe("case_law_v8_cs_sk");
});

test("the flipping transaction holds the attestations it checked until the pointer commits", async () => {
  const engine = await buildV9();
  await applyDesired(
    "case_law_v8",
    CZE_DECISION_ID,
    toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-0000000005f1",
    ),
  );
  const writes: string[] = [];
  const loggingDb = drizzle({
    client,
    logger: {
      logQuery: (query) => {
        writes.push(query);
      },
    },
  });
  const flipped = await flipCaseLawJurisdictionServing(
    {
      ...flipContext(engine),
      writeTransaction: async (run) =>
        await loggingDb.transaction(
          async (tx) => await run(asTestRaw<Transaction>(tx)),
        ),
    },
    { jurisdiction: "CZE", generation: V9.generation, mode: "apply" },
  );
  expect(flipped.isOk() ? flipped.value.type : flipped.error._tag).toBe(
    "flipped",
  );
  // A withdrawal of an attestation the flip checked waits for its commit.
  expect(
    writes.some(
      (query) =>
        query.includes("corpus_index_group_enrollments") &&
        /for share/iu.test(query),
    ),
  ).toBe(true);
});

test("the flip moves Czech readers and the acceptance to v9, and only the flip does", async () => {
  const engine = await buildV9();
  await applyDesired(
    "case_law_v8",
    CZE_DECISION_ID,
    toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-000000000508",
    ),
  );
  const beforeGlobal = await read(undefined);
  expect(await acceptedBy("case_law_v8")).toEqual([CZE_DECISION_ID]);

  const flipped = await flip(engine);
  expect(flipped.isOk() ? flipped.value.type : flipped.error._tag).toBe(
    "flipped",
  );
  expect(await pointerRows()).toMatchObject([
    { family: "case_law", jurisdiction: "CZE", generation: "case_law_v9" },
  ]);

  // Scoped: read through v9, from its own index, with its contract.
  const scoped = await read("CZE");
  expect(scoped.serving.generation).toBe("case_law_v9");
  expect(scoped.route).toEqual({
    indexId: "case_law_v9_cze",
    jurisdictionClause: undefined,
  });
  expect(scoped.contract?.type).toBe("provision_keys_v1");
  // Other jurisdictions are still read from the serving generation.
  expect((await read("SVK")).serving.generation).toBe("case_law_v8");
  expect((await read("SVK")).route.indexId).toBe("case_law_v8_cs_sk");
  // Generation-wide: the serving generation's indexes plus v9's, under a
  // cursor identity that a cursor minted before the flip does not match.
  const global = await read(undefined);
  expect(global.route.indexId).toBe(
    `${beforeGlobal.route.indexId},case_law_v9_cze`,
  );
  expect(global.cursorTarget).not.toBe(beforeGlobal.cursorTarget);
  expect(global.serving.generation).toBe("case_law_v8");

  // The acceptance follows the pointer: v9's applied copy is the current one.
  expect(await acceptedBy("case_law_v8")).toEqual([CZE_DECISION_ID]);
  await db
    .update(corpusIndexProjectionStates)
    .set({ desiredEpoch: sql`${corpusIndexProjectionStates.desiredEpoch} + 1` })
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, "case_law_v9"),
        eq(corpusIndexProjectionStates.entityId, CZE_DECISION_ID),
      ),
    );
  expect(await acceptedBy("case_law_v8")).toEqual([]);

  // Replays converge.
  const again = await flip(engine);
  expect(again.isOk() ? again.value.type : again.error._tag).toBe(
    "already_flipped",
  );
});

test("after the flip the old copies are scheduled for erasure and the new ones are untouched", async () => {
  const engine = await buildV9();
  await applyDesired(
    "case_law_v8",
    CZE_DECISION_ID,
    toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-000000000508",
    ),
  );
  // Nothing may be purged from a generation that still serves the jurisdiction.
  expect(
    String(
      await rejectionOf(
        inTx(
          async (tx) =>
            await purgeFlippedJurisdictionBatchTx(tx, {
              jurisdiction: "CZE",
              fromGeneration: "case_law_v8",
              afterEntityId: null,
              limit: 10,
            }),
        ),
      ),
    ),
  ).toContain("nothing may be purged");

  await flip(engine);
  const [epochBefore] = await db
    .select({ epoch: caseLawDecisions.projectionEpoch })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, CZE_DECISION_ID));
  const before = await statesOf(CZE_DECISION_ID);
  const batch = await inTx(
    async (tx) =>
      await purgeFlippedJurisdictionBatchTx(tx, {
        jurisdiction: "CZE",
        fromGeneration: "case_law_v8",
        afterEntityId: null,
        limit: 10,
      }),
  );
  expect(batch).toEqual({
    inspected: 1,
    scheduled: 1,
    nextAfterEntityId: null,
  });
  const after = await statesOf(CZE_DECISION_ID);
  const byGeneration = (rows: typeof after, generation: string) =>
    rows.find((row) => row.generation === generation);
  // v8 owes the erasure; the epoch is not bumped, so v9 re-projects nothing.
  expect(byGeneration(after, "case_law_v8")).toMatchObject({
    desiredAction: "erase",
    desiredFingerprint: null,
    desiredIndexId: null,
  });
  expect(byGeneration(after, "case_law_v9")).toEqual(
    byGeneration(before, "case_law_v9"),
  );
  const [epochAfter] = await db
    .select({ epoch: caseLawDecisions.projectionEpoch })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, CZE_DECISION_ID));
  expect(epochAfter?.epoch).toBe(epochBefore?.epoch);
  // A second pass changes nothing, and a Slovak decision is never touched.
  const replay = await inTx(
    async (tx) =>
      await purgeFlippedJurisdictionBatchTx(tx, {
        jurisdiction: "CZE",
        fromGeneration: "case_law_v8",
        afterEntityId: null,
        limit: 10,
      }),
  );
  expect(replay.scheduled).toBe(0);
  expect(
    (await statesOf(SVK_DECISION_ID)).map(({ desiredAction }) => desiredAction),
  ).toEqual(["upsert"]);

  // A later canonical mutation derives the same owed state.
  await advance(CZE_DECISION_ID);
  const rederived = await statesOf(CZE_DECISION_ID);
  expect(byGeneration(rederived, "case_law_v8")?.desiredAction).toBe("erase");
  expect(byGeneration(rederived, "case_law_v9")?.desiredAction).toBe("upsert");
});

test("a partial generation never serves a family, and promoting a whole one clears the pointer", async () => {
  const engine = await buildV9();
  await flip(engine);
  expect(await pointerRows()).toHaveLength(1);
  const { setServingCorpusIndexGenerationTx } =
    await import("@/api/lib/legal-search/corpus-index-generation-store");
  expect(
    String(
      await rejectionOf(
        inTx(
          async (tx) =>
            await setServingCorpusIndexGenerationTx(tx, {
              family: "case_law",
              generation: "case_law_v9",
            }),
        ),
      ),
    ),
  ).toContain("partial corpus generation cannot serve");
  expect(await pointerRows()).toHaveLength(1);

  // A whole generation holds the jurisdiction itself once it serves.
  const V7 = CORPUS_INDEX_MANIFESTS.case_law_v7;
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: V7.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(V7),
    status: "building",
  });
  await inTx(
    async (tx) =>
      await setServingCorpusIndexGenerationTx(tx, {
        family: "case_law",
        generation: V7.generation,
      }),
  );
  expect(await pointerRows()).toEqual([]);
});

test("a whole generation built while the pointer is set projects the Czech decisions, and Czech search is complete once its promotion clears the pointer", async () => {
  const engine = await buildV9();
  await flip(engine);
  expect(await pointerRows()).toMatchObject([
    {
      jurisdiction: "CZE",
      generation: "case_law_v9",
      fromGeneration: "case_law_v8",
    },
  ]);

  // v7 stands for any whole generation built for promotion: the pointer
  // vacated v8 only, so v7 is owed the Czech decision like any other.
  const V7 = CORPUS_INDEX_MANIFESTS.case_law_v7;
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: V7.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(V7),
    status: "building",
  });
  await inTx(
    async (tx) =>
      await ensureCorpusProjectionDesiredStateTx(
        tx,
        { family: "case_law", entityId: CZE_DECISION_ID },
        V7.generation,
      ),
  );
  const wholeState = (await statesOf(CZE_DECISION_ID)).find(
    ({ generation }) => generation === V7.generation,
  );
  expect(wholeState).toMatchObject({
    desiredAction: "upsert",
    desiredIndexId: "case_law_v7_cs_sk",
  });
  // The vacated generation is the one that erases.
  await inTx(
    async (tx) =>
      await purgeFlippedJurisdictionBatchTx(tx, {
        jurisdiction: "CZE",
        fromGeneration: "case_law_v8",
        afterEntityId: null,
        limit: 10,
      }),
  );
  const states = await statesOf(CZE_DECISION_ID);
  expect(
    states.map(({ generation, desiredAction }) => [generation, desiredAction]),
  ).toEqual([
    ["case_law_v7", "upsert"],
    ["case_law_v8", "erase"],
    ["case_law_v9", "upsert"],
  ]);

  // The projection applies it, the promotion clears the pointer, and the
  // decision is found: nothing the promotion relies on was erased.
  await applyDesired(
    "case_law_v7",
    CZE_DECISION_ID,
    toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-00000000050a",
    ),
  );
  const { setServingCorpusIndexGenerationTx } =
    await import("@/api/lib/legal-search/corpus-index-generation-store");
  await inTx(
    async (tx) =>
      await setServingCorpusIndexGenerationTx(tx, {
        family: "case_law",
        generation: V7.generation,
      }),
  );
  expect(await pointerRows()).toEqual([]);
  expect(await acceptedBy("case_law_v7")).toEqual([CZE_DECISION_ID]);
  const search = await read("CZE");
  expect(search.serving.generation).toBe("case_law_v7");
  expect(search.route.indexId).toBe("case_law_v7_cs_sk");
});

test("a decision corrected out of the partial generation's scope owes it an erasure, and back into it an upsert", async () => {
  await advance(CZE_DECISION_ID);
  await advance(SVK_DECISION_ID);
  await applyDesired("case_law_v9", CZE_DECISION_ID, V9_REVISION);
  const byGeneration = async (id: typeof CZE_DECISION_ID) =>
    Object.fromEntries(
      (await statesOf(id)).map((row) => [row.generation, row]),
    );
  const setCountry = async (id: typeof CZE_DECISION_ID, country: string) =>
    await db
      .update(caseLawDecisions)
      .set({ country })
      .where(eq(caseLawDecisions.id, id));

  // Czech to Polish, through the canonical mutation path.
  await setCountry(CZE_DECISION_ID, "POL");
  await advance(CZE_DECISION_ID);
  const polish = await byGeneration(CZE_DECISION_ID);
  // The serving generation routes it to its Polish index; the partial
  // generation, which no longer covers it, owes its existing copy an erasure.
  expect(polish["case_law_v8"]).toMatchObject({
    desiredAction: "upsert",
    desiredIndexId: "case_law_v8_pol",
  });
  expect(polish["case_law_v9"]).toMatchObject({
    desiredAction: "erase",
    desiredFingerprint: null,
    desiredIndexId: null,
  });

  // A decision that was never in scope gets no row in the partial generation.
  await setCountry(SVK_DECISION_ID, "POL");
  await advance(SVK_DECISION_ID);
  expect(Object.keys(await byGeneration(SVK_DECISION_ID))).toEqual([
    "case_law_v8",
  ]);

  // Polish back to Czech: the partial generation owes the decision again.
  await setCountry(CZE_DECISION_ID, "CZE");
  await advance(CZE_DECISION_ID);
  const czech = await byGeneration(CZE_DECISION_ID);
  expect(czech["case_law_v8"]).toMatchObject({
    desiredAction: "upsert",
    desiredIndexId: "case_law_v8_cs_sk",
  });
  expect(czech["case_law_v9"]).toMatchObject({
    desiredAction: "upsert",
    desiredIndexId: "case_law_v9_cze",
  });
});
