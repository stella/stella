import { Result } from "better-result";
import * as v from "valibot";

import { SubprocessError } from "@/api/lib/errors/tagged-errors";
import {
  officeEvidenceWorkerResultSchema,
  type OfficeEvidenceFormat,
  type OfficeEvidenceWorkerResult,
} from "@/api/lib/files/office-evidence-types";
import { LIMITS } from "@/api/lib/limits";
import { resolveRuntimeWorkerPath } from "@/api/lib/runtime-worker-path";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: "office-evidence-worker.js",
  sourceDir: import.meta.dir,
  sourceFile: "office-evidence-worker.ts",
});

export const extractOfficeEvidence = async (
  buffer: ArrayBuffer,
  format: OfficeEvidenceFormat,
): Promise<Result<OfficeEvidenceWorkerResult, SubprocessError>> => {
  const workerResult = await spawnBinaryWorker({
    args: [format],
    maxOutputBytes: LIMITS.officeCitationWorkerOutputMaxBytes,
    stdin: new Blob([buffer]),
    timeoutMs: LIMITS.officeCitationWorkerTimeoutMs,
    workerPath: WORKER_PATH,
  });
  if (Result.isError(workerResult)) {
    return workerResult;
  }

  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(workerResult.value),
    );
    const parsed = v.safeParse(officeEvidenceWorkerResultSchema, value);
    if (!parsed.success) {
      return Result.err(
        new SubprocessError({
          exitCode: 0,
          message: "Office evidence worker returned an invalid result",
        }),
      );
    }
    return Result.ok(parsed.output);
  } catch (error) {
    return Result.err(
      new SubprocessError({
        cause: error,
        exitCode: 0,
        message: "Office evidence worker returned invalid JSON",
      }),
    );
  }
};
