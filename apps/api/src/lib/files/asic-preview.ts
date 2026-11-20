import { Result } from "better-result";
import * as v from "valibot";

import { PREVIEW_UNAVAILABLE_ERROR_CODE } from "@stll/api-contract";
import { asicPreviewSchema } from "@stll/api-contract/asic";
import { classifyFailure } from "@stll/errors";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  ASIC_CONTAINER_MAX_BYTES,
  ASIC_PREVIEW_WORKER_EXIT,
  ASIC_PREVIEW_WORKER_MODE,
} from "@/api/lib/files/asic-preview-protocol";
import { LIMITS } from "@/api/lib/limits";
import { EXTRACTION_WORKER_PATH } from "@/api/lib/search/extract-content";
import { spawnBinaryWorker } from "@/api/lib/subprocess";

const previewReplySchema = v.pipe(v.string(), v.parseJson(), asicPreviewSchema);
const ASIC_PREVIEW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const unavailable = (message: string) =>
  new HandlerError({
    status: 422,
    code: PREVIEW_UNAVAILABLE_ERROR_CODE,
    message,
  });

export const readAsicPreview = async (
  source: ScannedFile,
  expectedMimeType = source.mimeType,
): Promise<
  Result<v.InferOutput<typeof asicPreviewSchema>, HandlerError<422 | 500 | 503>>
> => {
  const { bytes } = source;
  if (bytes.byteLength > ASIC_CONTAINER_MAX_BYTES) {
    return Result.err(
      unavailable("The ASiC file exceeds the preview size limit"),
    );
  }

  const result = await spawnBinaryWorker({
    workerPath: EXTRACTION_WORKER_PATH,
    args: [
      ASIC_PREVIEW_WORKER_MODE,
      String(LIMITS.extractedContentMaxChars),
      expectedMimeType,
    ],
    stdin: new Blob([bytes]),
    timeoutMs: LIMITS.extractionTimeoutMs,
    maxOutputBytes: ASIC_PREVIEW_MAX_OUTPUT_BYTES,
  });
  if (result.isErr()) {
    const { exitCode } = result.error;
    if (exitCode === ASIC_PREVIEW_WORKER_EXIT.unreadable) {
      return Result.err(unavailable("The ASiC file could not be read"));
    }
    if (exitCode === ASIC_PREVIEW_WORKER_EXIT.rejected) {
      return Result.err(
        unavailable("An embedded file did not pass the security scan"),
      );
    }
    return Result.err(
      new HandlerError({
        status: 503,
        code: "upstream_unavailable",
        message: "The ASiC reader is unavailable",
        cause: result.error,
      }),
    );
  }

  const parsed = v.safeParse(
    previewReplySchema,
    new TextDecoder().decode(result.value),
  );
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        classifyFailure(
          new HandlerError({
            status: 500,
            message: "Invalid response from the ASiC reader",
          }),
          "response_invalid",
        ),
      );
};
