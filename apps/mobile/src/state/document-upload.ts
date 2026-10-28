import { Result } from "better-result";
import * as v from "valibot";

import { fetchWithTimeout } from "@/connection/http";
import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { ApiRequestError, requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** A file on the phone to add to a matter, with what its upload is signed for. */
export type LocalFile = {
  readonly uri: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256Hex: string;
};

/** How long the server's signed upload URL lives. */
const STORAGE_TRANSFER_TIMEOUT_MS = 5 * 60_000;

const presignedSchema = v.object({
  uploadId: v.pipe(v.string(), v.minLength(1)),
  url: v.pipe(v.string(), v.minLength(1)),
  headers: v.record(v.string(), v.string()),
});

const finalizedSchema = v.object({
  finalizedResult: v.object({ entityId: v.string() }),
});

const propertiesSchema = v.array(
  v.object({
    id: v.string(),
    content: v.nullish(v.object({ type: v.string() })),
  }),
);

const uploadsPath = (matterId: string) =>
  `/v1/uploads/${encodeURIComponent(matterId)}`;

/**
 * The matter's documents column: its one property whose content is a file,
 * created with the matter, which the web uploads into as well.
 */
export const readFileProperty = async ({
  fetch,
  matterId,
  source,
}: {
  readonly fetch: Fetch;
  readonly matterId: string;
  readonly source: AccessTokenSource;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const properties = yield* Result.await(
      requestApi({
        fetch,
        path: `/v1/properties/${encodeURIComponent(matterId)}`,
        schema: propertiesSchema,
        source,
      }),
    );
    const file = properties.find(
      (property) => property.content?.type === "file",
    );
    return file === undefined
      ? Result.err(
          new ApiRequestError({
            message: "The matter has no documents column",
          }),
        )
      : Result.ok(file.id);
  });

/**
 * Adds `file` to a matter as a new document named `name`, in the matter's
 * documents column, the way the web uploads one: the server signs an upload
 * for the file's size and digest, the bytes go straight to storage, and the
 * server checks them before it records the document. A failed transfer
 * withdraws the signed upload.
 */
export const uploadDocument = async ({
  fetch,
  file,
  matterId,
  name,
  propertyId,
  source,
}: {
  readonly fetch: Fetch;
  readonly file: LocalFile;
  readonly matterId: string;
  readonly name: string;
  /** The matter's documents column, which holds the file. */
  readonly propertyId: string;
  readonly source: AccessTokenSource;
}): Promise<Result<string, ApiError>> =>
  await Result.gen(async function* () {
    const presigned = yield* Result.await(
      requestApi({
        body: {
          purpose: "entity_create",
          propertyId,
          parentId: null,
          name,
          mimeType: file.mimeType,
          size: file.size,
          sha256Hex: file.sha256Hex,
        },
        fetch,
        path: `${uploadsPath(matterId)}/presign`,
        schema: presignedSchema,
        source,
      }),
    );
    const sent = await putBytes(fetch, file.uri, presigned.value);
    if (Result.isError(sent)) {
      // Best effort: an upload left open expires on its own.
      await requestApi({
        fetch,
        method: "POST",
        path: `${uploadsPath(matterId)}/${encodeURIComponent(presigned.value.uploadId)}/abort`,
        schema: v.unknown(),
        source,
      });
      return Result.err(sent.error);
    }
    const finalized = yield* Result.await(
      requestApi({
        fetch,
        method: "POST",
        path: `${uploadsPath(matterId)}/${encodeURIComponent(presigned.value.uploadId)}/finalize`,
        schema: finalizedSchema,
        source,
      }),
    );
    return Result.ok(finalized.finalizedResult.entityId);
  });

/** Sends the file's bytes to the signed storage URL, with the signed headers verbatim. */
async function putBytes(
  fetch: Fetch,
  fileUri: string,
  { headers, url }: v.InferOutput<typeof presignedSchema>,
): Promise<Result<void, ApiRequestError>> {
  const sent = await Result.tryPromise({
    try: async () => {
      const bytes = await (await fetchWithTimeout(fetch, fileUri)).blob();
      // A scan of several megabytes on a slow network outlasts an API
      // request's deadline; it gets as long as the signed URL lives.
      return await fetchWithTimeout(
        fetch,
        url,
        { method: "PUT", headers, body: bytes },
        STORAGE_TRANSFER_TIMEOUT_MS,
      );
    },
    catch: (cause) =>
      new ApiRequestError({ message: "The file could not be sent", cause }),
  });
  if (Result.isError(sent)) {
    return Result.err(sent.error);
  }
  return sent.value.ok
    ? Result.ok(undefined)
    : Result.err(
        new ApiRequestError({
          message: `Storage refused the file with ${sent.value.status}`,
          status: sent.value.status,
        }),
      );
}
