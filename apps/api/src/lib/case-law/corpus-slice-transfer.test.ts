import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { corpusSliceManifest } from "@/api/lib/case-law/corpus-slice";
import {
  buildCorpusSliceExport,
  CORPUS_SLICE_EXPORT_TABLES,
  parseCorpusSliceTransferManifest,
  writeCorpusSliceExport,
} from "@/api/lib/case-law/corpus-slice-transfer";
import { exportCorpusSliceFromDatabase } from "@/api/lib/case-law/corpus-slice-transfer-execution";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { parseExportCorpusSliceArguments } from "@/api/scripts/export-corpus-slice-plan";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const decisionId = createSafeId<"caseLawDecision">();
const sourceId = createSafeId<"caseLawSource">();
const supplementSourceId = createSafeId<"caseLawSource">();
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

const memoryStorage = () => {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    storage: {
      write: async (key: string, bytes: Uint8Array) => {
        objects.set(key, bytes);
      },
      openWriter: async (key: string) => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (bytes: Uint8Array) => {
            chunks.push(bytes);
          },
          close: async () => {
            objects.set(
              key,
              new Uint8Array(await new Blob(chunks).arrayBuffer()),
            );
          },
        };
      },
    },
  };
};

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
      "round-8",
      "--copy-objects",
      "--target-bucket",
      "another-bucket",
    ]).isErr(),
  ).toBe(true);
});

test("pure export includes sources belonging to included supplements", () => {
  const exported = buildCorpusSliceExport({
    manifest,
    sources: [
      { id: sourceId, adapterKey: "decision-source" },
      { id: supplementSourceId, adapterKey: "supplement-source" },
    ],
    decisions: [{ id: decisionId, sourceId }],
    supplements: [
      {
        decisionId,
        sourceId: supplementSourceId,
        sourceDocumentId: "supplement-1",
      },
    ],
    citations: [],
  });

  expect(
    exported.shards.find(({ name }) => name === "sources")?.ndjson,
  ).toContain(supplementSourceId);
});

test("manifest and shard export remain verifiable", async () => {
  const exported = buildCorpusSliceExport({
    manifest,
    sources: [{ id: sourceId }],
    decisions: [{ id: decisionId, sourceId }],
    supplements: [],
    citations: [],
  });
  const { objects, storage } = memoryStorage();
  await writeCorpusSliceExport("slice", exported, storage);
  const bytes = objects.get("slice/manifest.json");
  expect(bytes).toBeDefined();
  expect(
    parseCorpusSliceTransferManifest(
      JSON.parse(new TextDecoder().decode(bytes)),
    ).isOk(),
  ).toBe(true);
});

test("all paged export reads share one repeatable-read snapshot", async () => {
  const laterId = createSafeId<"caseLawDecision">();
  const decisionRows = [decisionId, laterId].map((id) => ({
    id,
    source_id: sourceId,
    court: "Snapshot Court",
    decision_date: "2026-01-01",
  }));
  const committedIds = new Set(decisionRows.map(({ id }) => id));
  const transactionStatements: string[] = [];
  const { objects, storage } = memoryStorage();

  const database = asTestRaw<CaseLawRootHandle>({
    execute: async () => {
      throw new TypeError("export read escaped its snapshot transaction");
    },
    transaction: async (
      work: Parameters<CaseLawRootHandle["transaction"]>[0],
    ) => {
      const snapshotIds = new Set(committedIds);
      let decisionPage = 0;
      return await work(
        asTestRaw({
          execute: async (query: unknown) => {
            if (typeof query !== "string") {
              transactionStatements.push(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
              );
              return [];
            }
            transactionStatements.push(query);
            if (query.includes("FROM case_law_published_decisions t")) {
              const row = decisionRows
                .filter(({ id }) => snapshotIds.has(id))
                .at(decisionPage);
              decisionPage += 1;
              return row === undefined ? [] : [{ row: JSON.stringify(row) }];
            }
            if (query.includes("FROM case_law_decision_supplements t")) {
              return [];
            }
            if (query.includes("FROM case_law_citations t")) {
              if (!snapshotIds.has(laterId)) {
                return [];
              }
              return [
                {
                  row: JSON.stringify({
                    id: "citation-1",
                    citing_decision_id: decisionId,
                    cited_decision_id: laterId,
                  }),
                },
              ];
            }
            if (query.includes("FROM case_law_sources t")) {
              return [
                {
                  row: JSON.stringify({ id: sourceId, adapter_key: "example" }),
                },
              ];
            }
            return [];
          },
        }),
      );
    },
  });

  const originalOpenWriter = storage.openWriter;
  await exportCorpusSliceFromDatabase({
    database,
    storage: {
      ...storage,
      openWriter: async (key) => {
        const writer = await originalOpenWriter(key);
        return {
          ...writer,
          write: async (bytes) => {
            await writer.write(bytes);
            if (key.endsWith("decisions.ndjson")) {
              committedIds.delete(laterId);
            }
          },
        };
      },
    },
    prefix: "snapshot",
    asOf: new Date("2026-10-20T00:00:00.000Z"),
    batchSize: 1,
  });

  expect(transactionStatements.at(0)).toContain(
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
  );
  expect(
    new TextDecoder().decode(objects.get("snapshot/citations.ndjson")),
  ).toContain(laterId);
});
