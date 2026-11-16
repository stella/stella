import { panic, Result } from "better-result";
import type { TransactionSQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { waitForExternalState } from "@stll/property-testing/external-state";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";
import { dbClock } from "@stll/test-kit/db";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigFromManifest,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { proveCorpusProjectionRevisionsPresent } from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  buildCorpusProjectionRouteOffline,
  type CorpusProjectionOfflineBuildOutcome,
  type CorpusProjectionOfflineDelivery,
  type CorpusProjectionOfflineDeliveryOutcome,
} from "@/api/lib/legal-search/corpus-index-projection-offline-build";
import {
  CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  type CorpusProjectionOfflineBuildPolicy,
  planCorpusProjectionOfflineBuild,
} from "@/api/lib/legal-search/corpus-index-projection-offline-plan";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { corpusProjectionLegacyFixture } from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The offline route build end to end against the engine: real projection
 * rows, the real offline indexer run in the engine node's container under the
 * job contract a batch runner follows (one file per shard under a name never
 * reused, one indexer identity per slot, refused once its kill deadline has
 * passed, killed at it otherwise), and the product's census deciding every
 * revision. One shard is killed at its deadline while its publish waits on the
 * metastore, so the kill lands with the publish in flight; its documents must
 * end either fully searchable and applied, or absent and withdrawn, and a
 * later run must deliver what was withdrawn.
 *
 * The suite runner starts the engine on a Postgres metastore; the suite holds
 * the index row the publish locks (`FOR NO KEY UPDATE`, as the indexer
 * contract suite does) to freeze the run at its publish.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const TARGET = { family: "legislation", generation: "legislation_v2" } as const;
const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-0000000008f3",
);
const ENTITIES = 4;
const SHARD_REVISIONS = 2;

/** Beside the node's data directory, in one any image user can write. */
const OFFLINE_ROOT = "/tmp/offline-build";
const INPUT_DIR = `${OFFLINE_ROOT}/input`;
const EXEC_TIMEOUT_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 600_000;
const SIGKILL_EXIT = 128 + 9;
const PUBLISH_INDEX_LOCK = /FROM indexes WHERE index_id = \$1 FOR UPDATE/iu;

const POLICY = {
  slots: 1,
  ingestBytesPerSecond:
    CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  maxShardBytes: CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  maxShardRevisions: SHARD_REVISIONS,
  fillWindowMs: 60_000,
  closeAllowanceMs: 30_000,
  proofAllowanceMs: 60_000,
  payloadReadConcurrency: 2,
  retryDelayMs: 1000,
  payloadRetryLimit: 3,
} satisfies CorpusProjectionOfflineBuildPolicy;
const PLAN = planCorpusProjectionOfflineBuild(MANIFEST, POLICY);
const RUN_MS = PLAN.stopReservingBeforeMs + 60 * 60_000;

const client = getCorpusIndexClient("q09");

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;

let pglite: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let shardDirectory: string;
/** The virtual offset of the run's clock from the database's. */
let offsetMs = 0;

const { installProjectionDdl } = corpusProjectionLegacyFixture(() => db);

const engineContainer = () =>
  process.env["STELLA_CORPUS_ENGINE_TEST_CONTAINER"] ??
  panic("The suite runner names the engine container");

type ExecOutcome = { exitCode: number; stdout: string; stderr: string };

const engineExec = async ({
  args,
  env = {},
  stdin,
  timeoutMs = EXEC_TIMEOUT_MS,
}: {
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs?: number;
}): Promise<ExecOutcome> => {
  const child = Bun.spawn({
    cmd: [
      "docker",
      "exec",
      ...(stdin === undefined ? [] : ["--interactive"]),
      ...Object.entries(env).flatMap(([name, value]) => [
        "--env",
        `${name}=${value}`,
      ]),
      engineContainer(),
      ...args,
    ],
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode: childExitStatus(child), stdout, stderr };
};

const engineExecOk = async (options: Parameters<typeof engineExec>[0]) => {
  const outcome = await engineExec(options);
  if (outcome.exitCode !== 0) {
    panic(
      `${options.args.join(" ")} exited ${String(outcome.exitCode)}: ${outcome.stderr}`,
    );
  }
  return outcome.stdout;
};

const metastoreUrl = process.env["STELLA_CORPUS_METASTORE_TEST_URL"];
const metastoreFixture =
  runEngineTests && metastoreUrl !== undefined
    ? openGatedTestDatabase(metastoreUrl, { max: 2 })
    : undefined;
const metastore = () =>
  metastoreFixture?.sql ?? panic("The suite runner names the metastore");

/** Hold the index row a publish locks, until released. */
const holdPublish = async (indexId: string) => {
  const held = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const transaction = metastore().begin(async (tx: TransactionSQL) => {
    const rows =
      await tx`SELECT index_uid FROM indexes WHERE index_id = ${indexId} FOR NO KEY UPDATE`;
    if (rows.length !== 1) {
      panic(`expected to lock one index row, locked ${String(rows.length)}`);
    }
    held.resolve(undefined);
    await released.promise;
  });
  await Promise.race([held.promise, transaction]);
  return {
    release: async () => {
      released.resolve(undefined);
      await transaction;
    },
  };
};

const lockWaiters = async () =>
  v
    .parse(
      v.array(v.object({ query: v.string() })),
      await metastore()`SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    )
    .map(({ query }) => query.replaceAll(/\s+/gu, " "));

const waitForLockWaiters = async (present: boolean) =>
  await waitForExternalState({
    description: present
      ? "the run's publish waits on the index row"
      : "no metastore session waits on a lock",
    intervalMs: 20,
    timeoutMs: LOCK_WAIT_TIMEOUT_MS,
    read: async () =>
      (await lockWaiters()).some((query) => PUBLISH_INDEX_LOCK.test(query)) ===
      present,
  });

/** The database clock moved ahead by the run's virtual offset. */
const now = async () => {
  const row = (
    await db.execute<{ ms: number }>(
      sql`SELECT (extract(epoch FROM ${dbClock.fromNow(offsetMs)}) * 1000)::float8 AS ms`,
    )
  ).rows.at(0);
  return new Date(row?.ms ?? panic("The database returned no clock"));
};

/** When a run ended and how long it ran, on the run's one clock. */
const endedSince = async (startedAt: Date) => {
  const endedAt = await now();
  return { endedAt, ranMs: endedAt.getTime() - startedAt.getTime() };
};

/** The token every document of entity `serial` carries. */
const marker = (serial: number) => `offlinebuild${String(serial)}`;

/** Seed `count` legislation documents and their pending projection states. */
const seedEntities = async (count: number) => {
  const rows = Array.from({ length: count }, (_, serial) => ({
    id: toSafeId<"legislationDocument">(
      `0198e331-e578-7000-8003-${String(serial + 1).padStart(12, "0")}`,
    ),
    sourceId: SOURCE_ID,
    eli: `eli/cz/sb/2019/${String(serial + 1)}`,
    title: `Zákon ${String(serial + 1)}/2019 Sb.`,
    country: "CZE",
    language: "cs",
    documentType: "act",
    status: "current",
    effectiveDate: "2019-01-01",
    versionValidFrom: "2019-01-01",
    versionValidTo: null,
    contentHash: "e".repeat(64),
    textS3Key: `test-corpus/offline-build-engine/${String(serial + 1)}`,
    projectionEpoch: 1n,
  }));
  await db.insert(legislationDocuments).values(rows);
  await db.insert(corpusIndexProjectionStates).values(
    rows.map((row) => {
      const descriptor = deriveCorpusIndexProjectionDescriptor(
        MANIFEST,
        legislationProjectionInputFromCanonical({
          documentId: row.id,
          sourceId: row.sourceId,
          jurisdiction: row.country,
          language: row.language,
          documentType: row.documentType,
          contentHash: row.contentHash,
          title: row.title,
          status: row.status,
          effectiveDate: row.effectiveDate,
          versionValidFrom: row.versionValidFrom,
          versionValidTo: row.versionValidTo,
          eli: row.eli,
          sourceDescriptor: null,
          ...EFFECTIVE_CONSOLIDATION,
        }),
      );
      if (descriptor.action !== "upsert") {
        return panic("Seeded legislation row is not projectable");
      }
      return {
        ...TARGET,
        entityId: String(row.id),
        desiredAction: "upsert" as const,
        desiredEpoch: 1n,
        desiredFingerprint: descriptor.fingerprint,
        desiredIndexId: descriptor.indexId,
      };
    }),
  );
  return rows.map(({ id }) => String(id));
};

const readIntents = async (entityIds: readonly string[]) =>
  await db
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      status: corpusIndexProjectionIntents.status,
      expectedDocumentCount: corpusIndexProjectionIntents.expectedDocumentCount,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.entityId, [...entityIds]));

/** The revisions of a shard file, in file order, once each. */
const revisionsOf = (ndjson: string): ProjectionRevision[] => [
  ...new Set(
    ndjson
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line);
        const revision =
          typeof parsed === "object" && parsed !== null
            ? Reflect.get(parsed, "projection_revision")
            : undefined;
        return typeof revision === "string"
          ? toSafeId<"corpusIndexProjectionIntent">(revision)
          : panic("A shard line has no projection revision");
      }),
  ),
];

type Scenario = "ingest" | "kill_with_publish_in_flight";

type DeliveredShard = {
  scenario: Scenario;
  revisions: ProjectionRevision[];
  outcome: CorpusProjectionOfflineDeliveryOutcome;
};

/**
 * The batch runner's side of the job contract, against the engine's own
 * container: the file is written under its shard name, a job whose kill
 * budget is spent by then is refused, and the indexer runs under the slot's
 * identity, killed by `timeout -s KILL` when the budget left runs out. In the kill scenario
 * the publish is held on its index row until the deadline has come, the
 * indexer is killed there, and only then is the row released.
 */
const engineDelivery =
  (
    scenarios: Scenario[],
    delivered: DeliveredShard[],
  ): CorpusProjectionOfflineDelivery =>
  async (shard) => {
    // The kill budget runs from the hand-off on this side's own clock.
    const receivedAtMs = (await now()).getTime();
    const scenario = scenarios.shift() ?? "ingest";
    const ndjson = await readFile(shard.path, "utf-8");
    const revisions = revisionsOf(ndjson);
    const inputPath = `${INPUT_DIR}/${shard.name}.ndjson`;
    await engineExecOk({
      args: [
        "sh",
        "-c",
        'mkdir -p "$(dirname "$1")" && cat > "$1"',
        "write",
        inputPath,
      ],
      stdin: ndjson,
    });
    const startedAt = await now();
    const remainingMs =
      shard.killAfterMs - (startedAt.getTime() - receivedAtMs);
    if (remainingMs <= 0) {
      const outcome = {
        type: "deadline_passed",
        refusedAt: startedAt,
      } as const;
      delivered.push({ scenario, revisions, outcome });
      return outcome;
    }
    const nodeId = `offline-build-slot-${String(shard.slot)}`;
    const dataDir = `${OFFLINE_ROOT}/${nodeId}`;
    const pidFile = `${dataDir}.pid`;
    const killAfterSecs = Math.ceil(remainingMs / 1000);
    const hold =
      scenario === "kill_with_publish_in_flight"
        ? await holdPublish(shard.indexId)
        : null;
    const exited = engineExec({
      args: [
        "sh",
        "-c",
        'mkdir -p "$QW_DATA_DIR" && exec timeout -s KILL "$1" sh -c \'echo $$ > "$0" && exec quickwit tool local-ingest --index "$1" --input-path "$2"\' "$2" "$3" "$4"',
        "offline-build",
        String(killAfterSecs),
        pidFile,
        shard.indexId,
        inputPath,
      ],
      env: { QW_DATA_DIR: dataDir, QW_NODE_ID: nodeId },
      timeoutMs: (killAfterSecs + 30) * 1000, // timeout: the shard's own kill deadline plus 30 s for the engine exec to return
    });
    if (hold !== null) {
      let killed: Awaited<typeof exited>;
      try {
        await waitForLockWaiters(true);
        // The deadline arrives while the publish waits: the run is killed
        // there.
        offsetMs += Math.max(
          0,
          shard.killDeadline.getTime() - (await now()).getTime(),
        );
        await engineExecOk({
          args: ["sh", "-c", 'kill -KILL "$(cat "$1")"', "kill", pidFile],
        });
        killed = await exited;
        expect(killed.exitCode).toBe(SIGKILL_EXIT);
      } finally {
        // Released on a failed step too, so the suite's teardown never waits
        // on the open transaction.
        await hold.release();
      }
      await waitForLockWaiters(false);
      const outcome = {
        type: "killed_at_deadline",
        exitCode: killed.exitCode,
        startedAt,
        ...(await endedSince(startedAt)),
      } as const;
      delivered.push({ scenario, revisions, outcome });
      return outcome;
    }
    const { exitCode, stderr } = await exited;
    const { endedAt, ranMs } = await endedSince(startedAt);
    const outcome: CorpusProjectionOfflineDeliveryOutcome =
      exitCode === 0
        ? { type: "ingested", exitCode: 0, startedAt, endedAt, ranMs }
        : {
            type: "failed",
            exitCode,
            // A shell that could not launch the indexer exits 126 or 127.
            cause:
              exitCode === 126 || exitCode === 127
                ? "infrastructure"
                : "indexer",
            startedAt,
            endedAt,
            ranMs,
          };
    if (exitCode !== 0) {
      process.stderr.write(
        `offline indexer exited ${String(exitCode)}: ${stderr}\n`,
      );
    }
    delivered.push({ scenario, revisions, outcome });
    return outcome;
  };

const runBuild = async (
  indexId: string,
  scenarios: Scenario[],
  delivered: DeliveredShard[],
  markerOf: ReadonlyMap<string, number>,
): Promise<CorpusProjectionOfflineBuildOutcome> => {
  let lockHeld = false;
  return await buildCorpusProjectionRouteOffline({
    runInTransaction: async (operation) =>
      await db.transaction(
        async (tx) => await operation(asTestRaw<Transaction>(tx)),
      ),
    client,
    ...TARGET,
    indexId,
    runId: "engine",
    shardDirectory,
    deadline: new Date((await now()).getTime() + RUN_MS),
    policy: POLICY,
    deliver: engineDelivery(scenarios, delivered),
    lock: {
      tryAcquire: async () => {
        if (lockHeld) {
          return null;
        }
        lockHeld = true;
        return {
          stillHeld: async () => lockHeld,
          release: async () => {
            lockHeld = false;
          },
        };
      },
    },
    admit: async (_unit, work) => await work(),
    resumeAfter: null,
    testing: {
      clock: now,
      sleep: async (milliseconds) => {
        offsetMs += milliseconds;
      },
      payloadReader: async (_runInTransaction, material) => {
        const serial =
          markerOf.get(material.lease.entityId) ??
          panic(`No marker for ${material.lease.entityId}`);
        return Result.ok({
          text: `Art. 1. Tento zákon upravuje ${marker(serial)} a jeho použití.`,
          ast: null,
        });
      },
    },
  });
};

/** Documents of a revision the engine's census sees, and its search hits. */
const observed = async (
  indexId: string,
  revision: ProjectionRevision,
  documentCount: number,
) => {
  const proof = (
    await proveCorpusProjectionRevisionsPresent({
      client,
      indexId,
      expected: [{ revision, documentCount }],
    })
  ).unwrap();
  return (
    proof.unproven.at(0)?.observedDocumentCount ??
    (proof.proofs.length === 1 ? documentCount : panic("No census verdict"))
  );
};

const searchHits = async (indexId: string, query: string) =>
  (
    await client.search({ observer: "unobserved", indexId, query, maxHits: 0 })
  ).unwrap().numHits;

describe.skipIf(!runEngineTests)(
  "an offline route build against the engine",
  () => {
    let entityIds: string[] = [];
    let indexId = "";

    // timeout: builds a PGlite schema and creates the route's index in the engine.
    beforeAll(async () => {
      pglite = await createTestPglite();
      db = drizzle({ client: pglite });
      await installProjectionDdl(true);
      await db.insert(corpusIndexGenerations).values({
        ...TARGET,
        cluster: "q09",
        manifestDigest: corpusIndexManifestDigest(MANIFEST),
        status: "building",
      });
      await db.insert(legislationSources).values({
        id: SOURCE_ID,
        adapterKey: "projection-offline-build-engine-test",
        name: "Projection offline build engine test",
      });
      entityIds = await seedEntities(ENTITIES);
      const [state] = await db
        .select({ indexId: corpusIndexProjectionStates.desiredIndexId })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, entityIds[0] ?? ""));
      indexId = state?.indexId ?? panic("Seeded entity has no index");
      const config = corpusIndexConfigFromManifest(MANIFEST, indexId);
      (await client.createIndex(config, "unobserved")).unwrap();
      const attested = (
        await client.attestIndexConfig(config, "unobserved")
      ).unwrap();
      if (attested.status !== "matching") {
        panic(`index ${indexId} was not created`);
      }
      shardDirectory = await mkdtemp(path.join(tmpdir(), "offline-build-"));
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      await pglite.close();
      await rm(shardDirectory, { recursive: true, force: true });
    });

    // timeout: runs offline indexer processes in the engine container, each bounded by its kill deadline.
    test(
      "a shard killed at its deadline with its publish in flight is withdrawn with nothing visible, and the next run delivers exactly its entities",
      async () => {
        const markerOf = new Map(
          entityIds.map((entityId, serial) => [entityId, serial]),
        );
        const delivered: DeliveredShard[] = [];
        const first = await runBuild(
          indexId,
          ["kill_with_publish_in_flight"],
          delivered,
          markerOf,
        );
        const killed =
          delivered.find(
            ({ scenario }) => scenario === "kill_with_publish_in_flight",
          ) ?? panic("No shard was killed");
        expect(killed.outcome.type).toBe("killed_at_deadline");
        expect(killed.revisions.length).toBe(SHARD_REVISIONS);
        // A shard this small killed leaves no smaller cap: the run stops,
        // typed, and charges nobody.
        expect(first.status).toBe("rate_too_slow");
        expect(first.progress.shards.killedTooLarge).toBe(1);

        // The publish never committed: every killed revision is withdrawn,
        // and nothing of it is in the index or searchable.
        const afterKill = await readIntents(entityIds);
        const killedEntities = new Set<string>();
        for (const revision of killed.revisions) {
          const intent =
            afterKill.find(({ id }) => id === revision) ??
            panic(`No row for killed revision ${revision}`);
          killedEntities.add(intent.entityId);
          expect(intent.status).toBe("withdrawn");
          const expected =
            intent.expectedDocumentCount ?? panic("Started without a count");
          expect(await observed(indexId, revision, expected)).toBe(0);
          const serial =
            markerOf.get(intent.entityId) ?? panic("No marker for the entity");
          expect(await searchHits(indexId, `text:${marker(serial)}`)).toBe(0);
        }

        // The next run delivers the killed entities again, each alone after
        // the halving, and every entity becomes searchable.
        offsetMs += PLAN.leaseMs + PLAN.endedAfterMs;
        const second = await runBuild(indexId, [], delivered, markerOf);
        expect(second.status).toBe("drained");
        const intents = await readIntents(entityIds);
        for (const [serial, entityId] of entityIds.entries()) {
          const applied = intents.filter(
            (intent) =>
              intent.entityId === entityId && intent.status === "applied",
          );
          expect(applied.length).toBe(1);
          const [intent] = applied;
          const appliedId = intent?.id ?? panic("No applied revision");
          const expected =
            intent?.expectedDocumentCount ?? panic("Applied without a count");
          expect(await observed(indexId, appliedId, expected)).toBe(expected);
          expect(await searchHits(indexId, `text:${marker(serial)}`)).toBe(
            expected,
          );
          if (killedEntities.has(entityId)) {
            expect(killed.revisions).not.toContain(appliedId);
            const carrier =
              delivered.find(({ revisions }) =>
                revisions.includes(appliedId),
              ) ?? panic("The applied revision was never delivered");
            expect(carrier.outcome.type).toBe("ingested");
            expect(carrier.revisions).toEqual([appliedId]);
          }
        }
        // Nothing went to cleanup: every revision ended exact or empty.
        expect(
          intents.filter(
            ({ status }) => status !== "applied" && status !== "withdrawn",
          ),
        ).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
