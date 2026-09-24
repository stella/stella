/**
 * `prepare_file_comparison_from_links`: stage two DOCX files for
 * `compare_documents` by downloading them server-side from HTTPS links, so no
 * bytes pass through the model. It reserves the same slots and writes the same
 * rows as `prepare_file_comparison`; only who fetches the bytes differs.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { FILE_COMPARISON_TRANSPORT } from "@stll/api-contract";

import { presignUploadUrl, putPresignedUpload } from "@/api/lib/s3-presign";
import {
  parseSafeOutboundUrl,
  safeOutboundFetchBytes,
} from "@/api/lib/safe-outbound-fetch";
import type { McpRequestContext } from "@/api/mcp/context";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import {
  FILE_COMPARISON_MAX_BYTES,
  FILE_COMPARISON_MAX_MEGABYTES,
  fileComparisonPermissionDenied,
  fileComparisonSideDescription,
  reserveFileComparisonInputs,
} from "@/api/mcp/file-comparison-prepare-tool";
import type {
  ComparisonSide,
  PrepareFileComparisonDependencies,
  ReservedUpload,
} from "@/api/mcp/file-comparison-prepare-tool";
import type {
  InternalToolErrorResult,
  TypedMcpToolHandler,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import {
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";

const TRANSFER_TIMEOUT_MS = 60_000;

const linkedFileSchema = (side: ComparisonSide) =>
  v.pipe(
    v.strictObject({
      url: v.pipe(
        v.string(),
        v.trim(),
        v.description(
          "HTTPS link the server downloads the .docx from. A share link that " +
            "opens a web page is not the file; use the direct-download form.",
        ),
      ),
      name: v.optional(
        v.pipe(
          v.string(),
          v.trim(),
          v.minLength(1),
          v.maxLength(255),
          v.description(
            "File name to show the user, including the .docx suffix; " +
              "defaults to the last path segment of the link.",
          ),
        ),
      ),
    }),
    v.description(fileComparisonSideDescription(side)),
  );

const PREPARE_FILE_COMPARISON_FROM_LINKS_INPUT_SCHEMA = nullAsAbsent(
  v.strictObject({
    base: linkedFileSchema("base"),
    target: linkedFileSchema("target"),
  }),
);

const stagedUploadSchema = v.strictObject({
  uploadId: v.string(),
  name: v.string(),
  size: v.number(),
});

const PREPARE_FILE_COMPARISON_FROM_LINKS_OUTPUT_SCHEMA = v.strictObject({
  base: stagedUploadSchema,
  target: stagedUploadSchema,
  next: v.strictObject({
    tool: v.literal(FILE_COMPARISON_TRANSPORT.compareToolName),
    source: v.strictObject({
      type: v.literal("uploads"),
      base_upload_id: v.string(),
      target_upload_id: v.string(),
    }),
  }),
});

export type PrepareFileComparisonFromLinksOutput = v.InferInput<
  typeof PREPARE_FILE_COMPARISON_FROM_LINKS_OUTPUT_SCHEMA
>;

export const PREPARE_FILE_COMPARISON_FROM_LINKS_TOOL_DEFINITION =
  defineValibotMcpTool({
    annotations: {
      title: "Prepare file comparison from links",
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      readOnlyHint: false,
    },
    description:
      "Stage two .docx files for redlining from HTTPS links the server can " +
      "download, so no bytes pass through the client. Each file is at most " +
      `${FILE_COMPARISON_MAX_MEGABYTES} MB and must be a .docx. Then call ` +
      `${FILE_COMPARISON_TRANSPORT.compareToolName} with the echoed ` +
      "next.source, within the hour. The staged files and the redline are " +
      "temporary and never become a document, a version, or matter content.",
    inputSchema: PREPARE_FILE_COMPARISON_FROM_LINKS_INPUT_SCHEMA,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["trim"],
      reason:
        "Whitespace is normalised by the runtime schema; what the server may fetch is decided by the outbound-fetch reader, which names the side it refuses, not by a spelling rule on the field.",
    },
    access: "write",
    anonymized: { exposure: "excluded", reason: "write" },
    name: FILE_COMPARISON_TRANSPORT.linksToolName,
    scope: "stella:documents_write",
  });

export const PREPARE_FILE_COMPARISON_FROM_LINKS_OUTPUT_CONTRACT =
  defineMcpToolOutput(PREPARE_FILE_COMPARISON_FROM_LINKS_OUTPUT_SCHEMA);

type LinksToolInput = v.InferOutput<
  typeof PREPARE_FILE_COMPARISON_FROM_LINKS_INPUT_SCHEMA
>;

type LinkedFileInput = LinksToolInput["base"];

const putPresignedFile = async ({
  bytes,
  reservation,
}: {
  bytes: Uint8Array;
  reservation: ReservedUpload;
}) =>
  await Result.tryPromise({
    try: async () =>
      await putPresignedUpload({
        bytes,
        headers: reservation.headers,
        timeoutMs: TRANSFER_TIMEOUT_MS,
        url: reservation.url,
      }),
    catch: (cause) => cause,
  });

export type PrepareFileComparisonFromLinksDependencies =
  PrepareFileComparisonDependencies & {
    download: typeof safeOutboundFetchBytes;
    put: typeof putPresignedFile;
  };

const DEFAULT_PREPARE_FILE_COMPARISON_FROM_LINKS_DEPENDENCIES: PrepareFileComparisonFromLinksDependencies =
  { download: safeOutboundFetchBytes, presignUploadUrl, put: putPresignedFile };

const DOWNLOAD_HINT =
  "Check that the link is a direct HTTPS download of the .docx that needs no " +
  "login; a share page that renders HTML is not the file.";

const linkIssue = ({
  hint,
  message,
  reason,
  side,
}: {
  hint: string;
  message: string;
  reason: string;
  side: ComparisonSide;
}): InternalToolErrorResult =>
  structuredErrorResult({
    code: "validation_error",
    message,
    issues: [{ path: `${side}.url`, message: reason }],
    hint,
  });

/** Every DOCX is a zip, and every zip starts with the local-header magic. */
const ZIP_SIGNATURE = [0x50, 0x4b] as const;

const isZip = (bytes: Uint8Array): boolean =>
  ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

const lastPathSegment = (rawUrl: string): string => {
  const { pathname } = new URL(rawUrl);
  const segment = pathname.split("/").at(-1) ?? "";
  const decoded = Result.try(() => decodeURIComponent(segment));
  return Result.isError(decoded) ? segment : decoded.value;
};

const linkedFileName = ({
  file,
  side,
}: {
  file: LinkedFileInput;
  side: ComparisonSide;
}): string => {
  if (file.name !== undefined) {
    return file.name;
  }
  const segment = lastPathSegment(file.url);
  return segment === "" ? `${side}.docx` : segment;
};

type LinkedFile = {
  bytes: Uint8Array;
  name: string;
  sha256Hex: string;
  size: number;
};

const resolveLinkedFile = async ({
  dependencies,
  file,
  side,
}: {
  dependencies: PrepareFileComparisonFromLinksDependencies;
  file: LinkedFileInput;
  side: ComparisonSide;
}): Promise<Result<LinkedFile, InternalToolErrorResult>> => {
  // The one reader of what the server may fetch decides the link, so a
  // refusal names the side and the reason instead of a schema format.
  const link = parseSafeOutboundUrl(file.url);
  if (Result.isError(link)) {
    return Result.err(
      linkIssue({
        hint: DOWNLOAD_HINT,
        message: `The ${side} link is not an HTTPS URL`,
        reason: link.error.message,
        side,
      }),
    );
  }

  const downloaded = await dependencies.download({
    maxBytes: FILE_COMPARISON_MAX_BYTES,
    timeoutMs: TRANSFER_TIMEOUT_MS,
    url: link.value,
  });
  if (Result.isError(downloaded) || !downloaded.value.ok) {
    return Result.err(
      linkIssue({
        hint: DOWNLOAD_HINT,
        message: `The ${side} file could not be downloaded`,
        reason: Result.isError(downloaded)
          ? downloaded.error.message
          : `The link answered HTTP ${downloaded.value.status}`,
        side,
      }),
    );
  }

  const bytes = new Uint8Array(downloaded.value.body);
  if (bytes.byteLength === 0) {
    return Result.err(
      linkIssue({
        hint: DOWNLOAD_HINT,
        message: `The ${side} file is empty`,
        reason: "The link served no bytes",
        side,
      }),
    );
  }
  if (!isZip(bytes)) {
    return Result.err(
      linkIssue({
        hint:
          "Link the .docx itself; a PDF, a .doc, or a share page is not one. " +
          `Call ${FILE_COMPARISON_TRANSPORT.linksToolName} again with a ` +
          "direct .docx link.",
        message: `The ${side} file is not a .docx`,
        reason: "The downloaded bytes are not a DOCX package",
        side,
      }),
    );
  }

  return Result.ok({
    bytes,
    name: linkedFileName({ file, side }),
    sha256Hex: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  });
};

type PutResult = Awaited<ReturnType<typeof putPresignedFile>>;

const putFailed = (result: PutResult): boolean =>
  Result.isError(result) || !result.value.ok;

/**
 * No cleanup on a failed transfer: the rows carry their own expiry and the
 * sweep collects them, so a second write here could only fail too.
 */
const transferFailure = (side: ComparisonSide): InternalToolErrorResult =>
  structuredErrorResult({
    code: "internal_error",
    message: `The ${side} file could not be transferred to stella storage`,
    hint: "Retry; the reserved slots expire on their own.",
    retryable: true,
  });

export const handlePrepareFileComparisonFromLinksTool = async (
  {
    args,
    context,
  }: { args: Record<string, unknown>; context: McpRequestContext },
  dependencies: PrepareFileComparisonFromLinksDependencies = DEFAULT_PREPARE_FILE_COMPARISON_FROM_LINKS_DEPENDENCIES,
): Promise<TypedMcpToolResponse<PrepareFileComparisonFromLinksOutput>> => {
  const parsed = v.safeParse(
    PREPARE_FILE_COMPARISON_FROM_LINKS_INPUT_SCHEMA,
    args,
  );
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  if (!hasEffectiveAuthority(context, { entity: ["update"] })) {
    return fileComparisonPermissionDenied();
  }

  const [base, target] = await Promise.all([
    resolveLinkedFile({ dependencies, file: input.base, side: "base" }),
    resolveLinkedFile({ dependencies, file: input.target, side: "target" }),
  ]);
  if (Result.isError(base)) {
    return base.error;
  }
  if (Result.isError(target)) {
    return target.error;
  }

  const reserved = await reserveFileComparisonInputs({
    base: base.value,
    context,
    dependencies,
    target: target.value,
  });
  if (Result.isError(reserved)) {
    return reserved.error;
  }

  const [basePut, targetPut] = await Promise.all([
    dependencies.put({
      bytes: base.value.bytes,
      reservation: reserved.value.base,
    }),
    dependencies.put({
      bytes: target.value.bytes,
      reservation: reserved.value.target,
    }),
  ]);
  if (putFailed(basePut)) {
    return transferFailure("base");
  }
  if (putFailed(targetPut)) {
    return transferFailure("target");
  }

  return toolDataResult({
    base: {
      uploadId: reserved.value.base.id,
      name: reserved.value.base.declaredName,
      size: reserved.value.base.declaredSize,
    },
    target: {
      uploadId: reserved.value.target.id,
      name: reserved.value.target.declaredName,
      size: reserved.value.target.declaredSize,
    },
    next: {
      tool: FILE_COMPARISON_TRANSPORT.compareToolName,
      source: {
        type: "uploads",
        base_upload_id: reserved.value.base.id,
        target_upload_id: reserved.value.target.id,
      },
    },
  });
};

/** The handler's extra dependency argument is optional, so it still is one. */
handlePrepareFileComparisonFromLinksTool satisfies TypedMcpToolHandler<PrepareFileComparisonFromLinksOutput>;
