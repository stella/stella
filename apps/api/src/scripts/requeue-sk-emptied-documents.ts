import { open } from "node:fs/promises";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { loadDeferredDocumentSourceId } from "@/api/lib/legal-search/sk-document-backfill";
import {
  parseEmptiedDocumentRepairArguments,
  runEmptiedDocumentRepair,
} from "@/api/lib/legal-search/sk-emptied-document-repair-command";

/**
 * Put Slovak court decisions whose document was settled as empty back into
 * the deferred-document walk.
 *
 * A decision qualifies when its text is blank, its stored AST holds no block,
 * nothing is stored for it in the corpus, it has a document address and its
 * last fetch attempt is at or after `--since`. Requeued decisions are fetched
 * again by the running walk at its own pace, so this script sends nothing to
 * the publisher itself. Each run visits one bounded window of the source in id
 * order and prints the `--after` of the next.
 *
 *   # what one window holds (the default; writes nothing)
 *   bun run src/scripts/requeue-sk-emptied-documents.ts --since <instant>
 *
 *   # requeue it, recording every decision's outcome outside the repository
 *   bun run src/scripts/requeue-sk-emptied-documents.ts --since <instant> \
 *     --apply --reason <text> --actor <operator> --results-out <private path>
 *
 * Not a scheduled job: a deliberate operation under an operator who reads
 * the report.
 */
await runScriptWithErrorOutput(async () => {
  const parsed = parseEmptiedDocumentRepairArguments(Bun.argv.slice(2));
  if (parsed.isErr()) {
    throw parsed.error;
  }
  const command = parsed.value;

  // A path that already exists is refused rather than appended to, so one
  // file never mixes two runs.
  const resultsFile =
    command.resultsOut === null
      ? null
      : await open(command.resultsOut, "wx", 0o600);

  // A dry run only reads, so it takes no lane; a requeue writes and
  // serializes with every other maintenance pass.
  const { ingestionDb } =
    command.write.type === "dry-run"
      ? await openCaseLawReadOnlySession()
      : await enterCaseLawMaintenanceLane();

  const sourceId = await loadDeferredDocumentSourceId(
    ingestionDb,
    ADAPTER_KEYS.SK_COURTS,
  );
  if (sourceId === undefined) {
    console.log("No sk-courts source; nothing to requeue.");
    await resultsFile?.close();
    process.exit(0);
  }

  try {
    await runEmptiedDocumentRepair(command, {
      scopedDb: ingestionDb,
      sourceId,
      record: async (row) => {
        await resultsFile?.appendFile(`${JSON.stringify(row)}\n`);
      },
      write: (line) => {
        console.log(line);
      },
    });
  } finally {
    await resultsFile?.close();
  }
  process.exit(0);
});
