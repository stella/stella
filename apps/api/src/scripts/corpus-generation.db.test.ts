/**
 * The corpus generation operator command against a real PostgreSQL registry,
 * with the search engine replaced by a fake: register, the guarded flip
 * (`serve`) from a dry run to a flip and back, with its exit code per class
 * of refusal, parity and seed. A report run goes through the same read-only
 * wrapper the production door uses, so "a report writes nothing" is a
 * property of the connection, and is checked against the rows besides. The
 * flip's guard itself is tested in `corpus-index-generation-flip.db.test.ts`.
 */

import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  databaseBackfillStates,
  systemAuditRuns,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  type CaseLawRootHandle,
  readOnlyHandles,
} from "@/api/lib/case-law/maintenance-lane";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexFlipEngine } from "@/api/lib/legal-search/corpus-index-generation-flip";
import type { CorpusIndexRetireEngine } from "@/api/lib/legal-search/corpus-index-generation-retire";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CorpusGenerationLaneBusyError,
  runCorpusGenerationCommand,
  seedRunExit,
  type WithCorpusDatabase,
} from "@/api/scripts/corpus-generation";
import { createCorpusFlipFixture } from "@/api/tests/helpers/corpus-flip-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const SEARCH_ENDPOINT = "http://corpus-index.test";
/** Documents the fake engine reports for every index it holds. */
const INDEX_DOCUMENTS = 1200;

type EngineState = {
  /** Index ids that answer, with their document counts. */
  documents: Map<string, number>;
  /** Index ids a run asked about, in order. */
  searched: string[];
  /** Projection revisions per physical index, with their document counts. */
  revisions: Map<string, Map<string, number>>;
};

const engineWith = (indexIds: readonly string[]): EngineState => ({
  documents: new Map(indexIds.map((indexId) => [indexId, INDEX_DOCUMENTS])),
  searched: [],
  revisions: new Map(),
});

const NOW = new Date("2026-08-26T00:00:00.000Z");
const FINGERPRINT = "a".repeat(64);
const PROJECTED_ENTITY_ID = "0198e331-e578-7000-8000-000000000701";
/** One applied revision per generation, so two generations can coexist. */
const PROJECTION_REVISIONS = {
  case_law_v6: "0198e331-e578-7000-8000-000000000706",
  case_law_v7: "0198e331-e578-7000-8000-000000000707",
  legislation_v2: "0198e331-e578-7000-8000-000000000712",
} as const;

type ProjectedGeneration = keyof typeof PROJECTION_REVISIONS;

/**
 * Give a registered generation one entity the projection has applied, and
 * the engine the revision it wrote: a converged generation with no drift.
 */
const seedConvergedProjection = async (
  generation: ProjectedGeneration,
  engine?: EngineState,
) => {
  const family = generation === "legislation_v2" ? "legislation" : "case_law";
  const indexId =
    family === "legislation" ? `${generation}_cze` : `${generation}_cs_sk`;
  const revision = toSafeId<"corpusIndexProjectionIntent">(
    PROJECTION_REVISIONS[generation],
  );
  await db.insert(corpusIndexProjectionIntents).values({
    id: revision,
    family,
    generation,
    entityId: PROJECTED_ENTITY_ID,
    epoch: 1n,
    fingerprint: FINGERPRINT,
    indexId,
    status: "applied",
    appendStartedAt: NOW,
    appendCommittedAt: NOW,
    expectedDocumentCount: 1,
    appliedAt: NOW,
  });
  await db.insert(corpusIndexProjectionStates).values({
    family,
    generation,
    entityId: PROJECTED_ENTITY_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: FINGERPRINT,
    desiredIndexId: indexId,
    appliedAction: "upsert",
    appliedEpoch: 1n,
    appliedRevision: revision,
    appliedFingerprint: FINGERPRINT,
    appliedIndexId: indexId,
    appliedAt: NOW,
  });
  engine?.revisions.set(indexId, new Map([[revision, 1]]));
  return { revision };
};

const PENDING_ENTITY_ID = "0198e331-e578-7000-8000-000000000799";

const rootHandle = (): CaseLawRootHandle =>
  asTestRaw<CaseLawRootHandle>({
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
      await db.transaction(async (tx) => await fn(asTestRaw<Transaction>(tx))),
    execute: async (query: Parameters<typeof db.execute>[0]) =>
      await db.execute(query),
  });

type DatabaseOptions = { laneBusy?: boolean };

const testDatabase =
  ({ laneBusy = false }: DatabaseOptions = {}): WithCorpusDatabase =>
  async (access, work) => {
    switch (access) {
      case "read":
        return Result.ok(
          await work(
            readOnlyHandles({
              rootDb: rootHandle(),
              ingestionDb: async () =>
                panic("the command uses no ingestion handle"),
            }).rootDb,
          ),
        );
      case "write":
        return laneBusy
          ? Result.err(
              new CorpusGenerationLaneBusyError({
                message: "the lane is held by another pass",
              }),
            )
          : Result.ok(await work(rootHandle()));
      default:
        access satisfies never;
        return panic("unhandled access");
    }
  };

/** What the seed command's page runtime reads of database load. */
type SeedingLoad = { verdict: "normal" | "stop"; pageSize?: number };

type RunOptions = {
  args: readonly string[];
  engine?: EngineState;
  /** An engine for serve that answers the route census fixture's index. */
  flipEngine?: CorpusIndexFlipEngine;
  /** The engine retire lists and deletes indexes on. */
  retireEngine?: CorpusIndexRetireEngine;
  database?: WithCorpusDatabase;
  searchEndpoint?: string | null;
  seeding?: SeedingLoad;
};

type RunOutcome = { code: number; out: string; err: string };

/** An engine holding `indexIds`, which retire lists and deletes from. */
const retireEngineWith = (
  indexIds: readonly string[],
): CorpusIndexRetireEngine & { indexes: Set<string> } => {
  const indexes = new Set(indexIds);
  return {
    indexes,
    readPublishedSplitCounts: async ({ includes }) =>
      await Promise.resolve(
        Result.ok(
          [...indexes]
            .filter((indexId) => includes(indexId))
            .map((indexId) => ({ indexId, publishedSplits: 2 })),
        ),
      ),
    deleteIndex: async (indexId) => {
      indexes.delete(indexId);
      return await Promise.resolve(Result.ok());
    },
  };
};

const run = async ({
  args,
  engine = engineWith([]),
  flipEngine,
  retireEngine = retireEngineWith([]),
  database = testDatabase(),
  searchEndpoint = SEARCH_ENDPOINT,
  seeding = { verdict: "normal" },
}: RunOptions): Promise<RunOutcome> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCorpusGenerationCommand({
    args,
    withDatabase: database,
    withSeedingDatabase: async (work) => await work(rootHandle()),
    seedingBrake: {
      createRuntime: (options) =>
        createScriptBackfillRuntime({
          ...options,
          initialSize: seeding.pageSize ?? options.initialSize,
          readVerdict: async () => ({ kind: seeding.verdict, signals: [] }),
          // Embedded PostgreSQL owns one session; there is no slot to share.
          slot: { tryAcquire: async () => true, release: () => {} },
        }),
      // A held page stops the run at once instead of waiting.
      maxWaitMs: 0,
    },
    searchEndpoint: () => searchEndpoint,
    retireEngine: () => retireEngine,
    indexClient: () =>
      flipEngine ?? {
        readIndexIncarnation: async (indexId) =>
          Result.ok(
            engine.documents.has(indexId)
              ? ({
                  type: "present",
                  incarnation: `${indexId}:01JFIRST`,
                } as const)
              : ({ type: "missing" } as const),
          ),
        search: async ({ indexId }) => {
          engine.searched.push(indexId);
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
      },
    write: (line) => {
      out.push(line);
    },
    writeError: (line) => {
      err.push(line);
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

const registryRows = async () =>
  await db
    .select({
      family: corpusIndexGenerations.family,
      generation: corpusIndexGenerations.generation,
      status: corpusIndexGenerations.status,
      manifestDigest: corpusIndexGenerations.manifestDigest,
    })
    .from(corpusIndexGenerations)
    .orderBy(corpusIndexGenerations.family, corpusIndexGenerations.generation);

const auditCounts = async () =>
  (
    await db
      .select({ counts: systemAuditRuns.counts })
      .from(systemAuditRuns)
      .where(eq(systemAuditRuns.actor, "system:corpus-generation-operator"))
  ).map(({ counts }) => counts);

const statusOf = async (generation: string) =>
  (await registryRows()).find((row) => row.generation === generation)?.status;

const caseLaw = (command: string, generation: string, ...flags: string[]) => [
  command,
  "--family",
  "case_law",
  "--generation",
  generation,
  ...flags,
];

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  // Each test starts from an empty registry: the fresh-environment case.
  await db.execute(
    sql.raw(
      'TRUNCATE TABLE "system_audit_runs", "corpus_index_generations" CASCADE',
    ),
  );
});

describe("corpus generation operator command", () => {
  test("register writes a building generation once; serve refuses it until its routes are proven", async () => {
    expect(await registryRows()).toEqual([]);

    const registerReport = await run({
      args: caseLaw("register", "case_law_v6"),
    });
    expect(registerReport.code).toBe(0);
    expect(registerReport.out).toContain(
      "plan: register case_law_v6 as building",
    );
    expect(registerReport.out).toContain("Dry run: nothing written");
    expect(await registryRows()).toEqual([]);

    expect(
      (await run({ args: caseLaw("register", "case_law_v6", "--apply") })).code,
    ).toBe(0);
    expect(await registryRows()).toEqual([
      {
        family: "case_law",
        generation: "case_law_v6",
        status: "building",
        manifestDigest: corpusIndexManifestDigest(
          requireCorpusIndexManifest("case_law", "case_law_v6"),
        ),
      },
    ]);
    // A replay converges and leaves no second audit run.
    const replay = await run({
      args: caseLaw("register", "case_law_v6", "--apply"),
    });
    expect(replay.code).toBe(0);
    expect(replay.out).toContain("already registered as building");
    expect(await auditCounts()).toEqual([
      { registered: 1, promoted: 0, demoted: 0 },
    ]);

    // Nothing proves the generation's routes yet: the flip is refused with
    // the route-proof class's exit code, and nothing is written.
    const refusedServe = await run({ args: caseLaw("serve", "case_law_v6") });
    expect(refusedServe.code).toBe(11);
    expect(refusedServe.err).toContain(
      "refused (route_proofs: not_current): Not every route of case_law/case_law_v6 has a current proof",
    );
    expect(refusedServe.err).toContain("case_law_v6_pol: never proven");
    expect(await statusOf("case_law_v6")).toBe("building");
    expect(await auditCounts()).toHaveLength(1);
  });

  test("serve refuses by class, before any change, and --apply needs the pair and a receipt", async () => {
    const unregistered = await run({ args: caseLaw("serve", "case_law_v7") });
    expect(unregistered.code).toBe(10);
    expect(unregistered.err).toContain("refused (registry: not_registered)");

    await db.insert(corpusIndexGenerations).values(
      (["case_law_v9", "legislation_v2"] as const).map((generation) => {
        const manifest = CORPUS_INDEX_MANIFESTS[generation];
        return {
          family: manifest.family,
          generation,
          cluster: "q09" as const,
          manifestDigest: corpusIndexManifestDigest(manifest),
          status: "building" as const,
        };
      }),
    );
    const partial = await run({ args: caseLaw("serve", "case_law_v9") });
    expect(partial.code).toBe(10);
    expect(partial.err).toContain("refused (registry: partial_generation)");
    // Legislation routes per jurisdiction: no route set to prove, so it
    // never flips through this guard.
    const legislation = await run({
      args: [
        "serve",
        "--family",
        "legislation",
        "--generation",
        "legislation_v2",
      ],
    });
    expect(legislation.code).toBe(11);
    expect(legislation.err).toContain("no closed route set");

    const missingEndpoint = await run({
      args: caseLaw("serve", "case_law_v9"),
      searchEndpoint: null,
    });
    expect(missingEndpoint.code).toBe(1);
    expect(missingEndpoint.err).toContain(
      "CorpusGenerationSearchEndpointMissingError",
    );
    for (const flags of [
      ["--apply"],
      ["--apply", "--replacing", "case_law_v7"],
      [
        "--apply",
        "--replacing",
        "none",
        "--actor",
        "Operator",
        "--reason",
        "go",
      ],
      [
        "--apply",
        "--replacing",
        "none",
        "--actor",
        "operator",
        "--reason",
        " ",
      ],
      // A flip takes the decided watermark only.
      [
        "--apply",
        "--replacing",
        "case_law_v7",
        "--actor",
        "operator",
        "--reason",
        "go",
        "--exempt-minutes",
        "1440",
      ],
    ]) {
      // db-await-in-loop: parsing refuses before any database is opened
      const refused = await run({
        args: caseLaw("serve", "case_law_v10", ...flags),
        database: async () =>
          panic("a malformed command must not open the database"),
      });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("Usage:");
    }
    expect(await registryRows()).toHaveLength(2);
    expect(await auditCounts()).toEqual([]);
  });

  test("serve flips through the command: a dry run, then --apply with its receipt, each exit 0", async () => {
    const fixture = createCorpusFlipFixture(
      async (work) =>
        await db.transaction(
          async (tx) => await work(asTestRaw<Transaction>(tx)),
        ),
    );
    await fixture.readyPair();
    const serve = async (
      flags: readonly string[],
      database: WithCorpusDatabase = testDatabase(),
    ) =>
      await run({
        args: caseLaw("serve", "case_law_v10", ...flags),
        database,
        flipEngine: fixture.engineClient,
      });
    const dry = await serve([]);
    expect(dry.err).toBe("");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain(
      "checked under the fence: behind the walk's cursor: 1 pages counted again, 0 moved",
    );
    expect(dry.out).toContain("Dry run: nothing written");
    expect(await statusOf("case_law_v10")).toBe("building");

    const applyFlags = [
      "--apply",
      "--replacing",
      "case_law_v7",
      "--actor",
      "operator:test",
      "--reason",
      "go for the flip",
    ];
    // The lane's budget runs out before the flip runs: busy, nothing written.
    const spentBefore = await serve(applyFlags, async (access, work) =>
      access === "write"
        ? await Promise.reject(new DOMException("budget spent", "TimeoutError"))
        : await testDatabase()(access, work),
    );
    expect(spentBefore.code).toBe(14);
    expect(spentBefore.err).toContain("refused (busy: lane_budget_spent)");
    expect(await statusOf("case_law_v10")).toBe("building");

    // It runs out after the flip committed: the flip's own answer stands.
    const spentAfter = await serve(applyFlags, async (access, work) => {
      const done = await testDatabase()(access, work);
      return access === "write"
        ? await Promise.reject(new DOMException("budget spent", "TimeoutError"))
        : done;
    });
    expect(spentAfter.code).toBe(0);
    expect(spentAfter.err).toContain(
      "the operator lane's time budget ran out after the flip's transaction ended",
    );
    expect(spentAfter.out).toContain(
      "Applied: case_law/case_law_v10 serves; case_law_v7 is building",
    );
    expect(spentAfter.out).toContain(
      "computed by PostgreSQL from the stored row",
    );
    expect(await statusOf("case_law_v10")).toBe("serving");
    expect(await statusOf("case_law_v7")).toBe("building");
    expect(await auditCounts()).toEqual([
      { registered: 0, promoted: 1, demoted: 1 },
    ]);
    const replay = await serve(applyFlags);
    expect(replay.code).toBe(0);
    expect(replay.out).toContain("already serving");
    await fixture.removeCanonical();
  });

  test("parity reports, read only, what readers would lose to the candidate", async () => {
    await db.insert(corpusIndexGenerations).values(
      (
        [
          ["case_law_v7", "serving"],
          ["case_law_v10", "building"],
        ] as const
      ).map(([generation, status]) => ({
        family: "case_law" as const,
        generation,
        cluster: "q09" as const,
        manifestDigest: corpusIndexManifestDigest(
          requireCorpusIndexManifest("case_law", generation),
        ),
        status,
      })),
    );
    // Served by case_law_v7, and still waiting for its first append in
    // case_law_v10: a regression.
    await seedConvergedProjection("case_law_v7");
    await db.insert(corpusIndexProjectionStates).values({
      family: "case_law",
      generation: "case_law_v10",
      entityId: PROJECTED_ENTITY_ID,
      desiredAction: "upsert",
      desiredEpoch: 1n,
      desiredFingerprint: FINGERPRINT,
      desiredIndexId: "case_law_v10_cze",
    });
    // Served by case_law_v7, with no case_law_v10 state at all.
    const unseeded = toSafeId<"corpusIndexProjectionIntent">(
      "0198e331-e578-7000-8000-000000000708",
    );
    await db.insert(corpusIndexProjectionIntents).values({
      id: unseeded,
      family: "case_law",
      generation: "case_law_v7",
      entityId: PENDING_ENTITY_ID,
      epoch: 1n,
      fingerprint: FINGERPRINT,
      indexId: "case_law_v7_cs_sk",
      status: "applied",
      appendStartedAt: NOW,
      appendCommittedAt: NOW,
      expectedDocumentCount: 1,
      appliedAt: NOW,
    });
    await db.insert(corpusIndexProjectionStates).values({
      family: "case_law",
      generation: "case_law_v7",
      entityId: PENDING_ENTITY_ID,
      desiredAction: "upsert",
      desiredEpoch: 1n,
      desiredFingerprint: FINGERPRINT,
      desiredIndexId: "case_law_v7_cs_sk",
      appliedAction: "upsert",
      appliedEpoch: 1n,
      appliedRevision: unseeded,
      appliedFingerprint: FINGERPRINT,
      appliedIndexId: "case_law_v7_cs_sk",
      appliedAt: NOW,
    });
    const before = await registryRows();

    // Both decisions have been served for months: neither is new enough to
    // be the candidate's expected lag.
    await db
      .update(corpusIndexProjectionStates)
      .set({ createdAt: NOW })
      .where(eq(corpusIndexProjectionStates.generation, "case_law_v7"));
    const report = await run({
      args: caseLaw("parity", "case_law_v10", "--list"),
    });
    expect(report.err).toBe("");
    // Regressions remain: a distinct exit code a wrapper can gate on.
    expect(report.code).toBe(3);
    expect(report.out).toContain(
      "checked: compared with case_law_v7, which serves case_law",
    );
    expect(report.out).toContain(
      "checked: every serving state walked (2); 1 without a candidate state",
    );
    expect(report.out).toContain("not shown or stale (exact): 1");
    expect(report.out).toContain("  case_law_v10_cze not_shown 1");
    expect(report.out).toContain(
      `  not_shown: ${PROJECTED_ENTITY_ID} case_law_v10_cze, serving epoch 1, candidate epoch none`,
    );
    expect(report.out).toContain(`  no state: ${PENDING_ENTITY_ID}`);
    expect(report.out).toContain(
      "verdict: regressions remain (1 without a candidate state, 1 not shown or stale)",
    );
    expect(await registryRows()).toEqual(before);
    expect(await auditCounts()).toEqual([]);

    // Without --list no decision is printed by id.
    const summary = await run({ args: caseLaw("parity", "case_law_v10") });
    expect(summary.code).toBe(3);
    expect(summary.out).not.toContain(PENDING_ENTITY_ID);

    // Once the candidate holds and shows both decisions, the verdict is proven.
    await db
      .delete(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.generation, "case_law_v10"));
    for (const [entityId, revision] of [
      [PROJECTED_ENTITY_ID, "0198e331-e578-7000-8000-000000000710"],
      [PENDING_ENTITY_ID, "0198e331-e578-7000-8000-000000000711"],
    ] as const) {
      const id = toSafeId<"corpusIndexProjectionIntent">(revision);
      // db-await-in-loop: two decisions of the fixture
      await db.insert(corpusIndexProjectionIntents).values({
        id,
        family: "case_law",
        generation: "case_law_v10",
        entityId,
        epoch: 1n,
        fingerprint: FINGERPRINT,
        indexId: "case_law_v10_cze",
        status: "applied",
        appendStartedAt: NOW,
        appendCommittedAt: NOW,
        expectedDocumentCount: 1,
        appliedAt: NOW,
      });
      // db-await-in-loop: as above
      await db.insert(corpusIndexProjectionStates).values({
        family: "case_law",
        generation: "case_law_v10",
        entityId,
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: FINGERPRINT,
        desiredIndexId: "case_law_v10_cze",
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: id,
        appliedFingerprint: FINGERPRINT,
        appliedIndexId: "case_law_v10_cze",
        appliedAt: NOW,
      });
    }
    const proven = await run({ args: caseLaw("parity", "case_law_v10") });
    expect(proven.out).toContain("verdict: no regression");
    expect(proven.code).toBe(0);

    // The same family, with a walk that may not read every copy, decides
    // nothing: an empty reading is not a proof.
    const budgeted = await run({
      args: caseLaw("parity", "case_law_v10", "--coverage-pages", "0"),
    });
    expect(budgeted.out).toContain("resume with --coverage-from start");
    expect(budgeted.out).toContain("verdict: undecided (coverage_incomplete)");
    expect(budgeted.code).toBe(4);
  });

  test("parity is refused for a family nothing serves, or for the serving generation itself", async () => {
    await db.insert(corpusIndexGenerations).values({
      family: "case_law",
      generation: "case_law_v10",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        requireCorpusIndexManifest("case_law", "case_law_v10"),
      ),
      status: "building",
    });
    const absent = await run({ args: caseLaw("parity", "case_law_v10") });
    expect(absent.code).toBe(1);
    expect(absent.err).toContain("refused (CorpusIndexFlipPairRefusedError)");
    expect(absent.err).toContain("No generation serves case_law");

    await db
      .update(corpusIndexGenerations)
      .set({ status: "serving" })
      .where(eq(corpusIndexGenerations.generation, "case_law_v10"));
    const itself = await run({ args: caseLaw("parity", "case_law_v10") });
    expect(itself.code).toBe(1);
    expect(itself.err).toContain("refused (CorpusIndexFlipPairRefusedError)");
  });

  test("malformed command lines are refused with the usage", async () => {
    for (const args of [
      [],
      ["promote"],
      caseLaw("serve", "case_law_v7", "--apply", "--dry-run"),
      ["serve", "--family", "statutes", "--generation", "case_law_v7"],
      ["serve", "--family", "case_law"],
      caseLaw("serve", "case_law_v7", "--limit", "1"),
      caseLaw("serve", "case_law_v7", "--list"),
      caseLaw("serve", "case_law_v7", "--max-proof-age-hours", "25"),
      caseLaw("parity", "case_law_v10", "--replacing", "case_law_v7"),
      caseLaw("parity", "case_law_v10", "--apply"),
      caseLaw("parity", "case_law_v10", "--exempt-minutes", "1441"),
      caseLaw("parity", "case_law_v10", "--exempt-minutes", "-1"),
      caseLaw("parity", "case_law_v10", "--coverage-pages", "20001"),
      caseLaw("parity", "case_law_v10", "--coverage-from", "case_law_v7_cs_sk"),
      caseLaw("parity", "case_law_v10", "--coverage-from", "end"),
      ["status", "--list"],
    ]) {
      // db-await-in-loop: parsing refuses before any database is opened
      const refused = await run({
        args,
        database: async () =>
          panic("a malformed command must not open the database"),
      });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("Usage:");
    }
  });

  test("a seed run exits with the code of the reason it stopped", async () => {
    const manifest = CORPUS_INDEX_MANIFESTS.case_law_v10;
    const sourceId = toSafeId<"caseLawSource">(
      "0198e331-e578-7000-8000-000000000890",
    );
    const seed = async (load: SeedingLoad, ...flags: string[]) =>
      await run({
        args: caseLaw("seed", "case_law_v10", ...flags),
        seeding: load,
      });
    await db
      .delete(databaseBackfillStates)
      .where(sql`${databaseBackfillStates.name} LIKE 'corpus-seeding:%'`);
    try {
      // Not registered: refused, nothing walked.
      const unregistered = await seed({ verdict: "normal" });
      expect(unregistered.code).toBe(1);
      expect(unregistered.err).toContain("not registered");

      await db.insert(corpusIndexGenerations).values({
        family: "case_law",
        generation: "case_law_v10",
        cluster: manifest.cluster,
        manifestDigest: corpusIndexManifestDigest(manifest),
        status: "building",
      });
      // Not yet projectable, so held by no generation: the walk passes them.
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: "seed-exit-codes",
        name: "Seed exit codes",
      });
      await db.insert(caseLawDecisions).values(
        [1, 2].map((n) => ({
          id: toSafeId<"caseLawDecision">(
            `0198e331-e578-7000-8000-00000000089${String(n)}`,
          ),
          sourceId,
          caseNumber: `${String(n)} As 1/2026`,
          court: "Nejvyšší správní soud",
          country: "CZE",
          language: "cs",
          corpusMirrorStatus: "pending" as const,
        })),
      );

      const braked = await seed({ verdict: "stop" });
      expect(braked.code).toBe(6);
      expect(braked.out).toContain("paused by the database-load brake");
      // The hold the brake left on the run's checkpoint has run out.
      await db
        .delete(databaseBackfillStates)
        .where(sql`${databaseBackfillStates.name} LIKE 'corpus-seeding:%'`);

      const budget = await seed(
        { verdict: "normal", pageSize: 1 },
        "--pages",
        "1",
      );
      expect(budget.code).toBe(5);
      expect(budget.out).toContain("page budget spent");

      const seeded = await seed({ verdict: "normal" });
      expect(seeded.code).toBe(0);
      expect(seeded.out).toContain("every route of the generation is seeded");
    } finally {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      await db
        .delete(databaseBackfillStates)
        .where(sql`${databaseBackfillStates.name} LIKE 'corpus-seeding:%'`);
    }
  });

  test("a seed run held by a writer, or outrun by a new route, has its own exit code", () => {
    const target = { family: "case_law", generation: "case_law_v10" } as const;
    const pass = {
      number: 1,
      startedAt: new Date(0),
      routes: ["case_law_v10_cs"],
      afterEntityId: null,
      walked: 0,
      seeded: 0,
      deferred: 0,
      completedAt: null,
    };
    const routes = [
      {
        indexId: "case_law_v10_cs",
        jurisdictions: ["CZE"],
        state: "seeded" as const,
        passNumber: 1,
        seededAt: new Date(0),
      },
    ];
    const exit = (
      outcome: Parameters<typeof seedRunExit>[0]["outcome"],
      seedings: Parameters<typeof seedRunExit>[0]["seedings"],
      paused = false,
    ) => {
      const lines: string[] = [];
      const code = seedRunExit({
        target,
        paused,
        outcome,
        seedings,
        write: (line) => {
          lines.push(line);
        },
      });
      return { code: code.isOk() ? code.value : 1, lines };
    };

    expect(exit({ type: "busy", pass }, { pass, routes }).code).toBe(7);
    expect(
      exit(
        { type: "completed", pass },
        {
          pass,
          routes: [
            ...routes,
            {
              indexId: "case_law_v10_hu",
              jurisdictions: ["HUN"],
              state: "unseeded",
              reason: "never_walked",
            },
          ],
        },
      ).code,
    ).toBe(8);
    expect(exit({ type: "completed", pass }, { pass, routes }).code).toBe(0);
    expect(
      exit({ type: "advanced", pass, walked: 1, seeded: 0 }, { pass, routes })
        .code,
    ).toBe(5);
    // A brake pause after some pages is still a pause, not a spent budget.
    expect(
      exit(
        { type: "advanced", pass, walked: 1, seeded: 0 },
        { pass, routes },
        true,
      ).code,
    ).toBe(6);
    expect(exit({ type: "inactive", status: "retiring" }, null).code).toBe(1);
  });
});

describe("retire", () => {
  // The cleanup's page runtime keeps its checkpoint and any brake hold by
  // run name, outside the tables the suite truncates.
  const clearCleanupCheckpoints = async () => {
    await db
      .delete(databaseBackfillStates)
      .where(sql`${databaseBackfillStates.name} LIKE 'corpus-retire:%'`);
  };
  beforeEach(clearCleanupCheckpoints);
  const registerRow = async (
    generation: "case_law_v6" | "case_law_v7",
    status: "building" | "serving",
  ) => {
    await db.insert(corpusIndexGenerations).values({
      family: "case_law",
      generation,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[generation],
      ),
      status,
    });
  };
  const retireAuditCounts = async () =>
    (
      await db
        .select({ counts: systemAuditRuns.counts })
        .from(systemAuditRuns)
        .where(eq(systemAuditRuns.actor, "system:corpus-generation-retire"))
        .orderBy(systemAuditRuns.id)
    ).map(({ counts }) => counts);
  const historyOf = async (generation: string) => ({
    states: (
      await db
        .select({ entityId: corpusIndexProjectionStates.entityId })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.generation, generation))
    ).length,
    intents: (
      await db
        .select({ id: corpusIndexProjectionIntents.id })
        .from(corpusIndexProjectionIntents)
        .where(eq(corpusIndexProjectionIntents.generation, generation))
    ).length,
  });
  const APPLY = [
    "--apply",
    "--actor",
    "operator:test",
    "--reason",
    "never serves",
  ];

  test("a dry run plans and writes nothing; --apply retires, deletes the generation's indexes and its history; a rerun finds nothing left", async () => {
    await registerRow("case_law_v7", "serving");
    await registerRow("case_law_v6", "building");
    await seedConvergedProjection("case_law_v7");
    await seedConvergedProjection("case_law_v6");
    const engine = retireEngineWith([
      "case_law_v6_cs_sk",
      "case_law_v6_eu",
      "case_law_v7_cs_sk",
      "case_law_v60_cze",
    ]);

    const report = await run({
      args: caseLaw("retire", "case_law_v6"),
      retireEngine: engine,
    });
    expect(report.code).toBe(0);
    expect(report.out).toContain(
      "plan: case_law_v6 building -> retired; no writer projects it from that commit on",
    );
    expect(report.out).toContain("holds: 1 projection states, 1 revisions");
    expect(report.out).toContain(
      "plan: delete 2 engine indexes: case_law_v6_cs_sk (2 splits), case_law_v6_eu (2 splits)",
    );
    expect(report.out).toContain("Dry run: nothing written");
    expect(await statusOf("case_law_v6")).toBe("building");
    expect(engine.indexes.size).toBe(4);

    const unsigned = await run({
      args: caseLaw("retire", "case_law_v6", "--apply"),
      retireEngine: engine,
    });
    expect(unsigned.code).toBe(1);
    expect(unsigned.err).toContain("retire --apply needs --actor and --reason");

    const applied = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
      retireEngine: engine,
    });
    expect(applied.err).toBe("");
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(
      "Applied: case_law/case_law_v6 is retired as of",
    );
    expect(applied.out).toContain("deleted engine index case_law_v6_cs_sk");
    expect(applied.out).toContain("left: 0 projection states, 0 revisions");
    expect(await statusOf("case_law_v6")).toBe("retired");
    expect([...engine.indexes].toSorted()).toEqual([
      "case_law_v60_cze",
      "case_law_v7_cs_sk",
    ]);
    expect(await historyOf("case_law_v6")).toEqual({ states: 0, intents: 0 });
    expect(await historyOf("case_law_v7")).toEqual({ states: 1, intents: 1 });
    expect(await retireAuditCounts()).toEqual([
      { retired: 1, deletedIndexes: 0, deletedStates: 0, deletedIntents: 0 },
      { retired: 0, deletedIndexes: 2, deletedStates: 1, deletedIntents: 1 },
    ]);

    const rerun = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
      retireEngine: engine,
    });
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain("checked: already retired at");
    expect(rerun.out).toContain("by operator:test (never serves)");
    // A run that deleted nothing records nothing.
    expect(await retireAuditCounts()).toHaveLength(2);
  });

  test("retire refuses the serving generation with its exit code, and the brake pauses the cleanup until a rerun", async () => {
    await registerRow("case_law_v7", "serving");
    await registerRow("case_law_v6", "building");
    await seedConvergedProjection("case_law_v6");

    const serving = await run({
      args: caseLaw("retire", "case_law_v7", ...APPLY),
    });
    expect(serving.code).toBe(10);
    expect(serving.err).toContain("refused (registry: serving)");
    expect(await statusOf("case_law_v7")).toBe("serving");

    const braked = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
      seeding: { verdict: "stop" },
    });
    expect(braked.code).toBe(6);
    expect(braked.err).toContain("run retire again to resume");
    // Retired at once; the history waits for the brake.
    expect(await statusOf("case_law_v6")).toBe("retired");
    expect(await historyOf("case_law_v6")).toEqual({ states: 1, intents: 1 });
    // The hold the brake left on the run's checkpoint has run out.
    await clearCleanupCheckpoints();

    const resumed = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
    });
    expect(resumed.code).toBe(0);
    expect(await historyOf("case_law_v6")).toEqual({ states: 0, intents: 0 });
  });
  test("an engine that cannot delete leaves the history cleanup to run, exits engine, and a rerun finishes the indexes", async () => {
    await registerRow("case_law_v6", "building");
    await seedConvergedProjection("case_law_v6");
    const engine = retireEngineWith(["case_law_v6_cs_sk", "case_law_v7_cs_sk"]);
    const down: CorpusIndexRetireEngine = {
      readPublishedSplitCounts: engine.readPublishedSplitCounts,
      deleteIndex: async () =>
        await Promise.resolve(
          Result.err(
            new CorpusIndexError({ message: "build lane parked", status: 503 }),
          ),
        ),
    };
    const failed = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
      retireEngine: down,
    });
    expect(failed.code).toBe(15);
    expect(failed.err).toContain("did not delete case_law_v6_cs_sk");
    expect(await statusOf("case_law_v6")).toBe("retired");
    expect(await historyOf("case_law_v6")).toEqual({ states: 0, intents: 0 });
    expect([...engine.indexes].toSorted()).toEqual([
      "case_law_v6_cs_sk",
      "case_law_v7_cs_sk",
    ]);

    const rerun = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
      retireEngine: engine,
    });
    expect(rerun.code).toBe(0);
    expect([...engine.indexes]).toEqual(["case_law_v7_cs_sk"]);
  });
  test("an engine that cannot list refuses the dry run, and an apply still retires and cleans the history", async () => {
    await registerRow("case_law_v6", "building");
    await seedConvergedProjection("case_law_v6");
    const unlisted: CorpusIndexRetireEngine = {
      readPublishedSplitCounts: async () =>
        await Promise.resolve(
          Result.err(
            new CorpusIndexError({ message: "search lane down", status: 503 }),
          ),
        ),
      deleteIndex: async () => await Promise.resolve(Result.ok()),
    };
    const report = await run({
      args: caseLaw("retire", "case_law_v6"),
      retireEngine: unlisted,
    });
    expect(report.code).toBe(15);
    expect(await statusOf("case_law_v6")).toBe("building");

    const applied = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
      retireEngine: unlisted,
    });
    expect(applied.code).toBe(15);
    expect(await statusOf("case_law_v6")).toBe("retired");
    expect(await historyOf("case_law_v6")).toEqual({ states: 0, intents: 0 });
  });
  test("--defer-cleanup retires and deletes the indexes but leaves the history, which takes no writes, for a later run", async () => {
    await registerRow("case_law_v7", "serving");
    await registerRow("case_law_v6", "building");
    await seedConvergedProjection("case_law_v7");
    await seedConvergedProjection("case_law_v6");
    const engine = retireEngineWith(["case_law_v6_cs_sk", "case_law_v7_cs_sk"]);

    const report = await run({
      args: caseLaw("retire", "case_law_v6", "--defer-cleanup"),
      retireEngine: engine,
    });
    expect(report.code).toBe(0);
    expect(report.out).toContain(
      "plan: leave its projection history for a later run of retire (--defer-cleanup)",
    );
    expect(await statusOf("case_law_v6")).toBe("building");

    const deferred = await run({
      args: caseLaw("retire", "case_law_v6", "--defer-cleanup", ...APPLY),
      retireEngine: engine,
    });
    expect(deferred.err).toBe("");
    expect(deferred.code).toBe(0);
    expect(deferred.out).toContain(
      "Deferred: history cleanup of case_law/case_law_v6 is left for a later run",
    );
    expect(await statusOf("case_law_v6")).toBe("retired");
    expect([...engine.indexes]).toEqual(["case_law_v7_cs_sk"]);
    expect(await historyOf("case_law_v6")).toEqual({ states: 1, intents: 1 });
    // The history it left takes no write.
    expect(
      await rejectionOf(
        db
          .update(corpusIndexProjectionStates)
          .set({ retryNotBefore: NOW })
          .where(eq(corpusIndexProjectionStates.generation, "case_law_v6")),
      ),
    ).toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "case_law/case_law_v6 is retired and takes no projection writes",
        ),
      }),
    });
    expect(await retireAuditCounts()).toEqual([
      { retired: 1, deletedIndexes: 0, deletedStates: 0, deletedIntents: 0 },
      { retired: 0, deletedIndexes: 1, deletedStates: 0, deletedIntents: 0 },
    ]);

    const cleaned = await run({
      args: caseLaw("retire", "case_law_v6", ...APPLY),
      retireEngine: engine,
    });
    expect(cleaned.code).toBe(0);
    expect(cleaned.out).toContain("checked: already retired at");
    expect(await historyOf("case_law_v6")).toEqual({ states: 0, intents: 0 });
    expect(await historyOf("case_law_v7")).toEqual({ states: 1, intents: 1 });
    expect((await retireAuditCounts()).at(-1)).toEqual({
      retired: 0,
      deletedIndexes: 0,
      deletedStates: 1,
      deletedIntents: 1,
    });
  });

  test("--defer-cleanup belongs to retire", async () => {
    const refused = await run({
      args: caseLaw("seed", "case_law_v6", "--defer-cleanup"),
    });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--defer-cleanup belongs to retire.");
  });
});
