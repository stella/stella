/**
 * The gated flip of Czech decisions to the group built beside the serving one,
 * against a real PostgreSQL registry with the search engine replaced by a
 * fake: what is owed to both indexes while v9 builds, that nothing short of
 * the flip moves a reader (attestation included), what the flip refuses, what
 * it moves, and how the old copies are scheduled for erasure afterwards.
 */
import { Result } from "better-result";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { getCollator } from "@stll/collation";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexJurisdictionServing,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  caseLawAppliedProjections,
  caseLawCorpusAppliedRevision,
  caseLawCorpusServingGeneration,
  currentCaseLawCorpusProjection,
} from "@/api/lib/legal-search/case-law-corpus-projection";
import {
  type CaseLawServingFlipContext,
  type CaseLawServingFlipOptions,
  flipCaseLawJurisdictionServing,
  purgeFlippedJurisdictionBatchTx,
} from "@/api/lib/legal-search/case-law-serving-flip";
import { createCorpusHitDispositionCounter } from "@/api/lib/legal-search/corpus-hit-telemetry";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { PROJECTION_GENERATION_FIELD } from "@/api/lib/legal-search/corpus-index-config";
import { corpusIndexBrowseFacets } from "@/api/lib/legal-search/corpus-index-facets";
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
  corpusIndexLexicalScore,
  readCorpusIndexSearchPage,
} from "@/api/lib/legal-search/corpus-index-pagination";
import {
  advanceCorpusProjectionDesiredStateTx,
  ensureCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { CORPUS_BM25_RATIO_POWER } from "@/api/lib/legal-search/corpus-ranking-policy";
import { RELEVANCE_ORDER } from "@/api/lib/legal-search/corpus-search-order";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const testFetchState = createTestFetch();

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
const originalFetch = globalThis.fetch;
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
  testFetchState.restore();
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
      .select({ id: publishedCaseLawDecisions.id })
      .from(publishedCaseLawDecisions)
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

test("the corpus country guard refuses lower-case inserts and updates", async () => {
  const lowerCaseId = toSafeId<"caseLawDecision">(
    "0198e331-e578-7000-8000-0000000005f2",
  );
  const insertError = await rejectionOf(
    db.insert(caseLawDecisions).values({
      id: lowerCaseId,
      sourceId: SOURCE_ID,
      caseNumber: "5 As 4/2008",
      court: "Nejvyšší správní soud",
      country: "cze",
      language: "cs",
      contentHash: "c".repeat(64),
    }),
  );
  expect(insertError).toMatchObject({
    cause: {
      code: "23514",
      constraint: "case_law_decisions_corpus_country_shape",
    },
  });
  const updateError = await rejectionOf(
    db
      .update(caseLawDecisions)
      .set({ country: "cze" })
      .where(eq(caseLawDecisions.id, CZE_DECISION_ID)),
  );
  expect(updateError).toMatchObject({
    cause: {
      code: "23514",
      constraint: "case_law_decisions_corpus_country_shape",
    },
  });
  const rows = await db
    .select({ country: caseLawDecisions.country })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, CZE_DECISION_ID));
  expect(rows).toEqual([{ country: "CZE" }]);
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
  const appliedStates = await db
    .select({
      generation: corpusIndexProjectionStates.generation,
      revision: corpusIndexProjectionStates.appliedRevision,
      indexId: corpusIndexProjectionStates.appliedIndexId,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, CZE_DECISION_ID))
    .orderBy(corpusIndexProjectionStates.generation);
  expect(appliedStates).toEqual([
    {
      generation: "case_law_v8",
      revision: toSafeId<"corpusIndexProjectionIntent">(
        "0198e331-e578-7000-8000-000000000508",
      ),
      indexId: "case_law_v8_cs_sk",
    },
    {
      generation: "case_law_v9",
      revision: V9_REVISION,
      indexId: "case_law_v9_cze",
    },
  ]);
  const acceptedRevision = await db
    .select({ revision: caseLawCorpusAppliedRevision("case_law_v8") })
    .from(publishedCaseLawDecisions)
    .where(eq(publishedCaseLawDecisions.id, CZE_DECISION_ID));
  expect(acceptedRevision).toEqual([{ revision: V9_REVISION }]);
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

test("global browse counts stay unchanged after a jurisdiction flips and before its old copy is purged", async () => {
  const engine = await buildV9();
  const documents = [
    {
      index: "case_law_v8_cs_sk",
      jurisdiction: "CZE",
      court: "Czech court",
      year: 2024,
    },
    {
      index: "case_law_v8_cs_sk",
      jurisdiction: "SVK",
      court: "Slovak court",
      year: 2023,
    },
    {
      index: "case_law_v9_cze",
      jurisdiction: "CZE",
      court: "Czech court",
      year: 2024,
      [PROJECTION_GENERATION_FIELD]: V9.generation,
    },
  ];
  let requests = 0;
  testFetchState.set(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        requests += 1;
        const url = new URL(input instanceof Request ? input.url : input);
        const body: unknown = JSON.parse(v.parse(v.string(), init?.body));
        const elastic = url.pathname.includes("/_elastic/");
        const indexIds = url.pathname.split("/").at(-2)?.split(",") ?? [];
        let selected = documents.filter(({ index }) =>
          indexIds.includes(index),
        );
        if (elastic) {
          const parsed = v.parse(
            v.object({
              query: v.object({
                bool: v.object({
                  must: v.array(
                    v.object({ query_string: v.object({ query: v.string() }) }),
                  ),
                  filter: v.array(
                    v.object({
                      query_string: v.object({
                        query: v.string(),
                        lenient: v.literal(true),
                      }),
                    }),
                  ),
                }),
              }),
            }),
            body,
          );
          expect(parsed.query.bool.must.at(0)?.query_string.query).toContain(
            `${V8.projection.openingField}:true`,
          );
          expect(parsed.query.bool.filter.at(0)?.query_string.query).toBe(
            `(NOT jurisdiction:"CZE" OR ${PROJECTION_GENERATION_FIELD}:"case_law_v9")`,
          );
          selected = selected.filter(
            (document) =>
              document.jurisdiction !== "CZE" ||
              document[PROJECTION_GENERATION_FIELD] === V9.generation,
          );
        } else {
          expect(
            v.parse(v.object({ query: v.string() }), body).query,
          ).toContain(`${V8.projection.openingField}:true`);
        }
        const buckets = (field: "jurisdiction" | "court" | "year") => {
          const counts = new Map<string | number, number>();
          for (const document of selected) {
            counts.set(document[field], (counts.get(document[field]) ?? 0) + 1);
          }
          return {
            buckets: [...counts]
              .map(([key, doc_count]) => ({ key, doc_count }))
              .toSorted((left, right) =>
                field === "year"
                  ? Number(right.key) - Number(left.key)
                  : right.doc_count - left.doc_count ||
                    getCollator("en").compare(
                      String(left.key),
                      String(right.key),
                    ),
              ),
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          };
        };
        return Response.json({
          aggregations: {
            country: buckets("jurisdiction"),
            court: buckets("court"),
            year: buckets("year"),
          },
        });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const facets = async () => {
    const target = await read(undefined);
    const result = await corpusIndexBrowseFacets(
      { excludedSourceIds: [], limit: 20 },
      "unobserved",
      {
        readServingTarget: async () => Result.ok(target),
      },
    );
    if (result.isErr()) {
      throw result.error;
    }
    return result.value;
  };
  const before = await facets();
  expect(requests).toBe(1);
  expect(before.country).toEqual([
    { value: "CZE", count: 1 },
    { value: "SVK", count: 1 },
  ]);
  expect((await flip(engine)).isOk()).toBe(true);
  const target = await read(undefined);
  expect(target.route.indexId).toContain("case_law_v8_cs_sk");
  expect(target.route.indexId).toContain("case_law_v9_cze");
  const after = await facets();
  expect(requests).toBe(2);
  expect(after).toEqual(before);
  // The fixture still contains both Czech copies: no erasure hides an overlap.
  expect(
    documents.filter(({ jurisdiction }) => jurisdiction === "CZE"),
  ).toHaveLength(2);
  await db.execute(sql`UPDATE corpus_index_group_enrollments
    SET provisioning_status = 'pending', attested_at = NULL`);
  const withdrawn = await read(undefined);
  expect(withdrawn.route.indexId).not.toContain("case_law_v9_cze");
  const afterWithdrawal = await facets();
  expect(requests).toBe(3);
  expect(afterWithdrawal.country).toEqual([{ value: "SVK", count: 1 }]);
  expect(afterWithdrawal.court).toEqual([{ value: "Slovak court", count: 1 }]);
});

test.each([
  ["native", "off"],
  ["scored", "off"],
  ["scored", "bm25-ratio"],
] as const)(
  "global mixed-generation search selects each jurisdiction's applied passages through %s with %s ranking",
  async (transport, rankingMode) => {
    const scanTransport = { type: transport };
    const engine = await buildV9();
    const oldRevision = toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-000000000508",
    );
    const slovakRevision = toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-00000000050a",
    );
    await applyDesired("case_law_v8", CZE_DECISION_ID, oldRevision);
    await applyDesired("case_law_v8", SVK_DECISION_ID, slovakRevision);
    const flipped = await flip(engine);
    expect(flipped.isOk() ? flipped.value.type : flipped.error._tag).toBe(
      "flipped",
    );
    const global = await read(undefined);
    expect(global.serving.generation).toBe("case_law_v8");
    const current = [
      {
        document_id: CZE_DECISION_ID,
        chunk_id: "cze-current-1",
        projection_revision: V9_REVISION,
      },
      {
        document_id: CZE_DECISION_ID,
        chunk_id: "cze-current-2",
        projection_revision: V9_REVISION,
      },
      // v8's mapping does not store the revision even though SQL records one.
      { document_id: SVK_DECISION_ID, chunk_id: "svk-current" },
    ];
    const stale = [
      { document_id: CZE_DECISION_ID, chunk_id: "cze-v8-old" },
      {
        document_id: CZE_DECISION_ID,
        chunk_id: "cze-v9-old",
        projection_revision: oldRevision,
      },
    ];
    let hits = current;
    let requests = 0;
    testFetchState.set(
      Object.assign(
        async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          requests += 1;
          const body: Record<string, unknown> =
            typeof init?.body === "string" ? JSON.parse(init.body) : {};
          const url = new URL(input instanceof Request ? input.url : input);
          if (url.pathname.includes("/_elastic/")) {
            const offset = Number(body["from"] ?? 0);
            const window = hits.slice(offset, offset + Number(body["size"]));
            return Response.json({
              hits: {
                total: { value: hits.length, relation: "eq" },
                hits: window.map((hit, index) => ({
                  _source: hit,
                  sort: [10 - offset - index],
                })),
              },
            });
          }
          const offset = Number(body["start_offset"] ?? 0);
          return Response.json({
            num_hits: hits.length,
            hits: hits.slice(offset, offset + Number(body["max_hits"])),
            snippets: [],
          });
        },
        { preconnect: originalFetch.preconnect },
      ),
    );
    const search = async () => {
      const hitDispositions = createCorpusHitDispositionCounter();
      const page = await readCorpusIndexSearchPage({
        hitDispositions,
        observer: "unobserved",
        cluster: "q09",
        indexId: global.route.indexId,
        query: "text:fixture",
        limit: 40,
        order: RELEVANCE_ORDER,
        parsedCursor: null,
        scanTransport,
        rankingMode,
        snippetFields: [],
        projectionRevisionField: "projection_revision",
        extractId: (hit) =>
          typeof hit["document_id"] === "string" ? hit["document_id"] : null,
        extractSnippet: () => null,
        unseenScoreUpperBound: () => 0,
        rankCandidates: async (candidates, { selectAppliedCandidates }) => {
          const rows = await db
            .select({
              id: publishedCaseLawDecisions.id,
              appliedRevision: caseLawCorpusAppliedRevision(
                global.serving.generation,
              ),
              appliedGeneration: caseLawCorpusServingGeneration(
                global.serving.generation,
              ),
            })
            .from(publishedCaseLawDecisions)
            .where(
              and(
                inArray(
                  publishedCaseLawDecisions.id,
                  candidates.map(({ id }) => toSafeId<"caseLawDecision">(id)),
                ),
                currentCaseLawCorpusProjection(global.serving.generation),
              ),
            );
          const appliedById = caseLawAppliedProjections(rows);
          const revisionById = new Map(
            [...appliedById].map(([id, projection]) => [
              id,
              projection.revision,
            ]),
          );
          return {
            context: {
              generations: new Map(
                rows.map(({ id, appliedGeneration }) => [
                  id,
                  appliedGeneration,
                ]),
              ),
            },
            groups: [],
            ranked: selectAppliedCandidates(appliedById)
              .filter(({ id }) =>
                revisionById.has(toSafeId<"caseLawDecision">(id)),
              )
              .map((candidate) => ({
                ...candidate,
                lexicalScore: candidate.score,
                citationAuthority: 0,
              })),
            revisionById,
          };
        },
      });
      expect(hitDispositions.snapshot().malformed).toBe(0);
      return page;
    };
    const singleCopy = await search();
    hits = [...stale, ...current];
    const beforePurge = await search();
    expect(beforePurge.passageCountById).toEqual(singleCopy.passageCountById);
    expect(beforePurge.passageCountById).toEqual(
      new Map([
        [CZE_DECISION_ID, 2],
        [SVK_DECISION_ID, 1],
      ]),
    );
    expect(beforePurge.context.generations).toEqual(
      new Map([
        [CZE_DECISION_ID, V9.generation],
        [SVK_DECISION_ID, V8.generation],
      ]),
    );
    expect(beforePurge.pageRanked.map(({ id }) => id).toSorted()).toEqual(
      [CZE_DECISION_ID, SVK_DECISION_ID].toSorted(),
    );
    expect(
      beforePurge.pageRanked.find(({ id }) => id === CZE_DECISION_ID)?.score,
    ).toBe(
      rankingMode === "bm25-ratio"
        ? (8 / 10) ** CORPUS_BM25_RATIO_POWER
        : corpusIndexLexicalScore(2),
    );
    expect(beforePurge.passageClauseById.get(CZE_DECISION_ID)).toBe(
      'chunk_id:"cze-current-1"',
    );
    // Only stale Czech matches remain; its applied row alone cannot validate them.
    hits = [
      ...stale,
      ...current.filter(({ document_id }) => document_id === SVK_DECISION_ID),
    ];
    const staleOnly = await search();
    expect(staleOnly.pageRanked.map(({ id }) => id)).toEqual([SVK_DECISION_ID]);
    expect(staleOnly.passageCountById.has(CZE_DECISION_ID)).toBe(false);
    expect(staleOnly.passageCountById.get(SVK_DECISION_ID)).toBe(1);
    expect(requests).toBe(3);
  },
);

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
