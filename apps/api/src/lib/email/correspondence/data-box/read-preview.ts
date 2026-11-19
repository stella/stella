import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { LIMITS } from "@/api/lib/limits";
import { EXTRACTION_WORKER_PATH } from "@/api/lib/search/extract-content";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

import {
  DATA_BOX_PREVIEW_MODE,
  dataBoxPreviewResultSchema,
} from "./preview-contract";

export const readDataBoxPreview = async ({ bytes }: ScannedFile) => {
  const result = await spawnBinaryWorker({
    workerPath: EXTRACTION_WORKER_PATH,
    args: [DATA_BOX_PREVIEW_MODE],
    stdin: new Blob([bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  if (result.isErr()) {
    return Result.err(
      new HandlerError({
        status: 503,
        code: "upstream_unavailable",
        message: "The data-box reader is unavailable",
        cause: result.error,
      }),
    );
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), dataBoxPreviewResultSchema),
    new TextDecoder().decode(result.value),
  );
  if (!parsed.success) {
    // The worker broke its own output contract: a defect, not an outage.
    return Result.err(
      classifyFailure(
        new HandlerError({
          status: 500,
          message: "Invalid response from the data-box reader",
        }),
        "response_invalid",
      ),
    );
  }
  if (parsed.output.kind === "unreadable") {
    return Result.err(
      new HandlerError({
        status: 422,
        code: PREVIEW_UNAVAILABLE_ERROR_CODE,
        message:
          "This file could not be read as a data-box message or delivery receipt",
      }),
    );
  }
  return Result.ok(parsed.output);
};
