/**
 * A stored template's document, read back as a `ScannedFile`.
 *
 * `templates.s3_key` names the current version's file and
 * `template_versions.s3_key` each version's; every row records the file's
 * scan state beside its key. Writers store files through `writeScannedObject`,
 * so a row says `scanned` only for bytes that passed the scan. A row from
 * before scan states were recorded is scanned on its first read here, and then
 * every row naming that key, in both tables, is marked.
 */
import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { StoredFileScanState } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { scanErrorForHandler } from "@/api/lib/file-scan/scan-upload";
import type { scanUpload } from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  readStoredObject,
  storedObject,
} from "@/api/lib/file-scan/stored-object";
import { recordTemplateFileScanned } from "@/api/lib/templates/write-template";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const DEFAULT_TEMPLATE_FILE_NAME = "template.docx";

/** The columns a template or template version row names its file with. */
export const STORED_TEMPLATE_FILE_COLUMNS = {
  s3Key: true,
  scanState: true,
} as const;

type ReadStoredTemplateFileOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  row: { s3Key: string; scanState: StoredFileScanState };
  fileName?: string | undefined;
  scan?: typeof scanUpload | undefined;
};

/**
 * The template file a row names. A rejected file answers with the structured
 * 422 and never reaches a parser; a scanner failure is a retryable 503, and an
 * unreadable object a 500.
 */
export const readStoredTemplateFile = async ({
  safeDb,
  organizationId,
  row,
  fileName = DEFAULT_TEMPLATE_FILE_NAME,
  scan,
}: ReadStoredTemplateFileOptions): Promise<
  Result<ScannedFile, HandlerError<422 | 500 | 503>>
> => {
  const read = await Result.tryPromise({
    try: async () =>
      await readStoredObject({
        object: storedObject({ key: row.s3Key, scanState: row.scanState }),
        fileName,
        mimeType: DOCX_MIME_TYPE,
        markScanned: async (object) =>
          await recordTemplateFileScanned({ safeDb, organizationId, object }),
        scan,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not read the stored template",
        cause,
      }),
  });
  return read.andThen((scanned) =>
    Result.mapError(scanned, (error) =>
      scanErrorForHandler(
        error,
        "Retry the request; the stored template was not changed.",
      ),
    ),
  );
};
