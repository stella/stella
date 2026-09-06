import { Result } from "better-result";
import * as v from "valibot";

import {
  buildDocumentVersionUploadReservationInput,
  buildUploadAbortInput,
  buildUploadFinalizeInput,
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
} from "@stll/api-contract";

import { captureError } from "@/api/lib/analytics/capture";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { FILE_SIZE_LIMIT_BYTES } from "@/api/lib/limits";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { isRecord } from "@/api/lib/type-guards";
import { CAPABILITY_TOOL_HANDLERS } from "@/api/mcp/capability-tools";
import type { McpRequestContext } from "@/api/mcp/context";
import { isMcpEgressPlan } from "@/api/mcp/tool-types";
import type { McpToolResponse } from "@/api/mcp/tool-types";
import {
  internalFailureResult,
  nullAsAbsent,
  structuredErrorResult,
  uuidInputSchema,
} from "@/api/mcp/tool-utils";

export const DOCUMENT_UPLOAD_APP_RESOURCE_URI =
  DOCUMENT_VERSION_UPLOAD_TRANSPORT.resourceUri;

/**
 * ChatGPT's documented file-reference contract. This object is embedded in the
 * canonical static-tool input schema and is also the runtime validator: the
 * host adapter therefore cannot accept a shape different from `tools/list`.
 */
export const OPENAI_FILE_REFERENCE_SCHEMA = v.pipe(
  v.strictObject({
    download_url: v.pipe(
      v.string(),
      v.description(
        "Temporary URL supplied by the host for downloading the file",
      ),
    ),
    file_id: v.pipe(
      v.string(),
      v.description("Host-assigned identifier for the attached file"),
    ),
    mime_type: v.optional(
      v.pipe(v.string(), v.description("MIME type reported by the host")),
    ),
    file_name: v.optional(
      v.pipe(
        v.string(),
        v.description("Original file name reported by the host"),
      ),
    ),
  }),
  v.description("File reference supplied by a compatible MCP host"),
);

export const UPLOAD_DOCUMENT_VERSION_INPUT_SCHEMA = nullAsAbsent(
  v.strictObject({
    entity_id: uuidInputSchema(
      "Existing document entity ID that will receive a new version",
    ),
    file: OPENAI_FILE_REFERENCE_SCHEMA,
  }),
);

export const OPEN_DOCUMENT_VERSION_UPLOAD_INPUT_SCHEMA = nullAsAbsent(
  v.strictObject({
    entity_id: uuidInputSchema(
      "Existing document entity ID that will receive a new version",
    ),
  }),
);

export type UploadDocumentVersionInput = v.InferOutput<
  typeof UPLOAD_DOCUMENT_VERSION_INPUT_SCHEMA
>;

type CapabilityResult =
  | { status: "ok"; payload: unknown }
  | { status: "error"; result: Exclude<McpToolResponse, { egress: string }> };

const invokeCapability = async ({
  args,
  context,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
}): Promise<CapabilityResult> => {
  const response = await CAPABILITY_TOOL_HANDLERS.invoke_capability({
    args,
    context,
  });
  if (!isMcpEgressPlan(response)) {
    return { status: "error", result: response };
  }
  if (response.egress !== "structured") {
    return {
      status: "error",
      result: internalFailureResult(
        new Error("Upload capability returned a non-structured egress plan"),
      ),
    };
  }
  return { status: "ok", payload: response.payload };
};

type UploadReservation = {
  headers: Record<string, string>;
  uploadId: string;
  url: string;
};

const parseReservation = (payload: unknown): UploadReservation | null => {
  if (
    !isRecord(payload) ||
    typeof payload["uploadId"] !== "string" ||
    typeof payload["url"] !== "string" ||
    !isRecord(payload["headers"])
  ) {
    return null;
  }
  const headers: [string, string][] = [];
  for (const [key, value] of Object.entries(payload["headers"])) {
    if (typeof value !== "string") {
      return null;
    }
    headers.push([key, value]);
  }
  return {
    headers: Object.fromEntries(headers),
    uploadId: payload["uploadId"],
    url: payload["url"],
  };
};

const abortReservation = async ({
  context,
  uploadId,
  workspaceId,
}: {
  context: McpRequestContext;
  uploadId: string;
  workspaceId: string;
}): Promise<CapabilityResult> =>
  await invokeCapability({
    context,
    args: {
      capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.abort,
      confirm: true,
      input: buildUploadAbortInput({ uploadId, workspaceId }),
    },
  });

const putPresignedFile = async ({
  bytes,
  reservation,
}: {
  bytes: Uint8Array;
  reservation: UploadReservation;
}) =>
  await Result.tryPromise({
    try: async () =>
      await fetchWithTimeout(reservation.url, {
        method: "PUT",
        headers: reservation.headers,
        // Copy into an ArrayBuffer-backed view. `safeOutboundFetchBytes` may
        // return a Uint8Array<ArrayBufferLike>; DOM fetch deliberately rejects
        // SharedArrayBuffer-backed bodies even though Bun's narrower fetch
        // types accept the wider view.
        body: new Uint8Array(bytes).buffer,
        timeoutMs: 60_000,
      }),
    catch: (cause) => cause,
  });

type DocumentFileUploadDependencies = {
  abort: typeof abortReservation;
  captureCleanupFailure: typeof captureError;
  download: typeof safeOutboundFetchBytes;
  invoke: typeof invokeCapability;
  put: typeof putPresignedFile;
};

const DEFAULT_DOCUMENT_FILE_UPLOAD_DEPENDENCIES = {
  abort: abortReservation,
  captureCleanupFailure: captureError,
  download: safeOutboundFetchBytes,
  invoke: invokeCapability,
  put: putPresignedFile,
} satisfies DocumentFileUploadDependencies;

const abortCreatedReservation = async ({
  context,
  dependencies,
  uploadId,
  workspaceId,
}: {
  context: McpRequestContext;
  dependencies: DocumentFileUploadDependencies;
  uploadId: string;
  workspaceId: string;
}): Promise<boolean> => {
  const aborted = await Result.tryPromise({
    try: async () =>
      await dependencies.abort({ context, uploadId, workspaceId }),
    catch: (cause) => cause,
  });
  if (Result.isError(aborted)) {
    dependencies.captureCleanupFailure(aborted.error, {
      source: "mcp_document_upload",
      uploadId,
      workspaceId,
    });
    return false;
  }
  if (aborted.value.status === "ok") {
    return true;
  }

  dependencies.captureCleanupFailure(
    new Error("Document upload reservation cleanup failed", {
      cause: aborted.value.result,
    }),
    {
      source: "mcp_document_upload",
      uploadId,
      workspaceId,
    },
  );
  return false;
};

const normalizedMimeType = (
  file: UploadDocumentVersionInput["file"],
  responseHeaders: Headers,
): string =>
  file.mime_type ??
  responseHeaders.get("content-type")?.split(";", 1).at(0)?.trim() ??
  "application/octet-stream";

/**
 * Bridge a host-provided temporary download URL into stella's existing
 * presign -> PUT -> finalize state machine. The bridge owns no persistence or
 * authorization rules; every state transition runs through the same generated
 * capabilities used by the web app and CLI.
 */
export const uploadRemoteDocumentVersion = async ({
  context,
  dependencies = DEFAULT_DOCUMENT_FILE_UPLOAD_DEPENDENCIES,
  entityId,
  file,
  workspaceId,
}: {
  context: McpRequestContext;
  dependencies?: DocumentFileUploadDependencies;
  entityId: string;
  file: UploadDocumentVersionInput["file"];
  workspaceId: string;
}): Promise<McpToolResponse> => {
  const downloaded = await dependencies.download({
    maxBytes: FILE_SIZE_LIMIT_BYTES.document,
    timeoutMs: 60_000,
    url: file.download_url,
  });
  if (Result.isError(downloaded) || !downloaded.value.ok) {
    return structuredErrorResult({
      code: "validation_error",
      message: "The attached file could not be downloaded",
      hint: "Attach the file again and retry before its temporary download URL expires.",
    });
  }
  if (downloaded.value.body.byteLength === 0) {
    return structuredErrorResult({
      code: "validation_error",
      message: "The attached file is empty",
    });
  }

  const bytes = new Uint8Array(downloaded.value.body);
  const sha256Hex = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const name = (file.file_name ?? file.file_id).slice(0, 255);
  const created = await dependencies.invoke({
    context,
    args: {
      capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.reserve,
      input: buildDocumentVersionUploadReservationInput({
        entityId,
        file: {
          name,
          mimeType: normalizedMimeType(file, downloaded.value.headers),
          size: bytes.byteLength,
          sha256Hex,
        },
        workspaceId,
      }),
    },
  });
  if (created.status === "error") {
    return created.result;
  }
  const reservation = parseReservation(created.payload);
  if (reservation === null) {
    if (
      isRecord(created.payload) &&
      typeof created.payload["uploadId"] === "string"
    ) {
      await abortCreatedReservation({
        context,
        dependencies,
        uploadId: created.payload["uploadId"],
        workspaceId,
      });
    }
    return internalFailureResult(
      new Error("uploads.create returned an invalid reservation"),
    );
  }

  const put = await dependencies.put({ bytes, reservation });
  if (Result.isError(put) || !put.value.ok) {
    const cleanedUp = await abortCreatedReservation({
      context,
      dependencies,
      uploadId: reservation.uploadId,
      workspaceId,
    });
    return structuredErrorResult({
      code: "internal_error",
      message: cleanedUp
        ? "The attached file could not be transferred to stella storage"
        : "The attached file could not be transferred, and its reserved upload could not be cleaned up",
      retryable: true,
    });
  }

  const finalized = await dependencies.invoke({
    context,
    args: {
      capability: DOCUMENT_VERSION_UPLOAD_TRANSPORT.capability.finalize,
      input: buildUploadFinalizeInput({
        uploadId: reservation.uploadId,
        workspaceId,
      }),
    },
  });
  return finalized.status === "error"
    ? finalized.result
    : {
        egress: "structured",
        payload: finalized.payload,
        textFields: [],
      };
};
