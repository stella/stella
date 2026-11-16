import { panic } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";

import { envBase } from "@/api/env-base";
import { getCorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import { CORPUS_INDEX_CONFIG_VERSION } from "@/api/lib/legal-search/corpus-index-config";

/**
 * The incarnation a route proof is bound to, against the engine itself: an
 * index deleted and created again under the same id reads as another
 * incarnation, and a deleted one reads as missing.
 *
 * Opt-in like the other engine suites: STELLA_RUN_CORPUS_ENGINE_TESTS=true
 * with the pinned engine serving its REST API at the test endpoints. The
 * suite creates and deletes its own index.
 */
const runEngineTests = process.env["STELLA_RUN_CORPUS_ENGINE_TESTS"] === "true";

// A fresh id per run, so a run never meets an index an earlier one left.
const INDEX_ID = `incarnation_contract_${Bun.randomUUIDv7().replaceAll("-", "").slice(-12)}`;
const TEST_TIMEOUT_MS = 120_000;

const client = getCorpusIndexClient("q09");
let indexExists = false;
const mutationBase = () =>
  envBase.CORPUS_INDEX_Q09_ENDPOINT ?? panic("engine endpoint is not set");

const createIndex = async (): Promise<void> => {
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
        ],
      },
      search_settings: { default_search_fields: ["document_id"] },
    }),
  });
  if (!response.ok) {
    throw new Error(`create index ${String(response.status)}`);
  }
  indexExists = true;
};

const deleteIndex = async (): Promise<void> => {
  (await client.deleteIndex(INDEX_ID, "unobserved")).unwrap();
  indexExists = false;
};

const incarnation = async () =>
  (await client.readIndexIncarnation(INDEX_ID, "unobserved")).unwrap();

describe.skipIf(!runEngineTests)(
  "an index's incarnation, against the pinned engine",
  () => {
    // timeout: deleting an index waits on the engine's metastore and storage
    afterAll(async () => {
      if (indexExists) {
        await deleteIndex();
      }
    }, TEST_TIMEOUT_MS);

    // timeout: two index creations and a deletion against a real engine
    test(
      "an index created again under the same id is another incarnation",
      async () => {
        expect(await incarnation()).toEqual({ type: "missing" });
        await createIndex();
        const first = await incarnation();
        if (first.type !== "present") {
          return panic("A created index read as missing");
        }
        expect(first.incarnation.startsWith(`${INDEX_ID}:`)).toBe(true);
        // A second read of the same index names the same incarnation.
        expect(await incarnation()).toEqual(first);

        await deleteIndex();
        expect(await incarnation()).toEqual({ type: "missing" });
        await createIndex();
        const second = await incarnation();
        if (second.type !== "present") {
          return panic("A recreated index read as missing");
        }
        expect(second.incarnation).not.toBe(first.incarnation);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
