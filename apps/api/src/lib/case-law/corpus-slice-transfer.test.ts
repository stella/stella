import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
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
import { parseExportCorpusSliceArguments } from "@/api/scripts/export-corpus-slice-plan";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

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
      upsert: async (table, rows) => {
        if (table !== "decisions") {
          return 0;
        }
        let changed = 0;
        for (const row of rows) {
          if (!held.has(row["id"])) {
            held.add(row["id"]);
            changed += 1;
          }
        }
        return changed;
      },
      removeDecisionsExcept: async (ids) => {
        let removed = 0;
        for (const id of held) {
          if (!ids.has(id)) {
            held.delete(id);
            removed += 1;
          }
        }
        return removed;
      },
      enqueueProjectionDesiredState: async (ids) => ids.size,
    });

  expect(await importOnce()).toMatchObject({
    value: { changed: 1, removed: 1, projectionsEnqueued: 1 },
  });
  expect(await importOnce()).toMatchObject({
    value: { changed: 0, removed: 0, projectionsEnqueued: 0 },
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
      upsert: async () => {
        writes += 1;
        return 0;
      },
      removeDecisionsExcept: async () => 0,
      enqueueProjectionDesiredState: async () => 0,
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
    upsert: async () => {
      writes += 1;
      return 0;
    },
    removeDecisionsExcept: async () => 0,
    enqueueProjectionDesiredState: async () => 0,
  });
  expect(result.isErr()).toBe(true);
  expect(writes).toBe(0);
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

  beforeAll(async () => {
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
  }, 120_000);

  afterAll(async () => {
    await Promise.all([sourceClient.close(), targetClient.close()]);
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
      database: rootHandle(targetDb, targetClient),
      ingestionDatabase: ingestionHandle(targetDb),
      reconcileProjection: async () => undefined,
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
      await importCorpusSliceIntoDatabase({
        prefix: "round-4",
        storage,
        database: rootHandle(targetDb, targetClient),
        ingestionDatabase: ingestionHandle(targetDb),
        reconcileProjection: async () => undefined,
      }),
    ).toMatchObject({
      value: { changed: 0, removed: 0, projectionsEnqueued: 0 },
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
      database: rootHandle(targetDb, targetClient),
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
