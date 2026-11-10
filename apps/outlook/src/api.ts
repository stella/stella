// Matter list and email filing over the stella API.
//
// Filing is the API's ordinary three-step upload: reserve with presign, PUT
// the bytes to the signed URL, then finalize. The message travels as one
// `.eml` file; the API turns an email file in a matter into a correspondence
// record and keeps its attachments inside the file
// (apps/api/src/lib/email/inbound/README.md, "Uploaded email files").

import { Result, TaggedError } from "better-result";

import {
  DOCUMENT_UPLOAD_PUT_TIMEOUT_MS,
  type SafeId,
} from "@stll/api-contract";
import { UPLOAD_DOCUMENT_MAX_BYTES } from "@stll/api-contract/limits";
import { toSafeId } from "@stll/api-contract/safe-id";
import { sleep } from "@stll/concurrency/sleep";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/browser";

import {
  parseEntityResponse,
  parseFinalizeResponse,
  parsePresignResponse,
  parsePropertiesResponse,
  parseWorkspacesResponse,
} from "@/lib/api-schemas";
import { requestOutlookApi } from "@/lib/outlook-api-client";
import { OutlookAPIError } from "@/lib/outlook-api-error";
import type { WorkspaceSummary } from "@/types";

const EMAIL_MIME_TYPE = "message/rfc822";
const FINALIZE_TIMEOUT_MS = 120_000;
/** Waits before the second and third finalize attempts. */
const FINALIZE_RETRY_DELAYS_MS = [1000, 3000] as const;
const CONFLICT = 409;
const SERVER_ERROR = 500;

const workspacePath = (workspaceId: string) => encodeURIComponent(workspaceId);

export const readWorkspaces = async (): Promise<WorkspaceSummary[]> => {
  const response = await requestOutlookApi({
    parse: parseWorkspacesResponse,
    path: "/workspaces",
  });
  return response.workspaces.map((workspace) => ({
    clientName: workspace.client?.displayName ?? null,
    id: toSafeId<"workspace">(workspace.id),
    lastActivityAt: workspace.lastActivityAt,
    name: workspace.name,
    reference: workspace.reference,
  }));
};

export type FileEmailFailure =
  /** The message is larger than the API accepts for one document. */
  | "too-large"
  /** The matter has no file column to hold documents. */
  | "no-file-property";

export class FileEmailError extends TaggedError("FileEmailError")<{
  failure: FileEmailFailure;
  message: string;
}> {}

/** An upload whose bytes are stored but whose finalize did not answer. */
export type PendingFinalize = {
  readonly propertyId: SafeId<"property">;
  readonly uploadId: SafeId<"pendingUpload">;
  readonly workspaceId: SafeId<"workspace">;
};

export class FinalizePendingError extends TaggedError("FinalizePendingError")<{
  cause: unknown;
  message: string;
  pending: PendingFinalize;
}> {}

export type FiledEmail = {
  readonly entityId: SafeId<"entity">;
  /** The file field to open in the web app; null when it could not be read. */
  readonly fieldId: SafeId<"field"> | null;
  readonly fileName: string;
  readonly workspaceId: SafeId<"workspace">;
};

export type FileEmailDependencies = {
  readonly put: (url: string, init: RequestInit) => Promise<Response>;
  readonly request: typeof requestOutlookApi;
  readonly sleep: (ms: number) => Promise<void>;
};

const defaultDependencies: FileEmailDependencies = {
  put: async (url, init) => await fetch(url, init),
  request: requestOutlookApi,
  sleep,
};

const withDefaults = (
  overrides: Partial<FileEmailDependencies>,
): FileEmailDependencies => ({ ...defaultDependencies, ...overrides });

/** Lowercase hex SHA-256, the form the presign request declares. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  await hashSha256Hex(bytes);

/**
 * The matter's file column: the property every document upload names. A
 * matter gets one when it is created; the add-in does not create columns.
 */
export const findFilePropertyId = async (
  workspaceId: SafeId<"workspace">,
  { request }: Pick<FileEmailDependencies, "request"> = defaultDependencies,
): Promise<SafeId<"property"> | null> => {
  const properties = await request({
    parse: parsePropertiesResponse,
    path: `/properties/${workspacePath(workspaceId)}`,
  });
  const fileProperty = properties.find(
    (property) => property.content.type === "file",
  );
  return fileProperty ? toSafeId<"property">(fileProperty.id) : null;
};

const abortUpload = async (
  { request }: Pick<FileEmailDependencies, "request">,
  workspaceId: SafeId<"workspace">,
  uploadId: SafeId<"pendingUpload">,
): Promise<void> => {
  // Best effort: an unfinalized reservation also expires on its own.
  await Result.tryPromise(
    async () =>
      await request({
        body: {},
        method: "POST",
        parse: () => ({ output: undefined, success: true }),
        path: `/uploads/${workspacePath(workspaceId)}/${encodeURIComponent(uploadId)}/abort`,
      }),
  );
};

/**
 * PUT the bytes to the presigned URL with exactly the signed headers. A
 * failed PUT abandons the reservation, so the next attempt starts fresh.
 */
export const putPresignedEmail = async (
  {
    bytes,
    headers,
    uploadId,
    url,
    workspaceId,
  }: {
    bytes: Uint8Array<ArrayBuffer>;
    headers: Record<string, string>;
    uploadId: SafeId<"pendingUpload">;
    url: string;
    workspaceId: SafeId<"workspace">;
  },
  overrides: Partial<FileEmailDependencies> = {},
): Promise<void> => {
  const dependencies = withDefaults(overrides);
  const putResult = await Result.tryPromise(
    async () =>
      await dependencies.put(url, {
        body: bytes,
        credentials: "omit",
        headers,
        method: "PUT",
        signal: AbortSignal.timeout(DOCUMENT_UPLOAD_PUT_TIMEOUT_MS),
      }),
  );
  if (Result.isOk(putResult) && putResult.value.ok) {
    return;
  }
  await abortUpload(dependencies, workspaceId, uploadId);
  const status = Result.isOk(putResult) ? putResult.value.status : 502;
  throw new OutlookAPIError({
    message: Result.isOk(putResult)
      ? `Upload failed (${status})`
      : "Upload failed",
    status,
  });
};

/** Whether a finalize failure may succeed when the same upload is finalized again. */
export const isRetryableFinalizeError = (error: unknown): boolean =>
  !(error instanceof OutlookAPIError) ||
  error.status === CONFLICT ||
  error.status >= SERVER_ERROR;

const readFileFieldId = async (
  { request }: Pick<FileEmailDependencies, "request">,
  {
    entityId,
    propertyId,
    workspaceId,
  }: {
    entityId: SafeId<"entity">;
    propertyId: SafeId<"property">;
    workspaceId: SafeId<"workspace">;
  },
): Promise<SafeId<"field"> | null> => {
  const entity = await Result.tryPromise(
    async () =>
      await request({
        parse: parseEntityResponse,
        path: `/entities/${workspacePath(workspaceId)}/entity/${encodeURIComponent(entityId)}`,
      }),
  );
  if (Result.isError(entity)) {
    return null;
  }
  const field = entity.value.fields.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  return field ? toSafeId<"field">(field.id) : null;
};

/**
 * Finalize a stored upload. Finalize is idempotent on the API, so an
 * unanswered or busy attempt is repeated on the same upload; when the
 * attempts run out the caller keeps `pending` to try again later instead of
 * uploading the message a second time.
 */
export const finalizeFiledEmail = async (
  pending: PendingFinalize,
  overrides: Partial<FileEmailDependencies> = {},
): Promise<FiledEmail> => {
  const dependencies = withDefaults(overrides);
  const finalizeOnce = async () =>
    await dependencies.request({
      method: "POST",
      parse: parseFinalizeResponse,
      path: `/uploads/${workspacePath(pending.workspaceId)}/${encodeURIComponent(pending.uploadId)}/finalize`,
      timeoutMs: FINALIZE_TIMEOUT_MS,
    });

  const tryFinalize = async () =>
    await Result.tryPromise({ try: finalizeOnce, catch: (cause) => cause });
  let attempt = await tryFinalize();
  for (const delay of FINALIZE_RETRY_DELAYS_MS) {
    if (Result.isOk(attempt) || !isRetryableFinalizeError(attempt.error)) {
      break;
    }
    await dependencies.sleep(delay);
    attempt = await tryFinalize();
  }
  if (Result.isError(attempt)) {
    if (isRetryableFinalizeError(attempt.error)) {
      throw new FinalizePendingError({
        cause: attempt.error,
        message: "The upload is stored but was not finalized yet",
        pending,
      });
    }
    throw attempt.error;
  }

  const entityId = toSafeId<"entity">(attempt.value.finalizedResult.entityId);
  return {
    entityId,
    fieldId: await readFileFieldId(dependencies, {
      entityId,
      propertyId: pending.propertyId,
      workspaceId: pending.workspaceId,
    }),
    fileName: attempt.value.finalizedResult.fileName,
    workspaceId: pending.workspaceId,
  };
};

/** Upload one `.eml` file into the matter's file column. */
export const fileEmailToMatter = async (
  { eml, workspaceId }: { eml: File; workspaceId: SafeId<"workspace"> },
  overrides: Partial<FileEmailDependencies> = {},
): Promise<FiledEmail> => {
  const dependencies = withDefaults(overrides);
  if (eml.size > UPLOAD_DOCUMENT_MAX_BYTES) {
    throw new FileEmailError({
      failure: "too-large",
      message: "The email is larger than stella accepts for one document",
    });
  }
  const propertyId = await findFilePropertyId(workspaceId, dependencies);
  if (propertyId === null) {
    throw new FileEmailError({
      failure: "no-file-property",
      message: "The matter has no file column",
    });
  }

  const bytes = new Uint8Array(await eml.arrayBuffer());
  const presign = await dependencies.request({
    body: {
      purpose: "entity_create",
      propertyId,
      parentId: null,
      name: eml.name,
      mimeType: EMAIL_MIME_TYPE,
      size: bytes.byteLength,
      sha256Hex: await sha256Hex(bytes),
    },
    method: "POST",
    parse: parsePresignResponse,
    path: `/uploads/${workspacePath(workspaceId)}/presign`,
  });
  const uploadId = toSafeId<"pendingUpload">(presign.uploadId);

  await putPresignedEmail(
    {
      bytes,
      headers: presign.headers,
      uploadId,
      url: presign.url,
      workspaceId,
    },
    dependencies,
  );

  return await finalizeFiledEmail(
    { propertyId, uploadId, workspaceId },
    dependencies,
  );
};
