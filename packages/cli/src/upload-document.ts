import { Result } from "better-result";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";

import { inferFileMimeType } from "./file-mime-type.js";
import { formatCapabilityCommand } from "./generate-capability-tree.js";
import type { CallToolResult, McpClientError } from "./mcp-client.js";
import { callTool } from "./mcp-client.js";
import { parsePayload } from "./run-leaf-command.js";

const INVOKE_CAPABILITY_TOOL = "invoke_capability";
const UPLOAD_CAPABILITIES = {
  abort: "uploads.delete",
  create: "uploads.create",
  finalize: "uploads.update",
  listProperties: "properties.list",
} as const;
const ENTITY_CREATE_PURPOSE = "entity_create";
export const DOCUMENT_UPLOAD_POLICY = {
  maxBytes: 52_428_800, // 50 MiB
  minimumBytesPerSecond: 32_768, // 32 KiB/s
  putTimeoutMs: 1_800_000, // 30 minutes
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type LocalFile = {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
  sha256Hex: string;
};

export type UploadDocumentInput = {
  filePath: string;
  mimeType: string | undefined;
  name: string | undefined;
  parentId: string | undefined;
  propertyId: string | undefined;
  workspaceId: string;
};

export type UploadFailure =
  | { type: "local"; message: string }
  | { type: "client"; error: McpClientError }
  | { type: "tool"; result: CallToolResult }
  | {
      type: "server-response";
      message: string;
      cleanupWarning?: string | undefined;
    }
  | {
      type: "put";
      message: string;
      cleanupWarning: string | undefined;
    }
  | {
      type: "finalize";
      failure:
        | { type: "client"; error: McpClientError }
        | { type: "tool"; result: CallToolResult }
        | { type: "server-response"; message: string };
      uploadId: string;
    };

type CapabilityInvocation =
  | { status: "ok"; payload: unknown }
  | { status: "client-error"; error: McpClientError }
  | { status: "tool-error"; result: CallToolResult };

export type UploadDocumentDependencies = {
  invoke: (
    capability: string,
    input: Record<string, unknown>,
    confirm?: true,
  ) => Promise<CapabilityInvocation>;
  put: (request: {
    bytes: Uint8Array;
    headers: Readonly<Record<string, string>>;
    url: string;
  }) => Promise<Result<void, string>>;
  readLocalFile: (filePath: string) => Promise<Result<LocalFile, string>>;
};

const readBoundedLocalFile = async (
  filePath: string,
): Promise<Result<LocalFile, string>> => {
  const opened = await Result.tryPromise({
    try: async () => await open(filePath, "r"),
    catch: (cause) => cause,
  });
  if (Result.isError(opened)) {
    return Result.err(`Could not open ${filePath}`);
  }

  const handle = opened.value;
  const read = await Result.tryPromise({
    try: async () => {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return Result.err("The upload path is not a regular file");
      }
      if (stats.size < 1) {
        return Result.err("The upload file must contain at least one byte");
      }
      if (stats.size > DOCUMENT_UPLOAD_POLICY.maxBytes) {
        return Result.err(
          `The upload file exceeds the ${DOCUMENT_UPLOAD_POLICY.maxBytes}-byte document limit`,
        );
      }

      const bytes = Buffer.allocUnsafe(stats.size);
      let offset = 0;
      while (offset < bytes.length) {
        // oxlint-disable-next-line no-await-in-loop -- each read advances one bounded file handle offset
        const chunk = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (chunk.bytesRead === 0) {
          return Result.err("The upload file changed while it was being read");
        }
        offset += chunk.bytesRead;
      }

      const extra = Buffer.allocUnsafe(1);
      const trailing = await handle.read(extra, 0, 1, offset);
      if (trailing.bytesRead !== 0) {
        return Result.err("The upload file changed while it was being read");
      }

      return Result.ok({
        bytes,
        mimeType: inferFileMimeType(filePath),
        name: path.basename(filePath),
        sha256Hex: createHash("sha256").update(bytes).digest("hex"),
      });
    },
    catch: (cause) => cause,
  });
  await handle.close();

  if (Result.isError(read)) {
    return Result.err(`Could not read ${filePath}`);
  }
  return read.value;
};

const putPresignedObject = async ({
  bytes,
  headers,
  url,
}: {
  bytes: Uint8Array;
  headers: Readonly<Record<string, string>>;
  url: string;
}): Promise<Result<void, string>> => {
  const parsedUrl = Result.try(() => new URL(url));
  if (
    Result.isError(parsedUrl) ||
    (parsedUrl.value.protocol !== "https:" &&
      parsedUrl.value.protocol !== "http:")
  ) {
    return Result.err("The server returned an invalid presigned upload URL");
  }

  const response = await Result.tryPromise({
    try: async () =>
      await fetch(parsedUrl.value, {
        method: "PUT",
        headers,
        body: bytes,
        signal: AbortSignal.timeout(DOCUMENT_UPLOAD_POLICY.putTimeoutMs),
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(response)) {
    return Result.err(
      `The presigned PUT failed: ${response.error instanceof Error ? response.error.message : "network error"}`,
    );
  }
  if (!response.value.ok) {
    return Result.err(
      `The presigned PUT returned HTTP ${response.value.status}`,
    );
  }
  return Result.ok(undefined);
};

export const createUploadDocumentDependencies = ({
  serverUrl,
  token,
}: {
  serverUrl: string;
  token: string;
}): UploadDocumentDependencies => ({
  invoke: async (capability, input, confirm) => {
    const called = await callTool({
      serverUrl,
      token,
      name: INVOKE_CAPABILITY_TOOL,
      args: {
        capability,
        input,
        ...(confirm === true ? { confirm: true } : {}),
      },
    });
    if (Result.isError(called)) {
      return { status: "client-error", error: called.error };
    }
    if (called.value.isError === true) {
      return { status: "tool-error", result: called.value };
    }
    return { status: "ok", payload: parsePayload(called.value) };
  },
  put: putPresignedObject,
  readLocalFile: readBoundedLocalFile,
});

const invocationFailure = (
  invocation: Exclude<CapabilityInvocation, { status: "ok" }>,
): Extract<UploadFailure, { type: "client" | "tool" }> => {
  if (invocation.status === "client-error") {
    return { type: "client", error: invocation.error };
  }
  return { type: "tool", result: invocation.result };
};

const resolveFilePropertyId = async ({
  dependencies,
  workspaceId,
}: {
  dependencies: UploadDocumentDependencies;
  workspaceId: string;
}): Promise<Result<string, UploadFailure>> => {
  const listed = await dependencies.invoke(UPLOAD_CAPABILITIES.listProperties, {
    params: { workspaceId },
  });
  if (listed.status !== "ok") {
    return Result.err(invocationFailure(listed));
  }
  if (!Array.isArray(listed.payload)) {
    return Result.err({
      type: "server-response",
      message: "properties.list returned an unexpected response",
    });
  }

  const filePropertyIds = listed.payload.flatMap((property): string[] => {
    if (!isRecord(property) || typeof property["id"] !== "string") {
      return [];
    }
    const content = property["content"];
    return isRecord(content) && content["type"] === "file"
      ? [property["id"]]
      : [];
  });
  const onlyFilePropertyId = filePropertyIds.at(0);
  if (filePropertyIds.length === 1 && onlyFilePropertyId !== undefined) {
    return Result.ok(onlyFilePropertyId);
  }
  if (filePropertyIds.length === 0) {
    return Result.err({
      type: "server-response",
      message: `No file property exists in this matter; pass --property-id after inspecting '${formatCapabilityCommand(UPLOAD_CAPABILITIES.listProperties)}'`,
    });
  }
  return Result.err({
    type: "server-response",
    message:
      "More than one file property exists in this matter; pass --property-id explicitly",
  });
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
  const headers = Object.entries(payload["headers"]);
  if (
    !headers.every(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
  ) {
    return null;
  }
  return {
    headers: Object.fromEntries(headers),
    uploadId: payload["uploadId"],
    url: payload["url"],
  };
};

const abortUpload = async ({
  dependencies,
  uploadId,
  workspaceId,
}: {
  dependencies: UploadDocumentDependencies;
  uploadId: string;
  workspaceId: string;
}): Promise<string | undefined> => {
  const aborted = await dependencies.invoke(
    UPLOAD_CAPABILITIES.abort,
    { params: { uploadId, workspaceId } },
    true,
  );
  return aborted.status === "ok"
    ? undefined
    : `Cleanup failed for reserved upload ${uploadId}; run '${formatCapabilityCommand(UPLOAD_CAPABILITIES.abort)} --workspace-id ${workspaceId} --upload-id ${uploadId} --yes'`;
};

/**
 * Run the document upload state machine. Finalization is reachable only after a
 * successful PUT; every known reservation that fails before that point is
 * explicitly abandoned. A finalize failure is deliberately retryable and does
 * not destroy the staged object.
 */
export const uploadDocument = async ({
  dependencies,
  input,
}: {
  dependencies: UploadDocumentDependencies;
  input: UploadDocumentInput;
}): Promise<Result<unknown, UploadFailure>> => {
  const localFile = await dependencies.readLocalFile(input.filePath);
  if (Result.isError(localFile)) {
    return Result.err({ type: "local", message: localFile.error });
  }

  const propertyId =
    input.propertyId === undefined
      ? await resolveFilePropertyId({
          dependencies,
          workspaceId: input.workspaceId,
        })
      : Result.ok(input.propertyId);
  if (Result.isError(propertyId)) {
    return propertyId;
  }

  const body: Record<string, unknown> = {
    purpose: ENTITY_CREATE_PURPOSE,
    propertyId: propertyId.value,
    name: input.name ?? localFile.value.name,
    mimeType: input.mimeType ?? localFile.value.mimeType,
    size: localFile.value.bytes.byteLength,
    sha256Hex: localFile.value.sha256Hex,
  };
  if (input.parentId !== undefined) {
    body["parentId"] = input.parentId;
  }

  const created = await dependencies.invoke(UPLOAD_CAPABILITIES.create, {
    body,
    params: { workspaceId: input.workspaceId },
  });
  if (created.status !== "ok") {
    return Result.err(invocationFailure(created));
  }
  const reservation = parseReservation(created.payload);
  if (reservation === null) {
    const uploadId =
      isRecord(created.payload) &&
      typeof created.payload["uploadId"] === "string"
        ? created.payload["uploadId"]
        : undefined;
    if (uploadId !== undefined) {
      const cleanupWarning = await abortUpload({
        dependencies,
        uploadId,
        workspaceId: input.workspaceId,
      });
      return Result.err({
        type: "server-response",
        message: "uploads.create returned an unexpected response",
        cleanupWarning,
      });
    }
    return Result.err({
      type: "server-response",
      message: "uploads.create returned an unexpected response",
    });
  }

  const put = await dependencies.put({
    bytes: localFile.value.bytes,
    headers: reservation.headers,
    url: reservation.url,
  });
  if (Result.isError(put)) {
    const cleanupWarning = await abortUpload({
      dependencies,
      uploadId: reservation.uploadId,
      workspaceId: input.workspaceId,
    });
    return Result.err({
      type: "put",
      message: put.error,
      cleanupWarning,
    });
  }

  const finalized = await dependencies.invoke(UPLOAD_CAPABILITIES.finalize, {
    params: {
      uploadId: reservation.uploadId,
      workspaceId: input.workspaceId,
    },
  });
  if (finalized.status !== "ok") {
    return Result.err({
      type: "finalize",
      failure: invocationFailure(finalized),
      uploadId: reservation.uploadId,
    });
  }
  if (!isRecord(finalized.payload)) {
    return Result.err({
      type: "finalize",
      failure: {
        type: "server-response",
        message: "uploads.update returned an unexpected response",
      },
      uploadId: reservation.uploadId,
    });
  }
  return Result.ok(finalized.payload);
};
