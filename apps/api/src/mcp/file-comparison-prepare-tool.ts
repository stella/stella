import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
/**
 * `prepare_file_comparison`: reserve short-lived storage for two DOCX files
 * stella does not hold, so `compare_documents` can redline them. It owns no
 * comparison logic and writes nothing durable: two rows, two presigned PUTs,
 * and the next call spelled out. The reservation itself is shared with the
 * staging tools that move the bytes server-side.
 */
import * as v from "valibot";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";

import { fileComparisonUploads } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { projectionPayload } from "@/api/lib/projection-totality";
import { presignUploadUrl } from "@/api/lib/s3-presign";
import type { PresignedUploadHeaders } from "@/api/lib/s3-presign";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  FILE_COMPARISON_INPUT_TTL_SECONDS,
  FILE_COMPARISON_ORGANIZATION_OUTSTANDING_BYTE_LIMIT,
  FILE_COMPARISON_ORGANIZATION_OUTSTANDING_ROW_LIMIT,
  FILE_COMPARISON_OUTSTANDING_BYTE_LIMIT,
  FILE_COMPARISON_OUTSTANDING_ROW_LIMIT,
  fileComparisonExpiry,
  fileComparisonObjectKey,
  readOutstandingFileComparisonCapacity,
} from "@/api/lib/uploads/file-comparison/uploads";
import { PRESIGN_URL_EXPIRY_SECONDS } from "@/api/lib/uploads/runtime";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type {
  InternalToolErrorResult,
  TypedMcpToolHandler,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import {
  internalFailureResult,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** The enforced ceiling, and the number every staging description renders. */
export const FILE_COMPARISON_MAX_BYTES = FILE_SIZE_LIMIT_BYTES.document;
export const FILE_COMPARISON_MAX_MEGABYTES = String(
  Math.floor(FILE_COMPARISON_MAX_BYTES / (1024 * 1024)),
);

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * The digest, read rather than pattern-matched at the schema: an uppercase or
 * padded spelling of the same 32 bytes is the same checksum, so it is
 * normalised here instead of rejected with a regex the caller cannot act on.
 * Only a value that is no SHA-256 at all fails, and it fails naming the field.
 */
const sha256HexSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.check(
    (value) => SHA256_HEX.test(value),
    "Expected a SHA-256 digest as 64 hexadecimal characters",
  ),
  v.description(
    "SHA-256 of the exact bytes you will PUT, as 64 hexadecimal characters.",
  ),
);

export const fileComparisonSideDescription = (side: ComparisonSide): string =>
  side === "base"
    ? "The file the redline compares from."
    : "The file the redline compares to.";

const comparisonFileSchema = (side: ComparisonSide) =>
  v.pipe(
    v.strictObject({
      name: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1),
        v.maxLength(255),
        v.description(
          "File name to show the user, including the .docx suffix.",
        ),
      ),
      size: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(FILE_COMPARISON_MAX_BYTES),
        v.description(
          `Exact byte length of the file, at most ${FILE_COMPARISON_MAX_MEGABYTES} MB.`,
        ),
      ),
      sha256_hex: sha256HexSchema,
    }),
    v.description(fileComparisonSideDescription(side)),
  );

const PREPARE_FILE_COMPARISON_INPUT_SCHEMA = nullAsAbsent(
  v.strictObject({
    base: comparisonFileSchema("base"),
    target: comparisonFileSchema("target"),
  }),
);

const preparedUploadSchema = v.strictObject({
  uploadId: v.string(),
  url: v.string(),
  headers: v.record(v.string(), v.string()),
  expiresAt: v.string(),
});

const PREPARE_FILE_COMPARISON_OUTPUT_SCHEMA = v.strictObject({
  base: preparedUploadSchema,
  target: preparedUploadSchema,
  next: v.strictObject({
    tool: v.literal(FILE_COMPARISON_TRANSPORT.compareToolName),
    source: v.strictObject({
      type: v.literal("uploads"),
      base_upload_id: v.string(),
      target_upload_id: v.string(),
    }),
  }),
});

export type PrepareFileComparisonOutput = v.InferInput<
  typeof PREPARE_FILE_COMPARISON_OUTPUT_SCHEMA
>;

export const PREPARE_FILE_COMPARISON_TOOL_DEFINITION = defineValibotMcpTool({
  consumesServices: false,
  annotations: {
    title: "Prepare file comparison",
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Reserve upload slots for redlining two .docx files that are not stored " +
    "in stella, for a client that can PUT the bytes itself (the CLI, a " +
    `script). In a chat, ${FILE_COMPARISON_TRANSPORT.pickerToolName} provides a picker ` +
    "panel that uploads from the user's browser; " +
    `${FILE_COMPARISON_TRANSPORT.linksToolName} accepts files reachable ` +
    "by HTTPS link. Both files must be .docx and at most " +
    `${FILE_COMPARISON_MAX_MEGABYTES} MB. PUT each file's bytes to its url ` +
    "with the returned headers sent verbatim: the URL is signed against that " +
    "exact size and checksum. Then call " +
    `${FILE_COMPARISON_TRANSPORT.compareToolName} with the echoed ` +
    "next.source, within the hour. The staged files and the redline are " +
    "temporary and never become a document, a version, or matter content.",
  inputSchema: PREPARE_FILE_COMPARISON_INPUT_SCHEMA,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["check", "to_lower_case", "trim"],
    reason:
      "Whitespace and digest case are normalised by the runtime schema and the digest predicate stays enforced there; neither is a spelling constraint the projection should advertise.",
  },
  access: "write",
  accountAccess: "sandbox",
  nonDestructiveReason:
    "Creates temporary comparison upload reservations without modifying existing stored documents or versions.",
  permissions: { type: "all", permissions: { entity: ["update"] } },
  anonymized: { exposure: "excluded", reason: "write" },
  name: FILE_COMPARISON_TRANSPORT.prepareToolName,
  scope: "stella:documents_write",
});

export const PREPARE_FILE_COMPARISON_OUTPUT_CONTRACT = defineMcpToolOutput(
  PREPARE_FILE_COMPARISON_OUTPUT_SCHEMA,
);

type PrepareToolInput = v.InferOutput<
  typeof PREPARE_FILE_COMPARISON_INPUT_SCHEMA
>;

export type ComparisonSide = "base" | "target";

/** One side of a comparison, however the caller's bytes were obtained. */
export type FileComparisonInputFile = {
  name: string;
  sha256Hex: string;
  size: number;
};

export type ReservedUpload = {
  declaredName: string;
  declaredSha256: string;
  declaredSize: number;
  headers: PresignedUploadHeaders;
  id: SafeId<"fileComparisonUpload">;
  url: string;
};

type ReservedInput = Omit<ReservedUpload, "headers" | "url">;

export type PrepareFileComparisonDependencies = {
  presignUploadUrl: typeof presignUploadUrl;
};

const DEFAULT_PREPARE_FILE_COMPARISON_DEPENDENCIES: PrepareFileComparisonDependencies =
  {
    presignUploadUrl,
  };

const presignInput = async ({
  userId,
  dependencies,
  organizationId,
  reservation,
}: {
  dependencies: PrepareFileComparisonDependencies;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  reservation: ReservedInput;
}): Promise<Result<ReservedUpload, unknown>> => {
  const presigned = await dependencies.presignUploadUrl({
    userId,
    key: fileComparisonObjectKey({
      organizationId,
      uploadId: reservation.id,
    }),
    expiresIn: PRESIGN_URL_EXPIRY_SECONDS,
    contentType: DOCX_MIME_TYPE,
    contentLength: reservation.declaredSize,
    sha256Base64: Buffer.from(reservation.declaredSha256, "hex").toString(
      "base64",
    ),
    scope: { organizationId, workspaceId: null },
    tagAsTemporaryUpload: true,
  });
  if (Result.isError(presigned)) {
    return Result.err(presigned.error);
  }
  return Result.ok({
    ...reservation,
    headers: presigned.value.headers,
    url: presigned.value.url,
  });
};

const reserveInput = (file: FileComparisonInputFile): ReservedInput => ({
  declaredName: sanitizeFilename(file.name),
  declaredSha256: file.sha256Hex,
  declaredSize: file.size,
  id: createSafeId<"fileComparisonUpload">(),
});

type ReservedFileComparisonInputs = {
  base: ReservedUpload;
  target: ReservedUpload;
  urlExpiresAt: string;
};

const RESERVATION_EXPIRY_FAILURE_SINK = failureSink({
  event: "file_comparison.expire_unpresigned_reservation_failed",
  expected: [],
});

const expireReservedInputs = async ({
  context,
  uploadIds,
}: {
  context: AuthorizedMcpRequestContext;
  uploadIds: readonly [
    SafeId<"fileComparisonUpload">,
    SafeId<"fileComparisonUpload">,
  ];
}): Promise<void> => {
  const expired = await context.safeDb(async (tx) => {
    await tx
      .update(fileComparisonUploads)
      .set({ expiresAt: new Date() })
      .where(
        and(
          inArray(fileComparisonUploads.id, uploadIds),
          eq(fileComparisonUploads.organizationId, context.organizationId),
          eq(fileComparisonUploads.userId, context.userId),
          eq(fileComparisonUploads.status, "pending"),
        ),
      );
    await context.recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.FILE_COMPARISON,
      resourceId: uploadIds[0],
      metadata: {
        baseUploadId: uploadIds[0],
        targetUploadId: uploadIds[1],
        reason: "presign_failed",
      },
      workspaceId: null,
    });
  });
  if (Result.isError(expired)) {
    observeFailure(expired.error, {
      sink: RESERVATION_EXPIRY_FAILURE_SINK,
      ctx: { stage: "expire-unpresigned-reservation" },
    });
  }
};

/**
 * The staging every entry point shares: two presigned slots, two pending rows,
 * one audit event. A failure comes back as the envelope the tool returns, so a
 * caller adds no error vocabulary of its own.
 */
export const reserveFileComparisonInputs = async ({
  base,
  context,
  dependencies,
  target,
}: {
  base: FileComparisonInputFile;
  context: AuthorizedMcpRequestContext;
  dependencies: PrepareFileComparisonDependencies;
  target: FileComparisonInputFile;
}): Promise<Result<ReservedFileComparisonInputs, InternalToolErrorResult>> => {
  const { organizationId, userId } = context;
  const reservedBase = reserveInput(base);
  const reservedTarget = reserveInput(target);

  const expiresAt = fileComparisonExpiry(FILE_COMPARISON_INPUT_TTL_SECONDS);
  const rows = [reservedBase, reservedTarget].map((upload) => ({
    declaredName: upload.declaredName,
    declaredSha256: upload.declaredSha256,
    declaredSize: upload.declaredSize,
    expiresAt,
    id: upload.id,
    kind: "input" as const,
    organizationId,
    status: "pending" as const,
    userId,
  }));

  const inserted = await context.safeDb(async (tx) => {
    await withAggregateLock({
      aggregate: "fileComparisonCapacity",
      id: { organizationId },
      tx,
    });
    const outstanding = await readOutstandingFileComparisonCapacity(tx);
    const requestedBytes = base.size + target.size;
    if (
      outstanding.userRows + rows.length >
        FILE_COMPARISON_OUTSTANDING_ROW_LIMIT ||
      outstanding.userBytes + requestedBytes >
        FILE_COMPARISON_OUTSTANDING_BYTE_LIMIT ||
      outstanding.organizationRows + rows.length >
        FILE_COMPARISON_ORGANIZATION_OUTSTANDING_ROW_LIMIT ||
      outstanding.organizationBytes + requestedBytes >
        FILE_COMPARISON_ORGANIZATION_OUTSTANDING_BYTE_LIMIT
    ) {
      return "at_capacity" as const;
    }

    await tx.insert(fileComparisonUploads).values(rows);
    // Sizes only: the names are the caller's, and the bytes are never
    // this organization's content to begin with.
    await context.recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.FILE_COMPARISON,
      resourceId: reservedBase.id,
      metadata: {
        baseUploadId: reservedBase.id,
        targetUploadId: reservedTarget.id,
        baseSizeBytes: reservedBase.declaredSize,
        targetSizeBytes: reservedTarget.declaredSize,
      },
      workspaceId: null,
    });
    return "admitted" as const;
  });
  if (Result.isError(inserted)) {
    return Result.err(internalFailureResult(inserted.error));
  }
  if (inserted.value === "at_capacity") {
    return Result.err(
      structuredErrorResult({
        code: "rate_limited",
        message: "Too many temporary comparison files are still retained",
        hint: "Use an existing reservation, or retry after earlier comparison files are consumed or expire.",
        retryable: true,
      }),
    );
  }

  const [presignedBase, presignedTarget] = await Promise.all([
    presignInput({
      dependencies,
      organizationId,
      reservation: reservedBase,
      userId,
    }),
    presignInput({
      dependencies,
      organizationId,
      reservation: reservedTarget,
      userId,
    }),
  ]);
  if (Result.isError(presignedBase)) {
    await expireReservedInputs({
      context,
      uploadIds: [reservedBase.id, reservedTarget.id],
    });
    return Result.err(internalFailureResult(presignedBase.error));
  }
  if (Result.isError(presignedTarget)) {
    await expireReservedInputs({
      context,
      uploadIds: [reservedBase.id, reservedTarget.id],
    });
    return Result.err(internalFailureResult(presignedTarget.error));
  }

  return Result.ok({
    base: presignedBase.value,
    target: presignedTarget.value,
    // Two deadlines, and the output carries the earlier one because it is the
    // one the client acts on: the signed PUT dies well before the row does.
    urlExpiresAt: fileComparisonExpiry(
      PRESIGN_URL_EXPIRY_SECONDS,
    ).toISOString(),
  });
};

export const fileComparisonPermissionDenied = (): InternalToolErrorResult =>
  structuredErrorResult({
    code: "permission_denied",
    message: "Your role cannot create document comparisons",
    hint: "Ask an organization admin for a role that may update documents.",
  });

const toInputFile = ({
  name,
  sha256_hex: sha256Hex,
  size,
}: PrepareToolInput["base"]): FileComparisonInputFile => ({
  name,
  sha256Hex,
  size,
});

export const handlePrepareFileComparisonTool = async (
  {
    args,
    context,
  }: { args: Record<string, unknown>; context: AuthorizedMcpRequestContext },
  dependencies: PrepareFileComparisonDependencies = DEFAULT_PREPARE_FILE_COMPARISON_DEPENDENCIES,
): Promise<TypedMcpToolResponse<PrepareFileComparisonOutput>> => {
  const parsed = v.safeParse(PREPARE_FILE_COMPARISON_INPUT_SCHEMA, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
    return fileComparisonPermissionDenied();
  }

  const reserved = await reserveFileComparisonInputs({
    base: toInputFile(input.base),
    context,
    dependencies,
    target: toInputFile(input.target),
  });
  if (Result.isError(reserved)) {
    return reserved.error;
  }
  const { base, target, urlExpiresAt } = reserved.value;

  return toolDataResult(
    projectionPayload(PREPARE_FILE_COMPARISON_OUTPUT_SCHEMA, {
      base: {
        uploadId: base.id,
        url: base.url,
        headers: base.headers,
        expiresAt: urlExpiresAt,
      },
      target: {
        uploadId: target.id,
        url: target.url,
        headers: target.headers,
        expiresAt: urlExpiresAt,
      },
      next: {
        tool: FILE_COMPARISON_TRANSPORT.compareToolName,
        source: {
          type: "uploads",
          base_upload_id: base.id,
          target_upload_id: target.id,
        },
      },
    }),
  );
};

/** The handler's extra dependency argument is optional, so it still is one. */
handlePrepareFileComparisonTool satisfies TypedMcpToolHandler<PrepareFileComparisonOutput>;
