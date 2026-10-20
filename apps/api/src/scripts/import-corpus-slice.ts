import { Result } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";

import { importCorpusSliceIntoDatabase } from "@/api/lib/case-law/corpus-slice-transfer-execution";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { putCorpusS3ObjectWithSignal, readCorpusS3Bytes } from "@/api/lib/s3";
import { parseImportCorpusSliceArguments } from "@/api/scripts/import-corpus-slice-plan";

await runScriptWithErrorOutput(async () => {
  const options = parseImportCorpusSliceArguments(process.argv.slice(2));
  if (Result.isError(options)) {
    throw options.error;
  }
  if (options.value.mode === "dry-run") {
    console.log(
      JSON.stringify({ mode: "dry-run", prefix: options.value.prefix }),
    );
    return;
  }
  const lane = await enterCaseLawMaintenanceLane();
  const result = await importCorpusSliceIntoDatabase({
    prefix: options.value.prefix,
    storage: {
      read: async (key) =>
        await readCorpusS3Bytes(key, AbortSignal.timeout(300_000)),
      write: async (key, bytes, contentType) =>
        await putCorpusS3ObjectWithSignal({
          key,
          bytes,
          mimeType: contentType,
          signal: AbortSignal.timeout(300_000),
        }),
    },
    ingestionDatabase: lane.ingestionDb,
  });
  await lane.release();
  if (Result.isError(result)) {
    throw result.error;
  }
  console.log(JSON.stringify({ mode: "import", ...result.value }));
});
