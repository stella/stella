/**
 * The corpus generation operator command against a real PostgreSQL registry,
 * with the search engine replaced by a counting fake: register, a family's
 * first flip, a second flip that retires the first, and every refusal an
 * operator can meet. A report run goes through the same read-only wrapper the
 * production door uses, so "a dry run writes nothing" is a property of the
 * connection, and is checked against the rows besides.
 */

import { Result, panic } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations, systemAuditRuns } from "@/api/db/schema";
import {
  type CaseLawRootHandle,
  readOnlyHandles,
} from "@/api/lib/case-law/maintenance-lane";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import { readServingCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  CorpusGenerationLaneBusyError,
  runCorpusGenerationCommand,
  type WithCorpusDatabase,
} from "@/api/scripts/corpus-generation";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const SEARCH_ENDPOINT = "http://corpus-index.test";
/** Documents the fake engine reports for every index it holds. */
const INDEX_DOCUMENTS = 1200;

/** The physical indexes `case_law_v6` and `case_law_v7` were created with. */
const createdIndexes = (generation: string) => [
  `${generation}_*`,
  `${generation}_aut`,
  `${generation}_cs_sk`,
  `${generation}_eu`,
  `${generation}_pol`,
];

type EngineState = {
  /** Index ids that answer, with their document counts. */
  documents: Map<string, number>;
  /** Index ids a run asked about, in order. */
  searched: string[];
};

const engineWith = (indexIds: readonly string[]): EngineState => ({
  documents: new Map(indexIds.map((indexId) => [indexId, INDEX_DOCUMENTS])),
  searched: [],
});

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

type RunOptions = {
  args: readonly string[];
  engine?: EngineState;
  database?: WithCorpusDatabase;
  searchEndpoint?: string | null;
};

type RunOutcome = { code: number; out: string; err: string };

const run = async ({
  args,
  engine = engineWith([]),
  database = testDatabase(),
  searchEndpoint = SEARCH_ENDPOINT,
}: RunOptions): Promise<RunOutcome> => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCorpusGenerationCommand({
    args,
    withDatabase: database,
    searchEndpoint: () => searchEndpoint,
    indexClient: () => ({
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
    }),
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
  test("a fresh registry goes from nothing to serving, and a second flip retires the first", async () => {
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

    // The first flip of a family: no generation serves before it.
    const engine = engineWith([
      ...createdIndexes("case_law_v6"),
      ...createdIndexes("case_law_v7"),
    ]);
    const serveReport = await run({
      args: caseLaw("serve", "case_law_v6"),
      engine,
    });
    expect(serveReport.code).toBe(0);
    expect(serveReport.out).toContain(
      "plan: case_law_v6 building -> serving (first serving generation of case_law)",
    );
    expect(serveReport.out).toContain(
      `checked: case_law_v6_cs_sk holds ${String(INDEX_DOCUMENTS)} documents on ${SEARCH_ENDPOINT}`,
    );
    expect(engine.searched).toEqual(createdIndexes("case_law_v6"));
    expect(await statusOf("case_law_v6")).toBe("building");

    expect(
      (await run({ args: caseLaw("serve", "case_law_v6", "--apply"), engine }))
        .code,
    ).toBe(0);
    expect(
      await readServingCorpusIndexGenerationTx(
        asTestRaw<Transaction>(db),
        "case_law",
      ),
    ).toEqual({
      family: "case_law",
      generation: "case_law_v6",
      cluster: "q09",
    });

    // A second generation replaces it; the one it replaces starts retiring.
    expect(
      (await run({ args: caseLaw("register", "case_law_v7", "--apply") })).code,
    ).toBe(0);
    const second = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine,
    });
    expect(second.code).toBe(0);
    expect(second.out).toContain(
      "plan: case_law_v7 building -> serving; case_law_v6 serving -> retiring",
    );
    expect(await registryRows()).toMatchObject([
      { generation: "case_law_v6", status: "retiring" },
      { generation: "case_law_v7", status: "serving" },
    ]);
    expect(await auditCounts()).toEqual(
      expect.arrayContaining([
        { registered: 1, promoted: 0, demoted: 0 },
        { registered: 0, promoted: 1, demoted: 0 },
        { registered: 0, promoted: 1, demoted: 1 },
      ]),
    );
    expect(await auditCounts()).toHaveLength(4);

    // Serving the serving generation again changes nothing and asks no engine.
    const searchedBefore = engine.searched.length;
    const again = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine,
    });
    expect(again.code).toBe(0);
    expect(again.out).toContain("already serving");
    expect(engine.searched).toHaveLength(searchedBefore);
    expect(await auditCounts()).toHaveLength(4);

    const status = await run({ args: ["status"] });
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/case_law\s+case_law_v6\s+retiring\s+q09/u);
    expect(status.out).toMatch(/case_law\s+case_law_v7\s+serving\s+q09/u);
    expect(status.out).toContain("legislation: no generation serves");
  });

  test("a retiring or retired target is refused and the registry is untouched", async () => {
    const engine = engineWith([
      ...createdIndexes("case_law_v6"),
      ...createdIndexes("case_law_v7"),
    ]);
    for (const generation of ["case_law_v6", "case_law_v7"]) {
      // db-await-in-loop: two fixture steps that must run in order
      await run({ args: caseLaw("register", generation, "--apply") });
      // db-await-in-loop: two fixture steps that must run in order
      await run({ args: caseLaw("serve", generation, "--apply"), engine });
    }
    expect(await statusOf("case_law_v6")).toBe("retiring");

    const retiring = await run({
      args: caseLaw("serve", "case_law_v6", "--apply"),
      engine,
    });
    expect(retiring.code).toBe(1);
    expect(retiring.err).toContain("refused (CorpusGenerationRetiringError)");

    await db
      .update(corpusIndexGenerations)
      .set({ status: "retired" })
      .where(
        and(
          eq(corpusIndexGenerations.family, "case_law"),
          eq(corpusIndexGenerations.generation, "case_law_v6"),
        ),
      );
    const before = await registryRows();
    const auditBefore = await auditCounts();
    for (const args of [
      caseLaw("serve", "case_law_v6", "--apply"),
      caseLaw("register", "case_law_v6", "--apply"),
    ]) {
      // db-await-in-loop: each refusal is checked against the same registry
      const refused = await run({ args, engine });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain("refused (CorpusGenerationRetiredError)");
    }
    expect(await registryRows()).toEqual(before);
    expect(await auditCounts()).toEqual(auditBefore);
  });

  test("a target whose indexes are missing or empty on the search endpoint is refused", async () => {
    await run({ args: caseLaw("register", "case_law_v7", "--apply") });
    const before = await registryRows();

    const missingGroup = engineWith(
      createdIndexes("case_law_v7").filter(
        (indexId) => indexId !== "case_law_v7_pol",
      ),
    );
    const missing = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine: missingGroup,
    });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain(
      "refused (CorpusGenerationIndexMissingError): Index case_law_v7_pol does not exist",
    );

    const nothingCreated = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine: engineWith([]),
    });
    expect(nothingCreated.code).toBe(1);
    expect(nothingCreated.err).toContain(
      "refused (CorpusGenerationIndexMissingError)",
    );

    const emptySet = engineWith(createdIndexes("case_law_v7"));
    for (const indexId of createdIndexes("case_law_v7")) {
      emptySet.documents.set(indexId, 0);
    }
    const empty = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine: emptySet,
    });
    expect(empty.code).toBe(1);
    expect(empty.err).toContain("refused (CorpusGenerationIndexEmptyError)");

    const noEndpoint = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine: engineWith(createdIndexes("case_law_v7")),
      searchEndpoint: null,
    });
    expect(noEndpoint.code).toBe(1);
    expect(noEndpoint.err).toContain(
      "refused (CorpusGenerationSearchEndpointMissingError)",
    );

    expect(await registryRows()).toEqual(before);
    expect(await auditCounts()).toEqual([
      { registered: 1, promoted: 0, demoted: 0 },
    ]);
  });

  test("a legislation generation is checked as a whole generation", async () => {
    await run({
      args: [
        "register",
        "--family",
        "legislation",
        "--generation",
        "legislation_v2",
        "--apply",
      ],
    });
    const engine = engineWith(["legislation_v2_*"]);
    const served = await run({
      args: [
        "serve",
        "--family",
        "legislation",
        "--generation",
        "legislation_v2",
        "--apply",
      ],
      engine,
    });
    expect(served.code).toBe(0);
    expect(engine.searched).toEqual(["legislation_v2_*"]);
    expect(await statusOf("legislation_v2")).toBe("serving");
  });

  test("an unregistered, undeclared or drifted target is refused before any change", async () => {
    const engine = engineWith(createdIndexes("case_law_v7"));
    const unregistered = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine,
    });
    expect(unregistered.code).toBe(1);
    expect(unregistered.err).toContain(
      "refused (CorpusGenerationNotRegisteredError)",
    );
    expect(engine.searched).toEqual([]);

    let opened = 0;
    const undeclared = await run({
      args: caseLaw("serve", "case_law_v99", "--apply"),
      database: async () => {
        opened += 1;
        return panic("an undeclared target must not open the database");
      },
    });
    expect(undeclared.code).toBe(1);
    expect(undeclared.err).toContain(
      "refused (CorpusGenerationUndeclaredError)",
    );
    expect(opened).toBe(0);

    await db.insert(corpusIndexGenerations).values({
      family: "case_law",
      generation: "case_law_v7",
      cluster: "q09",
      manifestDigest: "f".repeat(64),
      status: "building",
    });
    const drifted = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine,
    });
    expect(drifted.code).toBe(1);
    expect(drifted.err).toContain(
      "refused (CorpusGenerationContractMismatchError)",
    );
    expect(await statusOf("case_law_v7")).toBe("building");
  });

  test("a busy maintenance lane refuses the write after an unchanged report", async () => {
    await run({ args: caseLaw("register", "case_law_v7", "--apply") });
    const busy = await run({
      args: caseLaw("serve", "case_law_v7", "--apply"),
      engine: engineWith(createdIndexes("case_law_v7")),
      database: testDatabase({ laneBusy: true }),
    });
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("refused (CorpusGenerationLaneBusyError)");
    expect(await statusOf("case_law_v7")).toBe("building");
  });

  test("malformed command lines are refused with the usage", async () => {
    for (const args of [
      [],
      ["promote"],
      caseLaw("serve", "case_law_v7", "--apply", "--dry-run"),
      ["serve", "--family", "statutes", "--generation", "case_law_v7"],
      ["serve", "--family", "case_law"],
      caseLaw("serve", "case_law_v7", "--limit", "1"),
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
});
