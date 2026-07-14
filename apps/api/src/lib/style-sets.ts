import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { styleSets } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { createTemplateBuffer } from "@/api/lib/create-template-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const DOCX_EXTENSION = ".docx";

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

export const extractStyleSetBuffer = async (
  file: File,
  name: string,
): Promise<Result<Buffer, HandlerError>> => {
  const validated = validateStyleSource(file);
  if (Result.isError(validated)) {
    return Result.err(validated.error);
  }

  return await Result.tryPromise({
    try: async () =>
      await createTemplateBuffer({
        type: "style-source",
        buffer: Buffer.from(await file.arrayBuffer()),
        name,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 400,
        message: "Could not extract styles from the DOCX file.",
        cause,
      }),
  });
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

export const styleSetExportFileName = (name: string): string =>
  sanitizeFilename(`${name}.docx`);

type ReadStyleSetBufferOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  styleSetId: SafeId<"styleSet">;
};

export const readStyleSetBuffer = async ({
  safeDb,
  organizationId,
  styleSetId,
}: ReadStyleSetBufferOptions): Promise<Result<Buffer, HandlerError>> => {
  const styleSetResult = await safeDb(async (tx) => {
    const [styleSet] = await tx
      .select({ s3Key: styleSets.s3Key })
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
  const { s3Key } = styleSetResult.value;

  return await Result.tryPromise({
    try: async () => Buffer.from(await getS3().file(s3Key).arrayBuffer()),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not load the style set.",
        cause,
      }),
  });
};

export const styleSetColumns = {
  id: styleSets.id,
  name: styleSets.name,
  fileName: styleSets.fileName,
  sizeBytes: styleSets.sizeBytes,
  createdAt: styleSets.createdAt,
  updatedAt: styleSets.updatedAt,
};
