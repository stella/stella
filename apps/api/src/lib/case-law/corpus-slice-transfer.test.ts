import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { corpusSliceManifest } from "@/api/lib/case-law/corpus-slice";
import {
  buildCorpusSliceExport,
  CORPUS_SLICE_EXPORT_TABLES,
  importCorpusSlice,
} from "@/api/lib/case-law/corpus-slice-transfer";

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
      corpusTextS3Key: "case-law/example/text.json",
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
