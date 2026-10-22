import { Result } from "better-result";
import { appendFileSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import * as v from "valibot";

import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/handlers/case-law/ingestion/adapter";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import {
  journalSkUsRawOutcome,
  readSkUsRawCheckpoint,
  persistSkUsRawCheckpoint,
} from "@/api/scripts/complete-sk-us-raw-checkpoint";
import {
  completeSkUsRawObservation,
  completedSkUsRawEnvelope,
  runSkUsRawBatch,
} from "@/api/scripts/complete-sk-us-raw-plan";

const config = v.parse(
  v.object({
    directory: v.string(),
    sourceId: v.pipe(v.string(), v.uuid()),
    rows: v.array(
      v.object({ id: v.pipe(v.string(), v.uuid()), createdAt: v.string() }),
    ),
    pageSize: v.number(),
    pauseAt: v.picklist([
      "before_write",
      "after_write",
      "after_checkpoint",
      "after_journal",
      "none",
    ]),
    pauseId: v.string(),
  }),
  JSON.parse(Bun.argv.at(2) ?? "null"),
);
const checkpointPath = `${config.directory}/checkpoint.json`;
const sourceId = brandPersistedCaseLawSourceId(config.sourceId);
const pause = async () => {
  console.info("paused");
  // The parent owns stdin and kills the process after observing this boundary.
  await Bun.stdin.text();
};
type SyncFileOptions = { path: string; text: string; flags: "a" | "w" };
const syncFile = async ({ path, text, flags }: SyncFileOptions) => {
  const file = await open(path, flags);
  await file.writeFile(text);
  await file.sync();
  await file.close();
};
const after = await readSkUsRawCheckpoint({ checkpointPath, sourceId });
const rows = config.rows.map(({ id, createdAt }) => ({
  id: brandPersistedCaseLawDecisionId(id),
  createdAt,
}));
const start =
  after === null ? 0 : rows.findIndex(({ id }) => id === after.id) + 1;
const result = await runSkUsRawBatch({
  rows: rows.slice(start),
  after,
  pageSize: config.pageSize,
  mode: "apply",
  complete: async (row) => {
    const path = `${config.directory}/${row.id}.json`;
    const stored = v.parse(
      v.object({ raw: v.string(), writes: v.number() }),
      JSON.parse(await readFile(path, "utf-8")),
    );
    return await completeSkUsRawObservation({
      raw: Result.ok(new TextEncoder().encode(stored.raw)),
      contentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      documentId: row.id,
      caseNumber: "I. ÚS 1/2020",
      mode: "apply",
      fetchListing: async () => {
        await syncFile({
          path: `${config.directory}/fetches.jsonl`,
          text: `${JSON.stringify(row.id)}\n`,
          flags: "a",
        });
        return {
          type: "listing",
          listing: JSON.stringify({ documentId: row.id }),
        };
      },
      writeCompletion: async (completion) => {
        if (row.id === config.pauseId && config.pauseAt === "before_write") {
          await pause();
        }
        await syncFile({
          path,
          text: JSON.stringify({
            raw: completedSkUsRawEnvelope(completion),
            writes: stored.writes + 1,
          }),
          flags: "w",
        });
        if (row.id === config.pauseId && config.pauseAt === "after_write") {
          await pause();
        }
        return "completed";
      },
    });
  },
  // The script writes this line to stdout; the worker keeps it beside its
  // other evidence files.
  record: (cursor, outcome) => {
    appendFileSync(
      `${config.directory}/records.jsonl`,
      `${JSON.stringify({ id: cursor.id, outcome })}\n`,
    );
  },
  journal: async (cursor, outcome) => {
    await journalSkUsRawOutcome({ checkpointPath, sourceId, cursor, outcome });
    if (cursor.id === config.pauseId && config.pauseAt === "after_journal") {
      await pause();
    }
  },
  checkpoint: async (cursor, outcome) => {
    await persistSkUsRawCheckpoint({
      checkpointPath,
      sourceId,
      cursor,
      outcome,
    });
    if (cursor.id === config.pauseId && config.pauseAt === "after_checkpoint") {
      await pause();
    }
  },
});
console.info(JSON.stringify(result));
