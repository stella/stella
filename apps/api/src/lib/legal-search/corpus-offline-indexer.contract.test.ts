import { panic, Result, TaggedError } from "better-result";
import type { TransactionSQL } from "bun";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import * as v from "valibot";

import { US_COURTS } from "@stll/api-contract/us-courts";
import { isPathInside } from "@stll/portable-path";
import { waitForExternalState } from "@stll/property-testing/external-state";
import { childExitStatus } from "@stll/scripts/src/child-exit-status";
import type { Temporal } from "@stll/time";

import { envBase } from "@/api/env-base";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import type { CorpusIndexConfig } from "@/api/lib/legal-search/corpus-index-config";
import { resolveCorpusIndexGroupContract } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexConfigWithId,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  buildCaseLawProjectionDocuments,
  buildLegislationV2ProjectionDocuments,
} from "@/api/lib/legal-search/corpus-index-projection-builder";
import {
  type CorpusProjectionCleanupSettlementLease,
  CorpusProjectionCleanupSettlementProof,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
  deleteCorpusProjectionRevisions,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

/**
 * The engine facts a batch build with the engine's offline indexer
 * (`quickwit tool local-ingest`) relies on, pinned against the engine itself.
 *
 * The suite runner starts this file's engine node on a Postgres metastore
 * (`CORPUS_ENGINE_METASTORE.postgres`). Every offline indexer runs inside the
 * node's container, as a co-located process with a data directory and node id
 * of its own, against the same metastore and index storage. The suite reaches
 * the metastore directly only to hold one of its row locks, which freezes an
 * indexer at a chosen point (before staging, before publishing, before a merge
 * publishes) so a SIGKILL lands there deterministically. Every count is read
 * through the product's own client, census, delete and settlement code.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

/** The image's `QW_DATA_DIR`: the running node's data directory. */
const NODE_DATA_DIR = "/quickwit/qwdata";
/**
 * Data directories, pid files and inputs of the offline indexers: beside the
 * node's, in a directory any image user can write.
 */
const OFFLINE_ROOT = "/tmp/offline-indexer";
const INPUT_DIR = `${OFFLINE_ROOT}/input`;
/** Engine-side kill bound on every offline run, as the batch design has it. */
const OFFLINE_RUN_KILL_AFTER_SECS = 180;
const OFFLINE_RUN_TIMEOUT_MS = (OFFLINE_RUN_KILL_AFTER_SECS + 30) * 1000;
const EXEC_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 90_000;
/** The engine's delete pipeline polls for work about once a minute. */
const DELETE_SETTLE_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 600_000;
const SIGKILL_EXIT = 128 + 9;
const INGEST_CLI_SOURCE = "_ingest-cli-source";
const REST_INGEST_SOURCE = "_ingest-source";
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000a1";

const client = getCorpusIndexClient("q09");

type ProjectionRevision = SafeId<"corpusIndexProjectionIntent">;
type RevisionCount = { revision: ProjectionRevision; documentCount: number };

/** One NDJSON input: its lines and each revision's document count, in file order. */
type InputFile = {
  ndjson: string;
  revisions: RevisionCount[];
  documentCount: number;
};

const newRevision = () =>
  toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7());

const inputFile = (
  documentsByRevision: readonly {
    revision: ProjectionRevision;
    documents: readonly Record<string, unknown>[];
  }[],
): InputFile => {
  const lines = documentsByRevision.flatMap(({ documents }) =>
    documents.map((document) => JSON.stringify(document)),
  );
  return {
    ndjson: `${lines.join("\n")}\n`,
    revisions: documentsByRevision.map(({ revision, documents }) => ({
      revision,
      documentCount: documents.length,
    })),
    documentCount: lines.length,
  };
};

const PARAGRAPH =
  "Sąd rozpoznał skargę kasacyjną i uznał, że zaskarżony wyrok odpowiada prawu, ponieważ organ prawidłowo ustalił stan faktyczny sprawy oraz zastosował właściwe przepisy prawa materialnego";

/** The token every passage of decision `serial` carries. */
const marker = (serial: number) => `znacznik${String(serial)}`;

type CaseLawDecisionsOptions = {
  manifest: (typeof CORPUS_INDEX_MANIFESTS)["case_law_v10"];
  jurisdiction: "POL" | "USA";
  decisions: number;
  /** Paragraphs per decision; about eight make one passage. */
  paragraphs: number;
};

const caseLawDecisions = ({
  manifest,
  jurisdiction,
  decisions,
  paragraphs,
}: CaseLawDecisionsOptions) =>
  Array.from({ length: decisions }, (_, serial) => {
    const usCourt =
      jurisdiction === "USA"
        ? (US_COURTS.at(serial % US_COURTS.length) ??
          panic("The US court directory is empty"))
        : null;
    const revision = newRevision();
    const documents = buildCaseLawProjectionDocuments({
      manifest,
      revision,
      payload: {
        text: Array.from(
          { length: paragraphs },
          (_paragraph, index) =>
            `${PARAGRAPH} ${marker(serial)} ${String(index)}.`,
        ).join("\n\n"),
        ast: null,
      },
      input: {
        family: "case_law",
        documentId: Bun.randomUUIDv7(),
        sourceId: SOURCE_ID,
        jurisdiction,
        language: jurisdiction === "USA" ? "en" : "pl",
        documentType: "judgment",
        contentHash: "a".repeat(64),
        redistributionEligible: true,
        redacted: false,
        listingOnly: false,
        provisionKeys: [],
        rankingSignals: {
          citationAuthorityBucket: serial % 4,
          languageGroupKey: null,
          languageGroupShared: false,
        },
        vacatedFrom: null,
        caseNumber: `I CSK ${String(serial + 1)}/2021`,
        identifiers: [],
        court: usCourt?.canonicalName ?? "Sąd Najwyższy",
        courtId: usCourt?.id ?? null,
        decisionDate: `2021-03-${String((serial % 28) + 1).padStart(2, "0")}`,
        ecli: null,
        metadata: null,
      },
    });
    return { revision, documents };
  });

const legislationVersions = (versions: number) =>
  Array.from({ length: versions }, (_, serial) => {
    const revision = newRevision();
    const documents = buildLegislationV2ProjectionDocuments({
      revision,
      payload: {
        text: `Art. ${String(serial + 1)}. ${PARAGRAPH} ${marker(serial)}.`,
        ast: null,
      },
      input: {
        family: "legislation",
        documentId: Bun.randomUUIDv7(),
        sourceId: SOURCE_ID,
        jurisdiction: "CZE",
        language: "cs",
        documentType: "act",
        contentHash: "b".repeat(64),
        redistributionEligible: true,
        title: `Zákon ${String(serial + 1)}/2021 Sb.`,
        status: "current",
        effectiveDate: "2021-01-01",
        versionValidFrom: "2021-01-01",
        versionValidTo: null,
        eli: `eli/cz/sb/2021/${String(serial + 1)}`,
        ...EFFECTIVE_CONSOLIDATION,
      },
    }).unwrap();
    return { revision, documents };
  });

const V10 = CORPUS_INDEX_MANIFESTS.case_law_v10;

/** The physical configuration of a real generation group, under a fresh id. */
const groupConfig = (
  manifest: Parameters<typeof resolveCorpusIndexGroupContract>[0]["manifest"],
  indexGroup: string,
): CorpusIndexConfig => {
  const contract = resolveCorpusIndexGroupContract({ manifest, indexGroup });
  return corpusIndexConfigWithId(
    contract.indexConfig,
    `offline_${indexGroup}_${Bun.randomUUIDv7().replaceAll("-", "")}`,
  );
};

const engineContainer = () =>
  process.env["STELLA_CORPUS_ENGINE_TEST_CONTAINER"] ??
  panic("The suite runner names the engine container");

const engineEndpoint = () =>
  envBase.CORPUS_INDEX_Q09_ENDPOINT ?? panic("engine endpoint is not set");

type ExecOptions = {
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs?: number;
};

type ExecOutcome = { exitCode: number; stdout: string; stderr: string };

/** A command in the engine node's container; the client is killed at the timeout. */
const engineExec = async ({
  args,
  env = {},
  stdin,
  timeoutMs = EXEC_TIMEOUT_MS,
}: ExecOptions): Promise<ExecOutcome> => {
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

const engineExecOk = async (options: ExecOptions) => {
  const outcome = await engineExec(options);
  if (outcome.exitCode !== 0) {
    panic(
      `${options.args.join(" ")} exited ${String(outcome.exitCode)}: ${outcome.stderr}`,
    );
  }
  return outcome.stdout;
};

/** Writes an input file into the node's container at a path never used before. */
const writeInput = async (
  { ndjson }: InputFile,
  inputPath = newInputPath(),
) => {
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
  return inputPath;
};

const newInputPath = () => `${INPUT_DIR}/${Bun.randomUUIDv7()}.ndjson`;

class OfflineIndexerHarnessError extends TaggedError(
  "OfflineIndexerHarnessError",
)<{ message: string }> {}

type OfflineRunSpec = {
  indexId: string;
  inputPath: string;
  nodeId: string;
  /** Its own data directory: local-ingest empties its caches on exit. */
  dataDir: string;
};

/**
 * The argv and environment that start one offline indexer. The data
 * directory goes in `QW_DATA_DIR`, because the image sets that variable and it
 * overrides a config file's `data_dir`. A directory the node owns, or one that
 * holds the node's, is refused: local-ingest empties the `indexing` and split
 * cache directories of its data directory on exit, and a node sharing them
 * loses its in-flight splits.
 */
const offlineIndexerCommand = ({
  indexId,
  inputPath,
  nodeId,
  dataDir,
}: OfflineRunSpec): Result<
  { args: string[]; env: Record<string, string>; pidFile: string },
  OfflineIndexerHarnessError
> => {
  if (
    !path.posix.isAbsolute(dataDir) ||
    path.posix.normalize(dataDir) !== dataDir
  ) {
    return Result.err(
      new OfflineIndexerHarnessError({
        message: `offline data directory must be an absolute normal path: ${dataDir}`,
      }),
    );
  }
  if (
    isPathInside(NODE_DATA_DIR, dataDir, path.posix) ||
    isPathInside(dataDir, NODE_DATA_DIR, path.posix)
  ) {
    return Result.err(
      new OfflineIndexerHarnessError({
        message: `offline data directory ${dataDir} overlaps the node's ${NODE_DATA_DIR}`,
      }),
    );
  }
  const pidFile = `${dataDir}.pid`;
  return Result.ok({
    // `timeout -s KILL` bounds the run inside the container; the inner shell
    // records the engine's own pid before it execs, so a kill reaches it.
    args: [
      "sh",
      "-c",
      'mkdir -p "$QW_DATA_DIR" && exec timeout -s KILL "$1" sh -c \'echo $$ > "$0" && exec quickwit tool local-ingest --index "$1" --input-path "$2"\' "$2" "$3" "$4"',
      "offline-indexer",
      String(OFFLINE_RUN_KILL_AFTER_SECS),
      pidFile,
      indexId,
      inputPath,
    ],
    env: { QW_DATA_DIR: dataDir, QW_NODE_ID: nodeId },
    pidFile,
  });
};

type OfflineRun = { pidFile: string; exited: Promise<ExecOutcome> };

const startOfflineIndexer = (spec: OfflineRunSpec): OfflineRun => {
  const { args, env, pidFile } = offlineIndexerCommand(spec).unwrap();
  return {
    pidFile,
    exited: engineExec({
      args,
      env,
      timeoutMs: OFFLINE_RUN_TIMEOUT_MS, // timeout: engine-side kill bound plus margin
    }),
  };
};

/** One run slot: a node id and a data directory of its own under the offline root. */
const offlineSlot = (indexId: string, inputPath: string) => {
  const nodeId = `offline-${Bun.randomUUIDv7()}`;
  return {
    indexId,
    inputPath,
    nodeId,
    dataDir: `${OFFLINE_ROOT}/${nodeId}`,
  } satisfies OfflineRunSpec;
};

const runOfflineIndexer = async (spec: OfflineRunSpec) =>
  await startOfflineIndexer(spec).exited;

/** SIGKILL to the engine process itself, never to the client that started it. */
const killOfflineIndexer = async ({ pidFile, exited }: OfflineRun) => {
  await waitForExternalState({
    description: `${pidFile} names the running indexer`,
    intervalMs: 50,
    timeoutMs: EXEC_TIMEOUT_MS,
    read: async () =>
      (await engineExec({ args: ["test", "-s", pidFile] })).exitCode === 0,
  });
  await engineExecOk({
    args: ["sh", "-c", 'kill -KILL "$(cat "$1")"', "kill", pidFile],
  });
  const outcome = await exited;
  expect(outcome.exitCode).toBe(SIGKILL_EXIT);
  return outcome;
};

const splitSchema = v.object({
  split_id: v.string(),
  split_state: v.picklist(["Staged", "Published", "MarkedForDeletion"]),
  node_id: v.string(),
  source_id: v.string(),
  partition_id: v.number(),
  num_docs: v.number(),
  num_merge_ops: v.number(),
  create_timestamp: v.number(),
  maturity: v.variant("type", [
    v.object({ type: v.literal("mature") }),
    v.object({
      type: v.literal("immature"),
      maturation_period_millis: v.number(),
    }),
  ]),
  footer_offsets: v.object({ start: v.number(), end: v.number() }),
});
type Split = v.InferOutput<typeof splitSchema>;
const splitListSchema = v.object({ splits: v.array(splitSchema) });

/** Every split the metastore holds for the index, in any state. */
const listSplits = async (indexId: string): Promise<Split[]> => {
  const response = await fetch(
    `${engineEndpoint()}/api/v1/indexes/${indexId}/splits?limit=1000&split_states=Staged,Published,MarkedForDeletion`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!response.ok) {
    return panic(`split list ${String(response.status)}`);
  }
  return v.parse(splitListSchema, await response.json()).splits;
};

const splitsOf = async (indexId: string, nodeId: string) =>
  (await listSplits(indexId)).filter((split) => split.node_id === nodeId);

const inState = (splits: readonly Split[], state: Split["split_state"]) =>
  splits.filter(({ split_state }) => split_state === state);

const publishedDocuments = (splits: readonly Split[]) =>
  inState(splits, "Published").reduce((sum, { num_docs }) => sum + num_docs, 0);

/** Documents the product's search counts in the index. */
const visibleDocuments = async (indexId: string) =>
  (
    await client.search({
      observer: "unobserved",
      indexId,
      query: "*",
      maxHits: 0,
    })
  ).unwrap().numHits;

const searchHits = async (indexId: string, query: string) =>
  (
    await client.search({ observer: "unobserved", indexId, query, maxHits: 0 })
  ).unwrap().numHits;

/** The product's exact per-revision census, 128 revisions per request. */
const census = async (indexId: string, expected: readonly RevisionCount[]) => {
  const unproven: {
    revision: ProjectionRevision;
    expectedDocumentCount: number;
    observedDocumentCount: number;
  }[] = [];
  let proven = 0;
  for (
    let offset = 0;
    offset < expected.length;
    offset += CORPUS_PROJECTION_DELETE_MAX_REVISIONS
  ) {
    const result = (
      await proveCorpusProjectionRevisionsPresent({
        client,
        indexId,
        expected: expected.slice(
          offset,
          offset + CORPUS_PROJECTION_DELETE_MAX_REVISIONS,
        ),
      })
    ).unwrap();
    proven += result.proofs.length;
    unproven.push(...result.unproven);
  }
  return { proven, unproven };
};

const expectExact = async (
  indexId: string,
  expected: readonly RevisionCount[],
) => {
  const { proven, unproven } = await census(indexId, expected);
  expect(unproven).toEqual([]);
  expect(proven).toBe(expected.length);
};

const observedCounts = async (
  indexId: string,
  expected: readonly RevisionCount[],
) => {
  const { unproven } = await census(indexId, expected);
  const observed = new Map(
    unproven.map(({ revision, observedDocumentCount }) => [
      revision,
      observedDocumentCount,
    ]),
  );
  return expected.map(
    ({ revision, documentCount }) => observed.get(revision) ?? documentCount,
  );
};

const createIndex = async (config: CorpusIndexConfig) => {
  (await client.createIndex(config, "unobserved")).unwrap();
  const attested = (
    await client.attestIndexConfig(config, "unobserved")
  ).unwrap();
  if (attested.status !== "matching") {
    return panic(`index ${config.index_id} was not created`);
  }
  return attested.indexUri;
};

/** REST ingest that publishes its own split before it answers. */
const ingestForced = async (indexId: string, { ndjson }: InputFile) => {
  const response = await fetch(
    `${engineEndpoint()}/api/v1/${indexId}/ingest?commit=force`,
    {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: ndjson,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    panic(`forced ingest ${String(response.status)}: ${await response.text()}`);
  }
};

const fileSize = async (filePath: string) =>
  Number(await engineExecOk({ args: ["stat", "-c", "%s", filePath] }));

const splitFile = (indexUri: string, splitId: string) =>
  `${new URL(indexUri).pathname}/${splitId}.split`;

const metastoreUrl = process.env["STELLA_CORPUS_METASTORE_TEST_URL"];
// Opened only where the suite runner provides the metastore; the gated
// fixture closes it after the file.
const metastoreFixture =
  runEngineTests && metastoreUrl !== undefined
    ? openGatedTestDatabase(metastoreUrl, { max: 4 })
    : undefined;
const metastore = () =>
  metastoreFixture?.sql ?? panic("The suite runner names the metastore");

/** Which engine step a held index row stops before. */
const INDEX_ROW_HOLD = {
  /** Staging inserts the split row, whose foreign key needs a key-share lock. */
  stage: "stage",
  /** Publishing locks the index row FOR UPDATE to advance its checkpoint. */
  publish: "publish",
} as const;
type IndexRowHold = (typeof INDEX_ROW_HOLD)[keyof typeof INDEX_ROW_HOLD];

type Hold = { release: () => Promise<void> };

const holdRows = async (
  lock: (transaction: TransactionSQL) => Promise<unknown[]>,
): Promise<Hold> => {
  const held = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  const transaction = metastore().begin(async (sql) => {
    const rows = await lock(sql);
    if (rows.length !== 1) {
      panic(`expected to lock one row, locked ${String(rows.length)}`);
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

const holdIndexRow = async (indexId: string, hold: IndexRowHold) => {
  switch (hold) {
    case INDEX_ROW_HOLD.stage:
      return await holdRows(
        async (sql) =>
          await sql`SELECT index_uid FROM indexes WHERE index_id = ${indexId} FOR UPDATE`,
      );
    case INDEX_ROW_HOLD.publish:
      return await holdRows(
        async (sql) =>
          await sql`SELECT index_uid FROM indexes WHERE index_id = ${indexId} FOR NO KEY UPDATE`,
      );
    default:
      hold satisfies never;
      return panic(`Unhandled hold ${String(hold)}`);
  }
};

/** A merge publish marks its inputs; a lock on one input's row holds it. */
const holdSplitRow = async (splitId: string) =>
  await holdRows(
    async (sql) =>
      await sql`SELECT split_id FROM splits WHERE split_id = ${splitId} FOR UPDATE`,
  );

const lockWaiterRowsSchema = v.array(v.object({ query: v.string() }));

/** The statement text of every metastore session waiting on a lock. */
const lockWaiters = async () =>
  v
    .parse(
      lockWaiterRowsSchema,
      await metastore()`SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    )
    .map(({ query }) => query.replaceAll(/\s+/gu, " "));

const waitForLockWaiter = async (statement: RegExp) =>
  await waitForExternalState({
    description: `a metastore session waits on a lock in ${String(statement)}`,
    intervalMs: 20,
    timeoutMs: LOCK_WAIT_TIMEOUT_MS,
    read: async () =>
      (await lockWaiters()).some((query) => statement.test(query)),
  });

/** After a release, the dead indexer's session gets the lock and ends unanswered. */
const waitForNoLockWaiters = async () =>
  await waitForExternalState({
    description: "no metastore session waits on a lock",
    intervalMs: 50,
    timeoutMs: LOCK_WAIT_TIMEOUT_MS,
    read: async () => (await lockWaiters()).length === 0,
  });

const STAGE_INSERT = /INSERT INTO splits/iu;
const PUBLISH_INDEX_LOCK = /FROM indexes WHERE index_id = \$1 FOR UPDATE/iu;

/** What local-ingest empties in its data directory on exit. */
const CACHE_DIRS = ["indexing", "indexer-split-cache"] as const;
/** A node's ingest write-ahead log and queues, beside its caches. */
const NODE_STATE_DIRS = [...CACHE_DIRS, "wal", "queues"] as const;

const dataEntries = async (
  dataDir: string,
  subdirs: readonly string[] = CACHE_DIRS,
) =>
  (
    await engineExecOk({
      args: [
        "sh",
        "-c",
        'root="$1"; shift; for d in "$@"; do [ -d "$root/$d" ] && find "$root/$d" -type f; done; true',
        "entries",
        dataDir,
        ...subdirs,
      ],
    })
  )
    .split("\n")
    .filter((line) => line.length > 0);

const leaseFor = ({
  indexId,
  generation,
  family,
  intentIds,
  task,
}: {
  indexId: string;
  generation: string;
  family: CorpusProjectionCleanupSettlementLease["family"];
  intentIds: CorpusProjectionCleanupSettlementLease["intentIds"];
  task: { opstamp: number; createdAt: Temporal.Instant };
}): CorpusProjectionCleanupSettlementLease => ({
  family,
  generation,
  indexId,
  intentIds,
  deleteOpstamp: task.opstamp,
  deleteTaskCreatedAt: task.createdAt,
  leaseToken: Bun.randomUUIDv7(),
});

const settle = async (lease: CorpusProjectionCleanupSettlementLease) => {
  const verdict = (
    await CorpusProjectionCleanupSettlementProof.verifyAll({
      client,
      indexId: lease.indexId,
      leases: [lease],
    })
  ).at(0);
  if (verdict === undefined) {
    return panic("Expected one settlement verdict");
  }
  return verdict.result.unwrap();
};

test("the offline indexer harness refuses a data directory the node owns or one that holds it", () => {
  const spec = {
    indexId: "index",
    inputPath: `${INPUT_DIR}/input.ndjson`,
    nodeId: "offline",
  };
  for (const dataDir of [
    NODE_DATA_DIR,
    `${NODE_DATA_DIR}/offline`,
    "/quickwit",
    "/",
    "offline",
    `${OFFLINE_ROOT}/../qwdata`,
  ]) {
    const command = offlineIndexerCommand({ ...spec, dataDir });
    expect(command.isErr()).toBe(true);
  }
  const accepted = offlineIndexerCommand({
    ...spec,
    dataDir: `${OFFLINE_ROOT}/slot-1`,
  }).unwrap();
  expect(accepted.env).toEqual({
    QW_DATA_DIR: `${OFFLINE_ROOT}/slot-1`,
    QW_NODE_ID: "offline",
  });
});

describe.skipIf(!runEngineTests)(
  "the offline indexer against a node sharing its Postgres metastore",
  () => {
    describe("fact 1: generation configs", () => {
      const targets = [
        {
          label: "the newest case-law generation's base group",
          config: () => groupConfig(V10, "pol"),
          file: () =>
            inputFile(
              caseLawDecisions({
                manifest: V10,
                jurisdiction: "POL",
                decisions: 40,
                paragraphs: 20,
              }),
            ),
          family: "case_law",
        },
        {
          label: "the court-partitioned US group",
          config: () => groupConfig(V10, "usa"),
          file: () =>
            inputFile(
              caseLawDecisions({
                manifest: V10,
                jurisdiction: "USA",
                decisions: 40,
                paragraphs: 10,
              }),
            ),
          family: "case_law",
        },
        {
          label: "the newest legislation generation",
          config: () =>
            groupConfig(CORPUS_INDEX_MANIFESTS.legislation_v3, "cze"),
          file: () => inputFile(legislationVersions(40)),
          family: "legislation",
        },
      ] as const;

      for (const { label, config, file } of targets) {
        // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
        test(
          `publishes strict-mode splits for ${label}, searchable through the product client`,
          async () => {
            const created = config();
            expect(created.doc_mapping.mode).toBe("strict");
            await createIndex(created);
            const input = file();
            const run = offlineSlot(created.index_id, await writeInput(input));

            expect((await runOfflineIndexer(run)).exitCode).toBe(0);

            await expectExact(created.index_id, input.revisions);
            expect(await visibleDocuments(created.index_id)).toBe(
              input.documentCount,
            );
            const first =
              input.revisions.at(0) ?? panic("Expected a first revision");
            expect(
              await searchHits(created.index_id, `text:${marker(0)}`),
            ).toBe(first.documentCount);
            const splits = await listSplits(created.index_id);
            expect(splits.length).toBeGreaterThan(0);
            for (const split of splits) {
              expect(split.split_state).toBe("Published");
              expect(split.node_id).toBe(run.nodeId);
              expect(split.source_id).toBe(INGEST_CLI_SOURCE);
            }
            const partitionKey = created.doc_mapping.partition_key ?? null;
            const partitions = new Set(
              splits.map(({ partition_id }) => partition_id),
            );
            // One split per partition the file touches, as the node's own
            // indexer splits a partitioned commit.
            expect(partitions.size).toBe(splits.length);
            if (partitionKey === null) {
              expect(splits).toHaveLength(1);
            } else {
              expect(splits.length).toBeGreaterThan(1);
            }
          },
          TEST_TIMEOUT_MS,
        );
      }
    });

    // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
    test(
      "fact 2: offline and REST-built splits coexist in one index, and the node's searcher counts the offline documents on the first read after exit",
      async () => {
        const config = groupConfig(V10, "pol");
        await createIndex(config);
        const offline = inputFile(
          caseLawDecisions({
            manifest: V10,
            jurisdiction: "POL",
            decisions: 200,
            paragraphs: 20,
          }),
        );
        const rest = Array.from({ length: 3 }, () =>
          inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 10,
              paragraphs: 20,
            }),
          ),
        );
        const run = startOfflineIndexer(
          offlineSlot(config.index_id, await writeInput(offline)),
        );
        for (const batch of rest) {
          await ingestForced(config.index_id, batch);
        }
        expect((await run.exited).exitCode).toBe(0);

        // No wait: the root search lists published splits from the metastore
        // on every request, so the first read after exit sees the publish.
        const expected = [offline, ...rest].flatMap(
          ({ revisions }) => revisions,
        );
        await expectExact(config.index_id, expected);
        const sources = new Set(
          inState(await listSplits(config.index_id), "Published").map(
            ({ source_id }) => source_id,
          ),
        );
        expect(sources).toEqual(
          new Set([INGEST_CLI_SOURCE, REST_INGEST_SOURCE]),
        );
        expect(await visibleDocuments(config.index_id)).toBe(
          [offline, ...rest].reduce(
            (sum, { documentCount }) => sum + documentCount,
            0,
          ),
        );
      },
      TEST_TIMEOUT_MS,
    );

    describe("fact 3: exactly once per input file", () => {
      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "a finished input file adds nothing when run again, under the same or another node id",
        async () => {
          const config = groupConfig(V10, "pol");
          await createIndex(config);
          const input = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 30,
              paragraphs: 20,
            }),
          );
          const first = offlineSlot(config.index_id, await writeInput(input));
          expect((await runOfflineIndexer(first)).exitCode).toBe(0);
          const published = await listSplits(config.index_id);

          expect((await runOfflineIndexer(first)).exitCode).toBe(0);
          expect(
            (
              await runOfflineIndexer(
                offlineSlot(config.index_id, first.inputPath),
              )
            ).exitCode,
          ).toBe(0);

          expect(await listSplits(config.index_id)).toEqual(published);
          await expectExact(config.index_id, input.revisions);
        },
        TEST_TIMEOUT_MS,
      );

      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "the checkpoint is keyed by the input file's URI alone: new content at a finished path is skipped, the same documents at a new path are indexed again",
        async () => {
          const config = groupConfig(V10, "pol");
          await createIndex(config);
          const input = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 30,
              paragraphs: 20,
            }),
          );
          const inputPath = await writeInput(input);
          expect(
            (await runOfflineIndexer(offlineSlot(config.index_id, inputPath)))
              .exitCode,
          ).toBe(0);

          const replacement = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 60,
              paragraphs: 20,
            }),
          );
          expect(replacement.ndjson.length).toBeGreaterThan(
            input.ndjson.length,
          );
          await writeInput(replacement, inputPath);
          expect(
            (await runOfflineIndexer(offlineSlot(config.index_id, inputPath)))
              .exitCode,
          ).toBe(0);
          expect(
            await observedCounts(config.index_id, replacement.revisions),
          ).toEqual(replacement.revisions.map(() => 0));

          expect(
            (
              await runOfflineIndexer(
                offlineSlot(config.index_id, await writeInput(input)),
              )
            ).exitCode,
          ).toBe(0);
          // The census reports every revision at twice its count: excess.
          expect(
            await observedCounts(config.index_id, input.revisions),
          ).toEqual(
            input.revisions.map(({ documentCount }) => documentCount * 2),
          );
        },
        TEST_TIMEOUT_MS,
      );

      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "a run killed after part of a file published shows whole published splits only, and a rerun resumes from its checkpoint to exactly one copy",
        async () => {
          // The base group's configuration, with a doc target that makes one
          // input commit several times, as a heap-full commit would.
          const base = groupConfig(V10, "pol");
          const config = {
            ...base,
            indexing_settings: {
              ...base.indexing_settings,
              split_num_docs_target: 1000,
            },
          };
          await createIndex(config);
          const input = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 1500,
              paragraphs: 20,
            }),
          );
          const spec = offlineSlot(config.index_id, await writeInput(input));
          const run = startOfflineIndexer(spec);
          await waitForExternalState({
            description: "the first commit of the file is published",
            intervalMs: 10,
            timeoutMs: OFFLINE_RUN_TIMEOUT_MS, // timeout: engine-side kill bound plus margin
            read: async () =>
              inState(await splitsOf(config.index_id, spec.nodeId), "Published")
                .length > 0,
          });
          const hold = await holdIndexRow(
            config.index_id,
            INDEX_ROW_HOLD.publish,
          );
          await waitForLockWaiter(PUBLISH_INDEX_LOCK);
          await killOfflineIndexer(run);
          await hold.release();
          await waitForNoLockWaiters();

          const splits = await splitsOf(config.index_id, spec.nodeId);
          const visible = await visibleDocuments(config.index_id);
          expect(visible).toBe(publishedDocuments(splits));
          expect(visible).toBeGreaterThan(0);
          expect(visible).toBeLessThan(input.documentCount);
          // What is visible is a prefix of the file: revisions before the
          // checkpoint are exact, at most one straddles it, the rest are absent.
          const observed = await observedCounts(
            config.index_id,
            input.revisions,
          );
          const firstShort = observed.findIndex(
            (count, index) =>
              count !== (input.revisions.at(index)?.documentCount ?? -1),
          );
          expect(firstShort).toBeGreaterThan(0);
          expect(
            observed.slice(firstShort + 1).every((count) => count === 0),
          ).toBe(true);
          expect(observed.reduce((sum, count) => sum + count, 0)).toBe(visible);

          expect(
            (
              await runOfflineIndexer(
                offlineSlot(config.index_id, spec.inputPath),
              )
            ).exitCode,
          ).toBe(0);
          await expectExact(config.index_id, input.revisions);
          expect(await visibleDocuments(config.index_id)).toBe(
            input.documentCount,
          );
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("fact 4: kill semantics", () => {
      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "a split's file is complete in index storage before its publish starts, and a SIGKILL while the publish waits leaves it staged, invisible and never published",
        async () => {
          const config = groupConfig(V10, "pol");
          const indexUri = await createIndex(config);
          const input = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 40,
              paragraphs: 20,
            }),
          );
          const spec = offlineSlot(config.index_id, await writeInput(input));
          const hold = await holdIndexRow(
            config.index_id,
            INDEX_ROW_HOLD.publish,
          );
          const run = startOfflineIndexer(spec);
          await waitForLockWaiter(PUBLISH_INDEX_LOCK);

          const staged = await splitsOf(config.index_id, spec.nodeId);
          expect(staged.length).toBeGreaterThan(0);
          for (const split of staged) {
            expect(split.split_state).toBe("Staged");
            expect(await fileSize(splitFile(indexUri, split.split_id))).toBe(
              split.footer_offsets.end,
            );
          }

          await killOfflineIndexer(run);
          await hold.release();
          await waitForNoLockWaiters();

          expect(await splitsOf(config.index_id, spec.nodeId)).toEqual(staged);
          expect(await visibleDocuments(config.index_id)).toBe(0);
          expect(
            await observedCounts(config.index_id, input.revisions),
          ).toEqual(input.revisions.map(() => 0));

          // The leftover stays staged beside a rerun, which publishes the
          // file exactly once.
          const rerun = offlineSlot(config.index_id, spec.inputPath);
          expect((await runOfflineIndexer(rerun)).exitCode).toBe(0);
          expect(await splitsOf(config.index_id, spec.nodeId)).toEqual(staged);
          await expectExact(config.index_id, input.revisions);
          expect(await visibleDocuments(config.index_id)).toBe(
            input.documentCount,
          );

          // A staged leftover is a lagging split to the product's delete
          // settlement until the engine collects it.
          const target = input.revisions.slice(0, 1);
          const task = (
            await deleteCorpusProjectionRevisions({
              client,
              indexId: config.index_id,
              revisions: target.map(({ revision }) => revision),
            })
          ).unwrap();
          const settlement = await settle(
            leaseFor({
              indexId: config.index_id,
              family: "case_law",
              generation: V10.generation,
              intentIds: target.map(({ revision }) => revision),
              task,
            }),
          );
          expect(settlement.status).toBe("pending");
          expect(
            settlement.status === "pending" ? settlement.reason : null,
          ).toBe("staged_split");
        },
        TEST_TIMEOUT_MS,
      );

      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "a SIGKILL while staging waits, after a split is indexed and before its upload, leaves no split in any state",
        async () => {
          const config = groupConfig(V10, "pol");
          await createIndex(config);
          const input = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 40,
              paragraphs: 20,
            }),
          );
          const spec = offlineSlot(config.index_id, await writeInput(input));
          const hold = await holdIndexRow(
            config.index_id,
            INDEX_ROW_HOLD.stage,
          );
          const run = startOfflineIndexer(spec);
          await waitForLockWaiter(STAGE_INSERT);
          await killOfflineIndexer(run);
          await hold.release();
          await waitForNoLockWaiters();

          expect(await listSplits(config.index_id)).toEqual([]);
          expect(
            await observedCounts(config.index_id, input.revisions),
          ).toEqual(input.revisions.map(() => 0));
          expect(
            (
              await runOfflineIndexer(
                offlineSlot(config.index_id, spec.inputPath),
              )
            ).exitCode,
          ).toBe(0);
          await expectExact(config.index_id, input.revisions);
        },
        TEST_TIMEOUT_MS,
      );

      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "a SIGKILL between the start of indexing and the first staged split leaves no split in any state",
        async () => {
          const config = groupConfig(V10, "pol");
          await createIndex(config);
          const input = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 1500,
              paragraphs: 20,
            }),
          );
          const spec = offlineSlot(config.index_id, await writeInput(input));
          // Nothing can stage while the row is held, so the kill lands
          // between the first indexed document and the first staged split.
          const hold = await holdIndexRow(
            config.index_id,
            INDEX_ROW_HOLD.stage,
          );
          const run = startOfflineIndexer(spec);
          await waitForExternalState({
            description: "the indexer has a split in its scratch directory",
            intervalMs: 20,
            timeoutMs: OFFLINE_RUN_TIMEOUT_MS, // timeout: engine-side kill bound plus margin
            read: async () => (await dataEntries(spec.dataDir)).length > 0,
          });
          await killOfflineIndexer(run);
          await hold.release();
          await waitForNoLockWaiters();

          expect(await listSplits(config.index_id)).toEqual([]);
          expect(await visibleDocuments(config.index_id)).toBe(0);
        },
        TEST_TIMEOUT_MS,
      );

      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "a SIGKILL after the run's own publish, while its merge publishes, keeps every input published and the merge output staged",
        async () => {
          // Merge factor 2: the second run with one node id merges its own
          // split with the first's on its way out.
          const base = groupConfig(V10, "pol");
          const config = {
            ...base,
            indexing_settings: {
              ...base.indexing_settings,
              merge_policy: {
                ...base.indexing_settings.merge_policy,
                merge_factor: 2,
                max_merge_factor: 2,
              },
            },
          };
          const indexUri = await createIndex(config);
          const firstInput = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 30,
              paragraphs: 20,
            }),
          );
          const first = offlineSlot(
            config.index_id,
            await writeInput(firstInput),
          );
          expect((await runOfflineIndexer(first)).exitCode).toBe(0);
          const firstSplit =
            (await splitsOf(config.index_id, first.nodeId)).at(0) ??
            panic("Expected the first run's split");

          const secondInput = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 30,
              paragraphs: 20,
            }),
          );
          const second = {
            ...first,
            inputPath: await writeInput(secondInput),
          };
          const hold = await holdSplitRow(firstSplit.split_id);
          const run = startOfflineIndexer(second);
          await waitForLockWaiter(/UPDATE splits|splits.*FOR UPDATE/iu);

          const during = await splitsOf(config.index_id, first.nodeId);
          const merged = inState(during, "Staged");
          expect(merged).toHaveLength(1);
          const mergeOutput =
            merged.at(0) ?? panic("Expected one staged merge output");
          expect(mergeOutput.num_merge_ops).toBe(1);
          expect(
            await fileSize(splitFile(indexUri, mergeOutput.split_id)),
          ).toBe(mergeOutput.footer_offsets.end);
          expect(inState(during, "Published")).toHaveLength(2);

          await killOfflineIndexer(run);
          await hold.release();
          await waitForNoLockWaiters();

          const after = await splitsOf(config.index_id, first.nodeId);
          expect(inState(after, "Published")).toEqual(
            inState(during, "Published"),
          );
          expect(inState(after, "Staged")).toEqual(merged);
          await expectExact(config.index_id, [
            ...firstInput.revisions,
            ...secondInput.revisions,
          ]);
          // The second file's own publish carried its checkpoint.
          expect((await runOfflineIndexer(second)).exitCode).toBe(0);
          await expectExact(config.index_id, secondInput.revisions);
        },
        TEST_TIMEOUT_MS,
      );
    });

    // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
    test(
      "fact 5: strict-mode rejects publish every valid document and leave each affected revision short in the census, which is the only reliable report: the exit code is 1 or 0",
      async () => {
        const config = groupConfig(V10, "pol");
        await createIndex(config);
        const decisions = caseLawDecisions({
          manifest: V10,
          jurisdiction: "POL",
          decisions: 20,
          paragraphs: 20,
        });
        const rejects = new Map([
          [2, { not_in_the_mapping: true }],
          [5, { decision_year: "not a number" }],
        ]);
        const input = inputFile(
          decisions.map(({ revision, documents }, serial) => {
            const reject = rejects.get(serial);
            return {
              revision,
              documents:
                reject === undefined
                  ? documents
                  : documents.map((document, index) =>
                      index === 0 ? { ...document, ...reject } : document,
                    ),
            };
          }),
        );
        const spec = offlineSlot(config.index_id, await writeInput(input));
        const outcome = await runOfflineIndexer(spec);
        // Observed both ways for one input on 0.9.3; never a signal to rely on.
        expect([0, 1]).toContain(outcome.exitCode);

        expect(await visibleDocuments(config.index_id)).toBe(
          input.documentCount - rejects.size,
        );
        const { unproven } = await census(config.index_id, input.revisions);
        expect(unproven).toEqual(
          [...rejects.keys()].map((serial) => {
            const { revision, documentCount } =
              input.revisions.at(serial) ?? panic("Expected the revision");
            return {
              revision,
              expectedDocumentCount: documentCount,
              observedDocumentCount: documentCount - 1,
            };
          }),
        );
        // The rejected lines are behind the checkpoint: a rerun adds nothing.
        await runOfflineIndexer(offlineSlot(config.index_id, spec.inputPath));
        expect(await visibleDocuments(config.index_id)).toBe(
          input.documentCount - rejects.size,
        );
      },
      TEST_TIMEOUT_MS,
    );

    describe("fact 6: census and delete on offline-built splits", () => {
      // timeout: the engine's delete pipeline polls for work about once a minute (DELETE_SETTLE_TIMEOUT_MS).
      test(
        "the census is exact across offline- and REST-built splits, and a delete task removes a revision from both once they are mature",
        async () => {
          // A split that reaches the doc target is mature at creation, so
          // the delete pipeline applies the task now.
          const base = groupConfig(V10, "pol");
          const config = {
            ...base,
            indexing_settings: {
              ...base.indexing_settings,
              split_num_docs_target: 1,
            },
          };
          await createIndex(config);
          const decisions = caseLawDecisions({
            manifest: V10,
            jurisdiction: "POL",
            decisions: 30,
            paragraphs: 20,
          });
          // The first decision's revision is written by every builder: the
          // offline runs and the REST ingest each hold some of its passages.
          const shared = decisions.at(0) ?? panic("Expected a decision");
          const third = Math.ceil(shared.documents.length / 3);
          const slices = [0, 1, 2].map((part) => ({
            revision: shared.revision,
            documents: shared.documents.slice(part * third, (part + 1) * third),
          }));
          const slice = (part: number) =>
            slices.at(part) ?? panic("Expected three slices");
          const [sharedA, sharedB, sharedRest] = [slice(0), slice(1), slice(2)];
          const offlineA = inputFile([sharedA, ...decisions.slice(1, 10)]);
          const offlineB = inputFile([sharedB, ...decisions.slice(10, 20)]);
          const rest = inputFile([sharedRest, ...decisions.slice(20)]);
          const expected = inputFile(decisions).revisions;
          expect(
            (
              await runOfflineIndexer(
                offlineSlot(config.index_id, await writeInput(offlineA)),
              )
            ).exitCode,
          ).toBe(0);
          expect(
            (
              await runOfflineIndexer(
                offlineSlot(config.index_id, await writeInput(offlineB)),
              )
            ).exitCode,
          ).toBe(0);
          await ingestForced(config.index_id, rest);
          const splits = inState(
            await listSplits(config.index_id),
            "Published",
          );
          expect(splits.length).toBeGreaterThanOrEqual(3);
          await expectExact(config.index_id, expected);

          const deleted = [
            shared.revision,
            decisions.at(15)?.revision ?? panic("Expected a decision"),
          ];
          const task = (
            await deleteCorpusProjectionRevisions({
              client,
              indexId: config.index_id,
              revisions: deleted,
            })
          ).unwrap();
          const lease = leaseFor({
            indexId: config.index_id,
            family: "case_law",
            generation: V10.generation,
            intentIds: deleted,
            task,
          });
          const settled = await waitForExternalState({
            description: "the delete task settles on every split",
            intervalMs: 2000,
            timeoutMs: DELETE_SETTLE_TIMEOUT_MS,
            read: async () => {
              const result = await settle(lease);
              return result.status === "verified" ? result : null;
            },
          });
          expect(settled.status).toBe("verified");
          const survivors = expected.filter(
            ({ revision }) => !deleted.includes(revision),
          );
          await expectExact(config.index_id, survivors);
          expect(
            await observedCounts(
              config.index_id,
              expected.filter(({ revision }) => deleted.includes(revision)),
            ),
          ).toEqual([0, 0]);
        },
        TEST_TIMEOUT_MS,
      );

      for (const { label, manifest, indexGroup, family, periodMs } of [
        {
          label: "four hours under the default merge policy",
          manifest: CORPUS_INDEX_MANIFESTS.legislation_v2,
          indexGroup: "cze",
          family: "legislation",
          periodMs: 4 * 3600 * 1000,
        },
        {
          label: "seven days under the case_law_v8 and later policy",
          manifest: V10,
          indexGroup: "pol",
          family: "case_law",
          periodMs: 7 * 24 * 3600 * 1000,
        },
      ] as const) {
        // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
        test(
          `an offline-built split is immature like a REST-built one and holds a delete for ${label}`,
          async () => {
            const config = groupConfig(manifest, indexGroup);
            await createIndex(config);
            const offline =
              family === "legislation"
                ? inputFile(legislationVersions(10))
                : inputFile(
                    caseLawDecisions({
                      manifest: V10,
                      jurisdiction: "POL",
                      decisions: 10,
                      paragraphs: 20,
                    }),
                  );
            const rest =
              family === "legislation"
                ? inputFile(legislationVersions(10))
                : inputFile(
                    caseLawDecisions({
                      manifest: V10,
                      jurisdiction: "POL",
                      decisions: 10,
                      paragraphs: 20,
                    }),
                  );
            const spec = offlineSlot(
              config.index_id,
              await writeInput(offline),
            );
            expect((await runOfflineIndexer(spec)).exitCode).toBe(0);
            await ingestForced(config.index_id, rest);
            const splits = inState(
              await listSplits(config.index_id),
              "Published",
            );
            expect(new Set(splits.map(({ source_id }) => source_id))).toEqual(
              new Set([INGEST_CLI_SOURCE, REST_INGEST_SOURCE]),
            );
            for (const split of splits) {
              expect(split.maturity).toEqual({
                type: "immature",
                maturation_period_millis: periodMs,
              });
            }

            const deleted = [
              offline.revisions.at(0)?.revision ?? panic("Expected a revision"),
            ];
            const task = (
              await deleteCorpusProjectionRevisions({
                client,
                indexId: config.index_id,
                revisions: deleted,
              })
            ).unwrap();
            const settlement = await settle(
              leaseFor({
                indexId: config.index_id,
                family,
                generation: manifest.generation,
                intentIds: deleted,
                task,
              }),
            );
            if (
              settlement.status !== "pending" ||
              settlement.reason !== "immature_split"
            ) {
              panic(
                `expected an immature split, got ${JSON.stringify(settlement)}`,
              );
            }
            // The latest maturity target of the lagging splits: creation
            // plus the period, for the offline split as for the REST one.
            expect(settlement.maturesAt.epochMilliseconds).toBe(
              Math.max(
                ...splits.map(({ create_timestamp }) => create_timestamp),
              ) *
                1000 +
                periodMs,
            );
            await expectExact(config.index_id, offline.revisions);
          },
          TEST_TIMEOUT_MS,
        );
      }
    });

    describe("fact 7: data directories", () => {
      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "an offline indexer with its own data directory leaves every file of a co-located node's in-flight data in place",
        async () => {
          const config = groupConfig(V10, "pol");
          await createIndex(config);
          // Accepted, not committed: under the 600 s commit window these
          // documents wait in the node's own data directory.
          const pending = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 20,
              paragraphs: 20,
            }),
          );
          (
            await client.ingestBatch(
              config.index_id,
              pending.ndjson,
              "auto",
              "unobserved",
            )
          ).unwrap();
          const nodeEntries = await waitForExternalState({
            description:
              "the node holds the accepted documents in its scratch directory",
            intervalMs: 100,
            timeoutMs: LOCK_WAIT_TIMEOUT_MS,
            read: async () => {
              const entries = await dataEntries(NODE_DATA_DIR, NODE_STATE_DIRS);
              return entries.length > 0 ? entries : null;
            },
          });

          const offline = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 20,
              paragraphs: 20,
            }),
          );
          const spec = offlineSlot(config.index_id, await writeInput(offline));
          expect((await runOfflineIndexer(spec)).exitCode).toBe(0);

          const afterEntries = new Set(
            await dataEntries(NODE_DATA_DIR, NODE_STATE_DIRS),
          );
          expect(
            nodeEntries.filter((entry) => !afterEntries.has(entry)),
          ).toEqual([]);
          expect(
            await observedCounts(config.index_id, pending.revisions),
          ).toEqual(pending.revisions.map(() => 0));

          // A forced commit publishes everything the node holds for the index.
          const forced = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 1,
              paragraphs: 20,
            }),
          );
          await ingestForced(config.index_id, forced);
          await expectExact(config.index_id, [
            ...pending.revisions,
            ...offline.revisions,
            ...forced.revisions,
          ]);
        },
        TEST_TIMEOUT_MS,
      );

      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "the offline indexer works in the QW_DATA_DIR of its environment over its config file's data_dir, and empties that directory's caches on exit",
        async () => {
          const config = groupConfig(V10, "pol");
          await createIndex(config);
          const input = inputFile(
            caseLawDecisions({
              manifest: V10,
              jurisdiction: "POL",
              decisions: 10,
              paragraphs: 20,
            }),
          );
          const spec = offlineSlot(config.index_id, await writeInput(input));
          const configured = `${spec.dataDir}-configured`;
          const configFile = `${spec.dataDir}.yaml`;
          await engineExecOk({
            args: [
              "sh",
              "-c",
              'mkdir -p "$2" && printf "version: 0.8\\ndata_dir: %s\\n" "$2" > "$1"',
              "config",
              configFile,
              configured,
            ],
          });
          const hold = await holdIndexRow(
            config.index_id,
            INDEX_ROW_HOLD.stage,
          );
          const { args, env } = offlineIndexerCommand(spec).unwrap();
          const exited = engineExec({
            args,
            env: { ...env, QW_CONFIG: configFile },
            timeoutMs: OFFLINE_RUN_TIMEOUT_MS, // timeout: engine-side kill bound plus margin
          });
          await waitForLockWaiter(STAGE_INSERT);
          // The indexed split waits for staging in the scratch directory.
          expect((await dataEntries(spec.dataDir)).length).toBeGreaterThan(0);
          expect(await dataEntries(configured)).toEqual([]);
          await hold.release();

          expect((await exited).exitCode).toBe(0);
          await expectExact(config.index_id, input.revisions);
          // What a node sharing this directory would lose.
          expect(await dataEntries(spec.dataDir)).toEqual([]);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("fact 8: concurrent offline indexers", () => {
      // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
      test(
        "two runs into different indexes both publish exactly",
        async () => {
          const configs = [groupConfig(V10, "pol"), groupConfig(V10, "usa")];
          const inputs = [
            inputFile(
              caseLawDecisions({
                manifest: V10,
                jurisdiction: "POL",
                decisions: 100,
                paragraphs: 20,
              }),
            ),
            inputFile(
              caseLawDecisions({
                manifest: V10,
                jurisdiction: "USA",
                decisions: 100,
                paragraphs: 10,
              }),
            ),
          ];
          const specs = await Promise.all(
            configs.map(async (config, index) => {
              await createIndex(config);
              const input = inputs.at(index) ?? panic("Expected an input");
              return offlineSlot(config.index_id, await writeInput(input));
            }),
          );
          const outcomes = await Promise.all(specs.map(runOfflineIndexer));
          expect(outcomes.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
          for (const [index, config] of configs.entries()) {
            const input = inputs.at(index) ?? panic("Expected an input");
            await expectExact(config.index_id, input.revisions);
          }
        },
        TEST_TIMEOUT_MS,
      );

      for (const { label, sameNodeId } of [
        { label: "different node ids", sameNodeId: false },
        { label: "one node id", sameNodeId: true },
      ] as const) {
        // timeout: runs offline indexer processes in the engine container, each bounded by OFFLINE_RUN_KILL_AFTER_SECS.
        test(
          `two runs into one index with different files and ${label} both publish exactly`,
          async () => {
            const config = groupConfig(V10, "pol");
            await createIndex(config);
            const inputs = [0, 1].map(() =>
              inputFile(
                caseLawDecisions({
                  manifest: V10,
                  jurisdiction: "POL",
                  decisions: 100,
                  paragraphs: 20,
                }),
              ),
            );
            const first = offlineSlot(
              config.index_id,
              await writeInput(inputs.at(0) ?? panic("Expected an input")),
            );
            const secondPath = await writeInput(
              inputs.at(1) ?? panic("Expected an input"),
            );
            const second = sameNodeId
              ? {
                  ...first,
                  inputPath: secondPath,
                  dataDir: `${first.dataDir}-second`,
                }
              : offlineSlot(config.index_id, secondPath);
            const outcomes = await Promise.all([
              runOfflineIndexer(first),
              runOfflineIndexer(second),
            ]);
            expect(outcomes.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
            await expectExact(
              config.index_id,
              inputs.flatMap(({ revisions }) => revisions),
            );
          },
          TEST_TIMEOUT_MS,
        );
      }
    });
  },
);
