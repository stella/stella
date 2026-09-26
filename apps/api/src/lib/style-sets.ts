import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { styleSets } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createTemplateBuffer } from "@/api/lib/docx-authoring/create-template-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  scanErrorForHandler,
  scanUploadForHandler,
} from "@/api/lib/file-scan/scan-upload";
import type { scanUpload } from "@/api/lib/file-scan/scan-upload";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import {
  readStoredObject,
  storedObject,
} from "@/api/lib/file-scan/stored-object";
import type { ScannedObject } from "@/api/lib/file-scan/stored-object";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const DOCX_EXTENSION = ".docx";
export const STYLE_SET_DOWNLOAD_TTL_SECONDS = 15 * 60;

export const normalizeStyleSetName = (
  name: string,
): Result<string, HandlerError> => {
  const normalized = name.trim();
  if (normalized === "") {
    return Result.err(
      new HandlerError({ status: 400, message: "Name must not be blank" }),
    );
  }
  return Result.ok(normalized);
};

export const validateStyleSource = (file: File): Result<void, HandlerError> => {
  if (
    file.type === DOCX_MIME_TYPE ||
    file.name.toLowerCase().endsWith(DOCX_EXTENSION)
  ) {
    return Result.ok();
  }

  return Result.err(
    new HandlerError({
      status: 400,
      message: "Invalid style source. Expected a DOCX file.",
    }),
  );
};

export const styleSetExportFileName = (name: string): string =>
  sanitizeFilenamePreservingExtension(`${name}.docx`);

/**
 * A server-built style-set package, scanned like an upload before it is
 * stored, so the row that names it can record it as scanned.
 */
export const scanStyleSetPackage = async (
  buffer: Buffer,
  name: string,
): Promise<Result<ScannedFile, HandlerError<422 | 503>>> =>
  await scanUploadForHandler({
    bytes: buffer,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: styleSetExportFileName(name),
  });

export const extractStyleSetFile = async (
  file: File,
  name: string,
): Promise<Result<ScannedFile, HandlerError>> => {
  const validated = validateStyleSource(file);
  if (Result.isError(validated)) {
    return Result.err(validated.error);
  }

  const scanned = await scanUploadForHandler({
    bytes: await file.arrayBuffer(),
    declaredMimeType: DOCX_MIME_TYPE,
    fileName: sanitizeFilenamePreservingExtension(file.name),
  });
  if (Result.isError(scanned)) {
    return scanned;
  }

  const built = await Result.tryPromise({
    try: async () =>
      await createTemplateBuffer({
        type: "style-source",
        file: scanned.value,
        name,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "Could not extract styles from the DOCX file.",
        cause,
      }),
  });
  if (Result.isError(built)) {
    return built;
  }
  return await scanStyleSetPackage(built.value, name);
};

type BuildStyleSetKeyOptions = {
  organizationId: SafeId<"organization">;
  styleSetId: SafeId<"styleSet">;
};

export const buildStyleSetKey = ({
  organizationId,
  styleSetId,
}: BuildStyleSetKeyOptions): string =>
  `${organizationId}/style-sets/${styleSetId}/${Bun.randomUUIDv7()}.docx`;

type ReadStyleSetPackageOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  styleSetId: SafeId<"styleSet">;
};

const markStyleSetPackageScanned = async ({
  safeDb,
  organizationId,
  styleSetId,
  object,
}: ReadStyleSetPackageOptions & { object: ScannedObject }) =>
  await safeDb(async (tx) => {
    // audit: skip — records the scan verdict for a package already stored; the style set's content and metadata do not change
    await tx
      .update(styleSets)
      .set({ scanState: object.scanState })
      .where(
        and(
          eq(styleSets.id, styleSetId),
          eq(styleSets.organizationId, organizationId),
          eq(styleSets.s3Key, object.key),
          eq(styleSets.scanState, "unscanned"),
        ),
      );
  });

/**
 * The style set's current package as a `ScannedFile`. A package stored before
 * scan states were recorded is scanned on this read and its row marked; one
 * the scan refuses answers with the structured 422 and never reaches a parser.
 */
export const readStyleSetPackage = async ({
  safeDb,
  organizationId,
  styleSetId,
  scan,
}: ReadStyleSetPackageOptions & {
  scan?: typeof scanUpload | undefined;
}): Promise<
  Result<{ file: ScannedFile; name: string; updatedAt: Date }, HandlerError>
> => {
  const styleSetResult = await safeDb(async (tx) => {
    const [styleSet] = await tx
      .select({
        name: styleSets.name,
        s3Key: styleSets.s3Key,
        scanState: styleSets.scanState,
        updatedAt: styleSets.updatedAt,
      })
      .from(styleSets)
      .where(
        and(
          eq(styleSets.id, styleSetId),
          eq(styleSets.organizationId, organizationId),
          isNull(styleSets.deletedAt),
        ),
      )
      .limit(1);
    return styleSet;
  });
  if (Result.isError(styleSetResult)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Could not read the style set.",
        cause: styleSetResult.error,
      }),
    );
  }
  if (!styleSetResult.value) {
    return Result.err(
      new HandlerError({ status: 404, message: "Style set not found" }),
    );
  }
  const { name, s3Key, scanState, updatedAt } = styleSetResult.value;

  const read = await Result.tryPromise({
    try: async () =>
      await readStoredObject({
        object: storedObject({ key: s3Key, scanState }),
        fileName: styleSetExportFileName(name),
        mimeType: DOCX_MIME_TYPE,
        markScanned: async (object) =>
          await markStyleSetPackageScanned({
            safeDb,
            organizationId,
            styleSetId,
            object,
          }),
        scan,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not load the style set.",
        cause,
      }),
  });
  if (Result.isError(read)) {
    return Result.err(read.error);
  }
  const scanned = read.value;
  if (Result.isError(scanned)) {
    return Result.err(
      scanErrorForHandler(
        scanned.error,
        "Retry the request; the stored style set was not changed.",
      ),
    );
  }
  return Result.ok({ file: scanned.value, name, updatedAt });
};

export const readStyleSetFile = async (
  options: ReadStyleSetPackageOptions,
): Promise<Result<ScannedFile, HandlerError>> => {
  const styleSetPackage = await readStyleSetPackage(options);
  if (Result.isError(styleSetPackage)) {
    return Result.err(styleSetPackage.error);
  }
  return Result.ok(styleSetPackage.value.file);
};

export const styleSetColumns = {
  id: styleSets.id,
  name: styleSets.name,
  fileName: styleSets.fileName,
  sizeBytes: styleSets.sizeBytes,
  createdAt: styleSets.createdAt,
  updatedAt: styleSets.updatedAt,
};
