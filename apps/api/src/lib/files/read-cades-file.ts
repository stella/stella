import { Result } from "better-result";

import { CADES_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

import type {
  HandlerError,
  HandlerErrorStatusCode,
} from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  type LegalFileReadOptions,
  loadLegalFileSource,
} from "@/api/lib/files/legal-file-source";

export const readCadesFile = async <T, S extends HandlerErrorStatusCode>(
  options: LegalFileReadOptions,
  read: (
    source: ScannedFile,
    fileName: string,
  ) => Promise<Result<T, HandlerError<S>>>,
): Promise<Result<T, HandlerError<S | 404 | 409 | 422>>> => {
  const loaded = await loadLegalFileSource(options, CADES_FILE_FORMAT.kind);
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { source, fileName, deliver } = loaded.value;
  const parsed = await read(source, fileName);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return await deliver(() => parsed);
};
