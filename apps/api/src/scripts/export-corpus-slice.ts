import { Result } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { exportCorpusSliceFromDatabase } from "@/api/lib/case-law/corpus-slice-transfer-execution";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";
import { openCorpusS3Writer, putCorpusS3ObjectWithSignal } from "@/api/lib/s3";
import {
  CORPUS_SLICE_TRANSFER_BATCH_SIZE,
  parseExportCorpusSliceArguments,
} from "@/api/scripts/export-corpus-slice-plan";

await runScriptWithErrorOutput(async () => {
  const options = parseExportCorpusSliceArguments(process.argv.slice(2));
  if (Result.isError(options)) {
    throw options.error;
  }
  if (options.value.mode === "dry-run") {
    console.log(
      JSON.stringify({ mode: "dry-run", prefix: options.value.prefix }),
    );
    return;
  }
  const session = await openCaseLawReadOnlySession();
  const { manifestKey } = await exportCorpusSliceFromDatabase({
    database: session.rootDb,
    prefix: options.value.prefix,
    asOf: new Date(),
    batchSize: CORPUS_SLICE_TRANSFER_BATCH_SIZE,
    storage: {
      write: async (key, bytes, contentType) =>
        await putCorpusS3ObjectWithSignal({
          key,
          bytes,
          mimeType: contentType,
          signal: AbortSignal.timeout(300_000),
        }),
      openWriter: async (key, contentType) =>
        await openCorpusS3Writer({ key, mimeType: contentType }),
    },
  });
  console.log(JSON.stringify({ mode: "export", manifestKey }));
});
