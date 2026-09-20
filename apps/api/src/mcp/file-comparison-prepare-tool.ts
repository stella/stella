/**
 * `prepare_file_comparison`: reserve short-lived storage for two DOCX files
 * stella does not hold, so `compare_documents` can redline them. It owns no
 * comparison logic and writes nothing durable: two rows, two presigned PUTs,
 * and the next call spelled out.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { fileComparisonUploads } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { presignUploadUrl } from "@/api/lib/s3-presign";
import type { PresignedUploadHeaders } from "@/api/lib/s3-presign";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  FILE_COMPARISON_INPUT_TTL_SECONDS,
  fileComparisonExpiry,
  fileComparisonObjectKey,
} from "@/api/lib/uploads/file-comparison/uploads";
import { PRESIGN_URL_EXPIRY_SECONDS } from "@/api/lib/uploads/runtime";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type {
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
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const MAX_FILE_BYTES = FILE_SIZE_LIMIT_BYTES.document;
const MAX_FILE_MEGABYTES = String(Math.floor(MAX_FILE_BYTES / (1024 * 1024)));

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

const comparisonFileSchema = (side: "base" | "target") =>
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
        v.maxValue(MAX_FILE_BYTES),
        v.description(
          `Exact byte length of the file, at most ${MAX_FILE_MEGABYTES} MB.`,
        ),
      ),
      sha256_hex: sha256HexSchema,
    }),
    v.description(
      side === "base"
        ? "The file the redline compares from."
        : "The file the redline compares to.",
    ),
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
    tool: v.literal("compare_documents"),
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
  annotations: {
    title: "Prepare file comparison",
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Reserve upload slots for redlining two .docx files that are not stored " +
    "in stella. Both files must be .docx and at most " +
    `${MAX_FILE_MEGABYTES} MB. PUT each file's bytes to its url with the ` +
    "returned headers sent verbatim: the URL is signed against that exact " +
    "size and checksum, so any deviation is refused. Then call " +
    "compare_documents with the echoed next.source, within the hour. The " +
    "staged files and the redline are temporary: they never become a " +
    "document, a version, or matter content, and both are deleted once the " +
    "comparison has run.",
  inputSchema: PREPARE_FILE_COMPARISON_INPUT_SCHEMA,
  jsonSchemaProjectionWaiver: {
    ignoreActions: ["check", "to_lower_case", "trim"],
    reason:
      "Whitespace and digest case are normalised by the runtime schema and the digest predicate stays enforced there; neither is a spelling constraint the projection should advertise.",
  },
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: "prepare_file_comparison",
  scope: "stella:documents_write",
});

export const PREPARE_FILE_COMPARISON_OUTPUT_CONTRACT = defineMcpToolOutput(
  PREPARE_FILE_COMPARISON_OUTPUT_SCHEMA,
);

type PrepareToolInput = v.InferOutput<
  typeof PREPARE_FILE_COMPARISON_INPUT_SCHEMA
>;

type ReservedUpload = {
  declaredName: string;
  declaredSha256: string;
  declaredSize: number;
  headers: PresignedUploadHeaders;
  id: SafeId<"fileComparisonUpload">;
  url: string;
};

export type PrepareFileComparisonDependencies = {
  presignUploadUrl: typeof presignUploadUrl;
};

const DEFAULT_PREPARE_FILE_COMPARISON_DEPENDENCIES: PrepareFileComparisonDependencies =
  { presignUploadUrl };

const presignInput = async ({
  dependencies,
  file,
  organizationId,
}: {
  dependencies: PrepareFileComparisonDependencies;
  file: PrepareToolInput["base"];
  organizationId: SafeId<"organization">;
}): Promise<Result<ReservedUpload, unknown>> => {
  const id = createSafeId<"fileComparisonUpload">();
  const presigned = await dependencies.presignUploadUrl({
    key: fileComparisonObjectKey({ organizationId, uploadId: id }),
    expiresIn: PRESIGN_URL_EXPIRY_SECONDS,
    contentType: DOCX_MIME_TYPE,
    contentLength: file.size,
    sha256Base64: Buffer.from(file.sha256_hex, "hex").toString("base64"),
    scope: { organizationId, workspaceId: null },
    tagAsTemporaryUpload: true,
  });
  if (Result.isError(presigned)) {
    return Result.err(presigned.error);
  }
  return Result.ok({
    declaredName: sanitizeFilename(file.name),
    declaredSha256: file.sha256_hex,
    declaredSize: file.size,
    headers: presigned.value.headers,
    id,
    url: presigned.value.url,
  });
};

export const handlePrepareFileComparisonTool = async (
  {
    args,
    context,
  }: { args: Record<string, unknown>; context: McpRequestContext },
  dependencies: PrepareFileComparisonDependencies = DEFAULT_PREPARE_FILE_COMPARISON_DEPENDENCIES,
): Promise<TypedMcpToolResponse<PrepareFileComparisonOutput>> => {
  const parsed = v.safeParse(PREPARE_FILE_COMPARISON_INPUT_SCHEMA, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
    return structuredErrorResult({
      code: "permission_denied",
      message: "Your role cannot create document comparisons",
      hint: "Ask an organization admin for a role that may update documents.",
    });
  }

  const { organizationId, userId } = context;
  const reserved = await Promise.all([
    presignInput({ dependencies, file: input.base, organizationId }),
    presignInput({ dependencies, file: input.target, organizationId }),
  ]);
  const base = reserved.at(0);
  const target = reserved.at(1);
  if (base === undefined || target === undefined) {
    return internalFailureResult(new Error("Comparison presign lost a side"));
  }
  if (Result.isError(base)) {
    return internalFailureResult(base.error);
  }
  if (Result.isError(target)) {
    return internalFailureResult(target.error);
  }

  const expiresAt = fileComparisonExpiry(FILE_COMPARISON_INPUT_TTL_SECONDS);
  // Two deadlines, and the output carries the earlier one because it is the
  // one the client acts on: the signed PUT dies well before the row does.
  const urlExpiresAt = fileComparisonExpiry(
    PRESIGN_URL_EXPIRY_SECONDS,
  ).toISOString();
  const rows = [base.value, target.value].map((upload) => ({
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

  const inserted = await Result.tryPromise(
    async () =>
      await context.scopedDb(async (tx) => {
        await tx.insert(fileComparisonUploads).values(rows);
        // Sizes only: the names are the caller's, and the bytes are never
        // this organization's content to begin with.
        await context.recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.FILE_COMPARISON,
          resourceId: base.value.id,
          metadata: {
            baseUploadId: base.value.id,
            targetUploadId: target.value.id,
            baseSizeBytes: base.value.declaredSize,
            targetSizeBytes: target.value.declaredSize,
          },
          workspaceId: null,
        });
      }),
  );
  if (Result.isError(inserted)) {
    return internalFailureResult(inserted.error);
  }

  return toolDataResult({
    base: {
      uploadId: base.value.id,
      url: base.value.url,
      headers: base.value.headers,
      expiresAt: urlExpiresAt,
    },
    target: {
      uploadId: target.value.id,
      url: target.value.url,
      headers: target.value.headers,
      expiresAt: urlExpiresAt,
    },
    next: {
      tool: "compare_documents",
      source: {
        type: "uploads",
        base_upload_id: base.value.id,
        target_upload_id: target.value.id,
      },
    },
  });
};

/** The handler's extra dependency argument is optional, so it still is one. */
handlePrepareFileComparisonTool satisfies TypedMcpToolHandler<PrepareFileComparisonOutput>;
