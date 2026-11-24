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
import type { ZipNameCodePageSource } from "@/api/lib/files/organization-zip-name-code-page";
import type { ZipNameCodePage } from "@/api/lib/files/zip-name-code-page";

/**
 * A preview reader that opens archives, as `readLegalFilePreview` takes it:
 * the organization's code page is read before the file reaches the worker.
 */
export const readingZipNames =
  <R>(
    read: (
      source: ScannedFile,
      run: { zipNameCodePage: ZipNameCodePage },
    ) => Promise<R>,
  ) =>
  async (
    source: ScannedFile,
    zipNameCodePage: ZipNameCodePageSource,
  ): Promise<R> =>
    await read(source, { zipNameCodePage: await zipNameCodePage() });

/**
 * Reads a legal file's preview with `read`, which takes the loaded file and
 * the reading organization's ZIP name code page, for a preview whose reader
 * opens archives.
 */
export const readLegalFilePreview = async <T, S extends HandlerErrorStatusCode>(
  options: LegalFileReadOptions,
  acceptedKinds: readonly LegalFileFormatKind[],
  read: (
    source: ScannedFile,
    zipNameCodePage: ZipNameCodePageSource,
  ) => Promise<Result<T, HandlerError<S>>>,
): Promise<Result<T, HandlerError<S | 404 | 409 | 422>>> => {
  const loaded = await loadLegalFileSource(options, acceptedKinds);
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { source, mimeType, deliver, zipNameCodePage } = loaded.value;
  const parsed = await read(source.withMimeType(mimeType), zipNameCodePage);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  return await deliver(() => parsed);
};
