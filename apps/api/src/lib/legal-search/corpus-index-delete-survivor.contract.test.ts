import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { toSafeId } from "@/api/lib/branded-types";
import {
  type CorpusIndexDeleteTask,
  getCorpusIndexClient,
} from "@/api/lib/legal-search/corpus-index-client";
import { CORPUS_INDEX_CONFIG_VERSION } from "@/api/lib/legal-search/corpus-index-config";
import {
  type CorpusProjectionCleanupSettlementLease,
  CorpusProjectionCleanupSettlementProof,
  type CorpusProjectionCleanupSettlementResult,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { corpusProjectionRevisionsQuery } from "@/api/lib/legal-search/corpus-index-projection-engine";

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
const DOCUMENTS_PER_WRITE = 3;
/** The engine's delete pipeline polls for work about once a minute. */
const SETTLE_TIMEOUT_MS = 240_000;
const POLL_MS = 2000;
const TEST_TIMEOUT_MS = 600_000;

const client = getCorpusIndexClient("q09");
const mutationBase = () =>
  envBase.CORPUS_INDEX_Q09_ENDPOINT ?? panic("engine endpoint is not set");

const ingestRevision = async (write: number): Promise<void> => {
  const ndjson = Array.from({ length: DOCUMENTS_PER_WRITE }, (_, index) =>
    JSON.stringify({
      document_id: `document-${write}-${index}`,
      projection_revision: REVISION,
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

const deleteRevision = async (): Promise<CorpusIndexDeleteTask> => {
  const task = await client.deleteByQuery(
    INDEX_ID,
    corpusProjectionRevisionsQuery([REVISION]),
    "unobserved",
  );
  if (task.isErr()) {
    throw task.error;
  }
  return task.value;
};

const leaseFor = ({
  opstamp,
  createdAt,
}: CorpusIndexDeleteTask): CorpusProjectionCleanupSettlementLease => ({
  family: "case_law",
  generation: "case_law_v7",
  indexId: INDEX_ID,
  intentIds: [REVISION],
  deleteOpstamp: opstamp,
  deleteTaskCreatedAt: createdAt,
  leaseToken: "0198e331-e578-7000-8000-000000000402",
});

const verifyNow = async (task: CorpusIndexDeleteTask) => {
  const verdict = (
    await CorpusProjectionCleanupSettlementProof.verifyAll({
      client,
      indexId: INDEX_ID,
      leases: [leaseFor(task)],
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

/** Proves the task again until the engine's delete pipeline has caught up. */
const verifyOnceCaughtUp = async (
  task: CorpusIndexDeleteTask,
  deadline = Date.now() + SETTLE_TIMEOUT_MS,
): Promise<CorpusProjectionCleanupSettlementResult> => {
  const result = await verifyNow(task);
  if (!isEngineLag(result) || Date.now() > deadline) {
    return result;
  }
  await Bun.sleep(POLL_MS);
  return await verifyOnceCaughtUp(task, deadline);
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
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
      await client.deleteIndex(INDEX_ID, "unobserved");
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

        const survivor = await verifyOnceCaughtUp(first);

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

        const settled = await verifyOnceCaughtUp(second);

        expect(settled.status).toBe("verified");
      },
      TEST_TIMEOUT_MS,
    );
  },
);
