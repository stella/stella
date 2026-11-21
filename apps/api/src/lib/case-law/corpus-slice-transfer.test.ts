import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_SLICE_EXPORT_TABLES,
  type CorpusSliceTransferStorage,
} from "@/api/lib/case-law/corpus-slice-transfer";
import {
  CORPUS_SLICE_SNAPSHOT_ISOLATION,
  exportCorpusSliceFromDatabase,
} from "@/api/lib/case-law/corpus-slice-transfer-execution";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { parseExportCorpusSliceArguments } from "@/api/scripts/export-corpus-slice-plan";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const decisionId = createSafeId<"caseLawDecision">();
const laterId = createSafeId<"caseLawDecision">();
const sourceId = createSafeId<"caseLawSource">();
const asOf = new Date("2026-10-20T00:00:00.000Z");

const memoryStorage = () => {
  const objects = new Map<string, Uint8Array>();
  const storage: CorpusSliceTransferStorage = {
    write: async (key, bytes) => {
      objects.set(key, bytes);
    },
    openWriter: async (key) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (bytes) => {
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
  };
  return { objects, storage };
};

/**
 * A database double whose reads see `committedIds` live, as READ COMMITTED
 * would, until the transaction issues the snapshot isolation statement.
 */
const snapshotDatabase = (committedIds: Set<string>) => {
  const decisionRows = [decisionId, laterId].map((id) => ({
    id,
    source_id: sourceId,
    court: "Snapshot Court",
    decision_date: "2026-01-01",
  }));
  return asTestRaw<CaseLawRootHandle>({
    execute: async () => {
      throw new TypeError("export read escaped its snapshot transaction");
    },
    transaction: async (
      work: Parameters<CaseLawRootHandle["transaction"]>[0],
    ) => {
      let snapshot: ReadonlySet<string> | null = null;
      const visible = () => snapshot ?? committedIds;
      let decisionPage = 0;
      return await work(
        asTestRaw({
          execute: async (query: unknown) => {
            if (typeof query !== "string") {
              throw new TypeError(
                "export issued a statement the double cannot read",
              );
            }
            if (query === CORPUS_SLICE_SNAPSHOT_ISOLATION) {
              snapshot = new Set(committedIds);
              return [];
            }
            if (query.includes("FROM case_law_published_decisions t")) {
              const row = decisionRows
                .filter(({ id }) => visible().has(id))
                .at(decisionPage);
              decisionPage += 1;
              return row === undefined ? [] : [{ row: JSON.stringify(row) }];
            }
            if (query.includes("FROM case_law_citations t")) {
              if (!visible().has(laterId)) {
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

test("all paged export reads share one repeatable-read snapshot", async () => {
  const committedIds = new Set<string>([decisionId, laterId]);
  const { objects, storage } = memoryStorage();

  const { manifestKey } = await exportCorpusSliceFromDatabase({
    database: snapshotDatabase(committedIds),
    storage: {
      ...storage,
      openWriter: async (key, contentType) => {
        const writer = await storage.openWriter(key, contentType);
        return {
          ...writer,
          write: async (bytes) => {
            await writer.write(bytes);
            // Committed by another session between two decision pages.
            if (key.endsWith("/decisions.ndjson")) {
              committedIds.delete(laterId);
            }
          },
        };
      },
    },
    prefix: "snapshot",
    asOf,
    batchSize: 1,
  });

  // Without the snapshot, the second decision page would no longer see the
  // later decision that was deleted after the first page.
  const generation = manifestKey.replace(/\/manifest\.json$/u, "");
  expect(
    new TextDecoder().decode(objects.get(`${generation}/decisions.ndjson`)),
  ).toContain(laterId);
  const published: unknown = JSON.parse(
    new TextDecoder().decode(objects.get(manifestKey)),
  );
  expect(published).toMatchObject({ corpus: { memberCount: 2 } });
});

test("a failed export to a reused prefix leaves the earlier export intact", async () => {
  const { objects, storage } = memoryStorage();
  const first = await exportCorpusSliceFromDatabase({
    database: snapshotDatabase(new Set([decisionId, laterId])),
    storage,
    prefix: "reused",
    asOf,
    batchSize: 1,
  });
  const published = new Map(objects);

  const interrupted = await rejectionOf(
    exportCorpusSliceFromDatabase({
      database: snapshotDatabase(new Set([decisionId, laterId])),
      storage: {
        ...storage,
        openWriter: async (key, contentType) => {
          const writer = await storage.openWriter(key, contentType);
          return {
            ...writer,
            write: async (bytes) => {
              await writer.write(bytes);
              if (key.endsWith("/decisions.ndjson")) {
                throw new TypeError("export interrupted");
              }
            },
          };
        },
      },
      prefix: "reused",
      asOf,
      batchSize: 1,
    }),
  );
  expect(interrupted).toBeInstanceOf(TypeError);

  for (const [key, bytes] of published) {
    expect(objects.get(key)).toEqual(bytes);
  }
  expect(
    [...objects.keys()].filter((key) => key.endsWith("/manifest.json")),
  ).toEqual([first.manifestKey]);
});
