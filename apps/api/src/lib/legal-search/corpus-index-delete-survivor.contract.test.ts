import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import {
  type CorpusIndexDeleteTask,
  CorpusIndexError,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import { CORPUS_INDEX_CONFIG_VERSION } from "@/api/lib/legal-search/corpus-index-config";
import {
  type CorpusProjectionCleanupSettlementLease,
  CorpusProjectionCleanupSettlementProof,
  type CorpusProjectionCleanupSettlementResult,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { corpusProjectionRevisionsQuery } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { isRecord } from "@/api/lib/type-guards";

/**
 * A delete task against the engine itself, for a revision written again after
 * the task: the engine never applies a task to a split created after it, so
 * the proof must call the late documents survivors, and a new delete must
 * settle them.
 *
 * Opt-in like the other engine suites: STELLA_RUN_CORPUS_ENGINE_TESTS=true
 * with the pinned engine serving its REST API at the test endpoints. The
 * suite creates and deletes its own index. The index never merges, so every
 * split is mature at once and the engine applies deletes as soon as its
 * delete pipeline polls.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

const INDEX_ID = `delete_survivor_contract_${Date.now().toString(36)}`;
const REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000401",
);
const GROUP_FIRST_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000403",
);
const GROUP_SECOND_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000404",
);
const UNRELATED_REVISION = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000405",
);
const GROUP_REVISIONS = [GROUP_FIRST_REVISION, GROUP_SECOND_REVISION] as const;
const DOCUMENTS_PER_WRITE = 3;
const INGEST_IDLE_TIMEOUT_MS = 90_000;
/** Two engine shard-gossip ticks must pass with an unchanged idle state. */
const INGEST_IDLE_STABLE_MS = 10_000;
/** The engine's delete pipeline polls for work about once a minute. */
const SETTLE_TIMEOUT_MS = 240_000;
const POLL_MS = 2000;
const TEST_TIMEOUT_MS = 600_000;

const client = getCorpusIndexClient("q09");
let indexCreated = false;
const mutationBase = () =>
  envBase.CORPUS_INDEX_Q09_ENDPOINT ?? panic("engine endpoint is not set");

const ingestRevision = async (
  write: number,
  revision = REVISION,
): Promise<void> => {
  const ndjson = Array.from({ length: DOCUMENTS_PER_WRITE }, (_, index) =>
    JSON.stringify({
      document_id: `document-${write}-${index}`,
      projection_revision: revision,
    }),
  ).join("\n");
  // `force` commits at once: each write is its own split, and the indexer
  // starts a new one after it.
  const response = await fetch(
    `${mutationBase()}/api/v1/${INDEX_ID}/ingest?commit=force`,
    {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: `${ndjson}\n`,
    },
  );
  if (!response.ok) {
    throw new Error(`ingest ${String(response.status)}`);
  }
};

const deleteRevision = async (
  revisions: CorpusProjectionCleanupSettlementLease["intentIds"] = [REVISION],
): Promise<CorpusIndexDeleteTask> => {
  const task = await client.deleteByQuery(
    INDEX_ID,
    corpusProjectionRevisionsQuery(revisions),
    "unobserved",
  );
  if (task.isErr()) {
    throw task.error;
  }
  return task.value;
};

const leaseFor = (
  { opstamp, createdAt }: CorpusIndexDeleteTask,
  intentIds: CorpusProjectionCleanupSettlementLease["intentIds"] = [REVISION],
): CorpusProjectionCleanupSettlementLease => ({
  family: "case_law",
  generation: "case_law_v7",
  indexId: INDEX_ID,
  intentIds,
  deleteOpstamp: opstamp,
  deleteTaskCreatedAt: createdAt,
  leaseToken: "0198e331-e578-7000-8000-000000000402",
});

const verifyNow = async (
  task: CorpusIndexDeleteTask,
  intentIds: CorpusProjectionCleanupSettlementLease["intentIds"],
) => {
  const verdict = (
    await CorpusProjectionCleanupSettlementProof.verifyAll({
      client,
      indexId: INDEX_ID,
      leases: [leaseFor(task, intentIds)],
      // Past any maturation period, so a survivor is not held back as
      // unconfirmed; every split of this index is mature anyway.
      testNow: task.createdAt.add({ hours: 24 * 8 }),
    })
  ).at(0);
  if (verdict === undefined || verdict.result.isErr()) {
    return panic("Expected one settlement verdict", verdict?.result);
  }
  return verdict.result.value;
};

const isEngineLag = (
  result: CorpusProjectionCleanupSettlementResult,
): boolean => {
  if (result.status !== "pending") {
    return false;
  }
  switch (result.reason) {
    case "staged_split":
    case "immature_split":
    case "delete_lagging":
      return true;
    case "survivor_unconfirmed":
    case "survivor":
      return false;
    default: {
      result satisfies never;
      return panic(`unhandled pending reason ${String(result)}`);
    }
  }
};

type VerifyOnceCaughtUpOptions = {
  task: CorpusIndexDeleteTask;
  intentIds?: CorpusProjectionCleanupSettlementLease["intentIds"];
  deadline?: number;
};

/** Proves the task again until the engine's delete pipeline has caught up. */
const verifyOnceCaughtUp = async ({
  task,
  intentIds = [REVISION],
  deadline = Date.now() + SETTLE_TIMEOUT_MS,
}: VerifyOnceCaughtUpOptions): Promise<CorpusProjectionCleanupSettlementResult> => {
  const result = await verifyNow(task, intentIds);
  if (!isEngineLag(result) || Date.now() > deadline) {
    return result;
  }
  await Bun.sleep(POLL_MS);
  return await verifyOnceCaughtUp({ task, intentIds, deadline });
};

/** The index must stop publishing shard updates before it is removed. */
const waitForIngestIdle = async (): Promise<void> => {
  const deadline = performance.now() + INGEST_IDLE_TIMEOUT_MS;
  let stable: { state: string; since: number } | undefined;
  let lastState: string[] = [];
  while (performance.now() < deadline) {
    const response = await fetch(`${mutationBase()}/api/v1/cluster`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new CorpusIndexError({
        message: `cluster state ${response.status}`,
      });
    }
    const cluster: unknown = await response.json();
    const snapshot = isRecord(cluster)
      ? cluster["chitchat_state_snapshot"]
      : undefined;
    const nodes = isRecord(snapshot) ? snapshot["node_states"] : undefined;
    if (!Array.isArray(nodes)) {
      throw new CorpusIndexError({
        message: "cluster state has no node states",
      });
    }
    const shards: string[] = [];
    for (const node of nodes) {
      const keyValues = isRecord(node) ? node["key_values"] : undefined;
      if (!isRecord(keyValues)) {
        throw new CorpusIndexError({
          message: "cluster node has no key values",
        });
      }
      for (const [key, entry] of Object.entries(keyValues)) {
        if (!key.startsWith(`ingester.primary_shards:${INDEX_ID}:`)) {
          continue;
        }
        if (!isRecord(entry)) {
          throw new CorpusIndexError({
            message: "ingest shard entry is unreadable",
          });
        }
        if (entry["status"] !== "Set") {
          continue;
        }
        const value = entry["value"];
        if (typeof value !== "string") {
          throw new CorpusIndexError({
            message: "ingest shard value is unreadable",
          });
        }
        const parsed = Result.try((): unknown => JSON.parse(value));
        if (parsed.isErr()) {
          throw new CorpusIndexError({
            message: "ingest shard value is not JSON",
            cause: parsed.error,
          });
        }
        const infos = parsed.value;
        if (
          !Array.isArray(infos) ||
          !infos.every((info: unknown) => typeof info === "string")
        ) {
          throw new CorpusIndexError({
            message: "ingest shard value is not a shard list",
          });
        }
        shards.push(...infos);
      }
    }
    lastState = shards.toSorted();
    const state = JSON.stringify(lastState);
    const now = performance.now();
    if (!lastState.every((info) => /^[^:]+:[a-z_]+:0:0$/u.test(info))) {
      stable = undefined;
    } else if (stable?.state !== state) {
      stable = { state, since: now };
    } else if (now - stable.since >= INGEST_IDLE_STABLE_MS) {
      return;
    }
    await Bun.sleep(POLL_MS);
  }
  throw new CorpusIndexError({
    message: `ingest did not become idle: ${JSON.stringify(lastState)}`,
  });
};

describe.skipIf(!runEngineTests)(
  "a revision written after its delete, against the pinned engine",
  () => {
    beforeAll(async () => {
      const response = await fetch(`${mutationBase()}/api/v1/indexes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: CORPUS_INDEX_CONFIG_VERSION,
          index_id: INDEX_ID,
          doc_mapping: {
            mode: "strict",
            field_mappings: [
              { name: "document_id", type: "text", tokenizer: "raw" },
              { name: "projection_revision", type: "text", tokenizer: "raw" },
            ],
          },
          indexing_settings: { merge_policy: { type: "no_merge" } },
          search_settings: { default_search_fields: ["document_id"] },
        }),
      });
      if (!response.ok) {
        throw new Error(`create index ${String(response.status)}`);
      }
      indexCreated = true;
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (!indexCreated) {
        return;
      }
      await waitForIngestIdle();
      const deleted = await client.deleteIndex(INDEX_ID, "unobserved");
      if (deleted.isErr()) {
        throw deleted.error;
      }
    }, TEST_TIMEOUT_MS);

    test(
      "a survivor is declared, and a new delete settles it",
      async () => {
        await ingestRevision(0);
        const first = await deleteRevision();
        // The same revision again, after the task: the split it lands in is
        // created after the task and carries its opstamp, so the task can
        // never reach it.
        await ingestRevision(1);

        const survivor = await verifyOnceCaughtUp({ task: first });

        if (survivor.status !== "pending" || survivor.reason !== "survivor") {
          throw new Error(
            `expected a survivor, got ${JSON.stringify(survivor)}`,
          );
        }
        expect(survivor.remainingRevisionCount).toBe(DOCUMENTS_PER_WRITE);
        expect(survivor.settlement.laggingProvingSplits).toEqual([]);
        expect(survivor.settlement.laggingExcludedSplits).toEqual([]);
        expect(survivor.reissue.deleteOpstamp).toBe(first.opstamp);

        // What the reissued cleanup does: a new delete for the same revision.
        const second = await deleteRevision();
        expect(second.opstamp).toBeGreaterThan(first.opstamp);

        const settled = await verifyOnceCaughtUp({ task: second });

        expect(settled.status).toBe("verified");
      },
      TEST_TIMEOUT_MS,
    );

    // A first-only or last-only count must not settle the whole revision group.
    test(
      "a grouped delete counts an asymmetric survivor in either revision order",
      async () => {
        await ingestRevision(2, GROUP_FIRST_REVISION);
        await ingestRevision(3, GROUP_SECOND_REVISION);
        const first = await deleteRevision(GROUP_REVISIONS);
        const initial = await verifyOnceCaughtUp({
          task: first,
          intentIds: GROUP_REVISIONS,
        });
        expect(initial.status).toBe("verified");

        // The first revision is gone; only the second is written after the task.
        await ingestRevision(4, GROUP_SECOND_REVISION);
        await ingestRevision(5, UNRELATED_REVISION);
        const clean = await client.search({
          indexId: INDEX_ID,
          query: corpusProjectionRevisionsQuery([GROUP_FIRST_REVISION]),
          maxHits: 0,
          observer: "unobserved",
        });
        if (clean.isErr()) {
          throw clean.error;
        }
        expect(clean.value.numHits).toBe(0);
        const remaining = await client.search({
          indexId: INDEX_ID,
          query: corpusProjectionRevisionsQuery([GROUP_SECOND_REVISION]),
          maxHits: 0,
          observer: "unobserved",
        });
        if (remaining.isErr()) {
          throw remaining.error;
        }
        expect(remaining.value.numHits).toBe(DOCUMENTS_PER_WRITE);

        for (const intentIds of [
          GROUP_REVISIONS,
          GROUP_REVISIONS.toReversed(),
        ]) {
          const result = await verifyOnceCaughtUp({ task: first, intentIds });
          if (result.status !== "pending" || result.reason !== "survivor") {
            panic(
              "Expected the remaining grouped revision to prevent settlement",
            );
          }
          expect(result.remainingRevisionCount).toBe(DOCUMENTS_PER_WRITE);
          expect(result.reissue.intentIds).toEqual(intentIds);
        }

        const second = await deleteRevision(GROUP_REVISIONS);
        expect(second.opstamp).toBeGreaterThan(first.opstamp);
        const settled = await verifyOnceCaughtUp({
          task: second,
          intentIds: GROUP_REVISIONS,
        });
        expect(settled.status).toBe("verified");
        const unrelated = await client.search({
          indexId: INDEX_ID,
          query: corpusProjectionRevisionsQuery([UNRELATED_REVISION]),
          maxHits: 0,
          observer: "unobserved",
        });
        if (unrelated.isErr()) {
          throw unrelated.error;
        }
        expect(unrelated.value.numHits).toBe(DOCUMENTS_PER_WRITE);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
