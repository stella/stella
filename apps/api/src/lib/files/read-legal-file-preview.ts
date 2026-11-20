import { Result } from "better-result";

import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";

import type {
  HandlerError,
  HandlerErrorStatusCode,
} from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  type LegalFileReadOptions,
  loadLegalFileSource,
} from "@/api/lib/files/legal-file-source";

export const readLegalFilePreview = async <T, S extends HandlerErrorStatusCode>(
  options: LegalFileReadOptions,
  acceptedKinds: readonly LegalFileFormatKind[],
  read: (source: ScannedFile) => Promise<Result<T, HandlerError<S>>>,
): Promise<Result<T, HandlerError<S | 404 | 409 | 422>>> => {
  const loaded = await loadLegalFileSource(options, acceptedKinds);
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { source, mimeType, deliver } = loaded.value;
  const parsed = await read(source.withMimeType(mimeType));
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return await deliver(() => parsed);
};
