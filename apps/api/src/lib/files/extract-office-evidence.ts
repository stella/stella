import { Result } from "better-result";
import * as v from "valibot";

import { SubprocessError } from "@/api/lib/errors/tagged-errors";
import { OFFICE_EVIDENCE_LIMITS } from "@/api/lib/files/office-evidence-domain";
import {
  officeEvidenceWorkerResultSchema,
  type OfficeEvidenceFormat,
  type OfficeEvidenceWorkerResult,
} from "@/api/lib/files/office-evidence-types";
import {
  resolveRuntimeWorkerPath,
  RUNTIME_WORKER_FILES,
} from "@/api/lib/runtime-worker-path";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

const WORKER_PATH = resolveRuntimeWorkerPath({
  outputFile: RUNTIME_WORKER_FILES.officeEvidence,
  sourceDir: import.meta.dir,
  sourceFile: "office-evidence-worker.ts",
});

export const extractOfficeEvidence = async (
  buffer: ArrayBuffer,
  format: OfficeEvidenceFormat,
): Promise<Result<OfficeEvidenceWorkerResult, SubprocessError>> => {
  const workerResult = await spawnBinaryWorker({
    args: [format],
    maxOutputBytes: OFFICE_EVIDENCE_LIMITS.workerOutputMaxBytes,
    stdin: new Blob([buffer]),
    timeoutMs: OFFICE_EVIDENCE_LIMITS.workerTimeoutMs,
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
