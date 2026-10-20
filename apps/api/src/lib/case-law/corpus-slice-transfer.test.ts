import type { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  corpusSliceManifest,
  parseCorpusSliceManifest,
} from "@/api/lib/case-law/corpus-slice";
import { corpusSliceCensus } from "@/api/lib/case-law/corpus-slice-census";
import {
  buildCorpusSliceExport,
  CORPUS_SLICE_EXPORT_TABLES,
  importStoredCorpusSlice,
  importCorpusSlice,
  writeCorpusSliceExport,
} from "@/api/lib/case-law/corpus-slice-transfer";
import {
  exportCorpusSliceFromDatabase,
  importCorpusSliceIntoDatabase,
} from "@/api/lib/case-law/corpus-slice-transfer-execution";
import type {
  CaseLawIngestionHandle,
  CaseLawRootHandle,
} from "@/api/lib/case-law/maintenance-lane";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { parseExportCorpusSliceArguments } from "@/api/scripts/export-corpus-slice-plan";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const testState = createTestState({ file: import.meta.path, config: {} });
setDefaultTimeout(120_000);
testState.setEnvIfAbsent(
  "DATABASE_URL",
  "postgres://api_login:password@localhost:5432/stella",
);
testState.setEnvIfAbsent("S3_ENDPOINT", "http://localhost:9000");
testState.setEnvIfAbsent("S3_BUCKET", "test-bucket");
testState.setEnvIfAbsent("S3_REGION", "test-region");

const decisionId = createSafeId<"caseLawDecision">();
const sourceId = createSafeId<"caseLawSource">();
const manifest = corpusSliceManifest(
  [
    {
      id: decisionId,
      sourceKey: "example",
      court: "Example Court",
      decisionDate: "2026-01-01",
    },
  ],
  new Date("2026-10-20T00:00:00.000Z"),
);

const exported = buildCorpusSliceExport({
  manifest,
  sources: [{ id: sourceId, adapterKey: "example" }],
  decisions: [
    {
      id: decisionId,
      sourceId,
      textS3Key: "case-law/example/text.json",
    },
  ],
  supplements: [],
  citations: [],
});

test("export reads only the public case-law table allowlist", () => {
  expect(CORPUS_SLICE_EXPORT_TABLES).toEqual([
    "case_law_sources",
    "case_law_decisions",
    "case_law_decision_supplements",
    "case_law_citations",
  ]);
});

test("export has no object-copy or arbitrary-bucket mode", () => {
  expect(
    parseExportCorpusSliceArguments([
      "round-4",
      "--copy-objects",
      "--target-bucket",
      "another-bucket",
    ]).isErr(),
  ).toBe(true);
});

test("slice import is a fixed point and removes decisions absent from the manifest", async () => {
  const held = new Set<unknown>(["obsolete"]);
  const importOnce = async () =>
    await importCorpusSlice(exported.manifest, exported.shards, {
      upsertAndRecordProjectionDesiredState: async (table, rows, ids) => {
        if (table !== "decisions") {
          return { changed: 0, projectionsEnqueued: ids.size };
        }
        let changed = 0;
        for (const row of rows) {
          if (!held.has(row["id"])) {
            held.add(row["id"]);
            changed += 1;
          }
        }
        return { changed, projectionsEnqueued: ids.size };
      },
      removeDecisionsExceptAndRecordProjectionDesiredState: async (ids) => {
        let removed = 0;
        for (const id of held) {
          if (!ids.has(id)) {
            held.delete(id);
            removed += 1;
          }
        }
        return {
          removedIds: Array.from({ length: removed }, () => "obsolete"),
          projectionsEnqueued: ids.size + removed,
        };
      },
    });

  expect(await importOnce()).toMatchObject({
    value: { changed: 1, removed: 1, projectionsEnqueued: 4 },
  });
  expect(await importOnce()).toMatchObject({
    value: { changed: 0, removed: 0, projectionsEnqueued: 3 },
  });
  expect(held).toEqual(new Set([decisionId]));
});

test("a tampered shard is refused before any write", async () => {
  let writes = 0;
  const decisions = exported.shards.find(({ name }) => name === "decisions");
  expect(decisions).toBeDefined();
  const result = await importCorpusSlice(
    exported.manifest,
    exported.shards.map((shard) =>
      shard.name === "decisions"
        ? { ...shard, ndjson: `${shard.ndjson} ` }
        : shard,
    ),
    {
      upsertAndRecordProjectionDesiredState: async () => {
        writes += 1;
        return { changed: 0, projectionsEnqueued: 0 };
      },
      removeDecisionsExceptAndRecordProjectionDesiredState: async () => ({
        removedIds: [],
        projectionsEnqueued: 0,
      }),
    },
  );
  expect(result.isErr()).toBe(true);
  expect(writes).toBe(0);
});

test("stored transfer verifies every shard before opening the write path", async () => {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    read: async (key: string) => objects.get(key) ?? null,
    write: async (key: string, bytes: Uint8Array) => {
      objects.set(key, bytes);
    },
  };
  await writeCorpusSliceExport("round-3", exported, storage);
  const shardKey = "round-3/decisions.ndjson";
  objects.set(shardKey, new TextEncoder().encode("tampered"));
  let writes = 0;
  const result = await importStoredCorpusSlice("round-3", storage, {
    upsertAndRecordProjectionDesiredState: async () => {
      writes += 1;
      return { changed: 0, projectionsEnqueued: 0 };
    },
    removeDecisionsExceptAndRecordProjectionDesiredState: async () => ({
      removedIds: [],
      projectionsEnqueued: 0,
    }),
  });
  expect(result.isErr()).toBe(true);
  expect(writes).toBe(0);
});

test("an export missing a required shard is refused before any write", async () => {
  let writes = 0;
  const incompleteManifest = {
    ...exported.manifest,
    shards: exported.manifest.shards.filter(({ name }) => name !== "citations"),
  };
  const result = await importCorpusSlice(incompleteManifest, exported.shards, {
    upsertAndRecordProjectionDesiredState: async () => {
      writes += 1;
      return { changed: 0, projectionsEnqueued: 0 };
    },
    removeDecisionsExceptAndRecordProjectionDesiredState: async () => ({
      removedIds: [],
      projectionsEnqueued: 0,
    }),
  });
  expect(result.isErr()).toBe(true);
  expect(writes).toBe(0);
});

test("object shards exclude keys from supplements outside the slice", () => {
  const slice = buildCorpusSliceExport({
    manifest,
    sources: [{ id: sourceId }],
    decisions: [{ id: decisionId, sourceId }],
    supplements: [
      { decisionId, textS3Key: "included.json" },
      { decisionId: "excluded", textS3Key: "excluded.json" },
    ],
    citations: [],
  });
  expect(slice.shards.find(({ name }) => name === "objects")?.ndjson).toBe(
    JSON.stringify({ key: "included.json" }),
  );
});

describe("the database-to-database corpus slice transfer", () => {
  const includedId = createSafeId<"caseLawDecision">();
  const excludedId = createSafeId<"caseLawDecision">();
  const staleId = createSafeId<"caseLawDecision">();
  const transferSourceId = createSafeId<"caseLawSource">();
  const staleSourceId = createSafeId<"caseLawSource">();
  const objectKeys = [
    "case-law/test/raw.json",
    "case-law/test/text.json",
    "case-law/test/ast.json",
  ];
  const storageObjects = new Map<string, Uint8Array>();
  const storage = {
    read: async (key: string) => storageObjects.get(key) ?? null,
    write: async (key: string, bytes: Uint8Array) => {
      storageObjects.set(key, bytes);
    },
  };
  let sourceClient: PGlite;
  let targetClient: PGlite;
  let sourceDb: ReturnType<typeof drizzle>;
  let targetDb: ReturnType<typeof drizzle>;

  const rootHandle = (
    database: ReturnType<typeof drizzle>,
    client: PGlite,
  ): CaseLawRootHandle =>
    asTestRaw<CaseLawRootHandle>({
      transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
        await database.transaction(
          async (tx) => await fn(asTestRaw<Transaction>(tx)),
        ),
      execute: async (
        query: Parameters<typeof database.execute>[0] | string,
      ) =>
        typeof query === "string"
          ? (await client.query(query)).rows
          : await database.execute(query),
    });

  const ingestionHandle =
    (database: ReturnType<typeof drizzle>): CaseLawIngestionHandle =>
    async <T>(fn: (tx: Transaction) => Promise<T>) =>
      await database.transaction(
        async (tx) => await fn(asTestRaw<Transaction>(tx)),
      );

  const decision = ({
    id,
    sourceId: decisionSourceId,
    decisionDate,
    keys,
  }: {
    id: ReturnType<typeof createSafeId<"caseLawDecision">>;
    sourceId: ReturnType<typeof createSafeId<"caseLawSource">>;
    decisionDate: string;
    keys?: readonly string[];
  }) => ({
    id,
    sourceId: decisionSourceId,
    caseNumber: id,
    country: "ZZZ",
    language: "en",
    court: "Transfer Court",
    decisionDate,
    sourceRawS3Key: keys?.at(0),
    textS3Key: keys?.at(1),
    astS3Key: keys?.at(2),
  });

  testState.beforeAll(async () => {
    [sourceClient, targetClient] = await Promise.all([
      createTestPglite(),
      createTestPglite(),
    ]);
    sourceDb = drizzle({ client: sourceClient });
    targetDb = drizzle({ client: targetClient });
    await sourceDb.insert(caseLawSources).values(
      caseLawSourceRow({
        id: transferSourceId,
        adapterKey: "transfer-source",
        name: "Transfer source",
      }),
    );
    await sourceDb.insert(caseLawDecisions).values([
      decision({
        id: includedId,
        sourceId: transferSourceId,
        decisionDate: "2026-01-01",
        keys: objectKeys,
      }),
      decision({
        id: excludedId,
        sourceId: transferSourceId,
        decisionDate: "2010-01-01",
        keys: ["excluded/raw.json", "excluded/text.json", "excluded/ast.json"],
      }),
    ]);
    await targetDb.insert(caseLawSources).values(
      caseLawSourceRow({
        id: staleSourceId,
        adapterKey: "stale-source",
        name: "Stale source",
      }),
    );
    await targetDb.insert(caseLawDecisions).values(
      decision({
        id: staleId,
        sourceId: staleSourceId,
        decisionDate: "2025-01-01",
      }),
    );
    await targetDb.insert(corpusIndexGenerations).values({
      family: "case_law",
      generation: "case_law_v5",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v5,
      ),
      status: "building",
    });
  });

  afterAll(async () => {
    await Promise.all([sourceClient.close(), targetClient.close()]);
  });

  test("a projection failure rolls its batch back and a retry can converge", async () => {
    await exportCorpusSliceFromDatabase({
      database: rootHandle(sourceDb, sourceClient),
      storage,
      prefix: "round-4",
      asOf: new Date("2026-10-20T00:00:00.000Z"),
      batchSize: 1,
    });
    expect(
      await rejectionOf(
        importCorpusSliceIntoDatabase({
          prefix: "round-4",
          storage,
          ingestionDatabase: ingestionHandle(targetDb),
          reconcileProjection: async () => {
            throw new Error("injected projection failure");
          },
        }),
      ),
    ).toMatchObject({ message: "injected projection failure" });
    expect(
      await targetDb.select({ id: caseLawSources.id }).from(caseLawSources),
    ).toEqual([{ id: staleSourceId }, { id: transferSourceId }]);
    expect(
      await targetDb.select({ id: caseLawDecisions.id }).from(caseLawDecisions),
    ).toEqual([{ id: staleId }]);
  });

  test("real execution transfers a complete fixed point and verifies object keys", async () => {
    await exportCorpusSliceFromDatabase({
      database: rootHandle(sourceDb, sourceClient),
      storage,
      prefix: "round-4",
      asOf: new Date("2026-10-20T00:00:00.000Z"),
      batchSize: 1,
    });

    const objectBytes = storageObjects.get("round-4/objects.ndjson");
    expect(objectBytes).toBeDefined();
    expect(new TextDecoder().decode(objectBytes).split("\n")).toEqual(
      objectKeys.toSorted().map((key) => JSON.stringify({ key })),
    );

    const first = await importCorpusSliceIntoDatabase({
      prefix: "round-4",
      storage,
      ingestionDatabase: ingestionHandle(targetDb),
    });
    expect(first).toMatchObject({ value: { removed: 1 } });
    const manifestBytes = storageObjects.get("round-4/manifest.json");
    expect(manifestBytes).toBeDefined();
    const envelope = v.parse(
      v.object({ corpus: v.unknown() }),
      JSON.parse(new TextDecoder().decode(manifestBytes)),
    );
    const parsedManifest = parseCorpusSliceManifest(envelope.corpus);
    expect(parsedManifest.isOk()).toBe(true);
    if (parsedManifest.isErr()) {
      throw parsedManifest.error;
    }
    const readTarget = async <T>(
      read: (tx: Pick<typeof targetDb, "select">) => Promise<T>,
    ): Promise<T> =>
      await withPublicLawReaderRole(targetDb, async (tx) => await read(tx));
    expect(
      await corpusSliceCensus(parsedManifest.value, readTarget),
    ).toMatchObject({ verdict: "complete" });
    expect(
      await targetDb.select({ id: caseLawDecisions.id }).from(caseLawDecisions),
    ).toEqual([{ id: includedId }]);
    expect(
      await targetDb
        .select({
          entityId: corpusIndexProjectionStates.entityId,
          desiredAction: corpusIndexProjectionStates.desiredAction,
        })
        .from(corpusIndexProjectionStates),
    ).toEqual(
      expect.arrayContaining([
        { entityId: includedId, desiredAction: "erase" },
        { entityId: staleId, desiredAction: "erase" },
      ]),
    );

    expect(
      await importCorpusSliceIntoDatabase({
        prefix: "round-4",
        storage,
        ingestionDatabase: ingestionHandle(targetDb),
      }),
    ).toMatchObject({
      value: { changed: 0, removed: 0 },
    });
  }, 120_000);

  test("a tampered stored shard is refused without a database write", async () => {
    const shardKey = "round-4/decisions.ndjson";
    expect(storageObjects.get(shardKey)).toBeDefined();
    const original = storageObjects.get(shardKey) ?? new Uint8Array();
    storageObjects.set(shardKey, new TextEncoder().encode("tampered"));
    const before = await targetDb
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions);
    const result = await importCorpusSliceIntoDatabase({
      prefix: "round-4",
      storage,
      ingestionDatabase: ingestionHandle(targetDb),
      reconcileProjection: async () => undefined,
    });
    expect(result.isErr()).toBe(true);
    expect(
      await targetDb.select({ id: caseLawDecisions.id }).from(caseLawDecisions),
    ).toEqual(before);
    storageObjects.set(shardKey, original);
  });
});
