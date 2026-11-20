import { Result } from "better-result";

import { API_VALIDATION_ERROR_CODE } from "@stll/api-contract";
import { mapWithConcurrency } from "@stll/concurrency";

import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { hashActiveUploadFile } from "@/lib/files/active-uploads";
import { toSafeId } from "@/lib/safe-id";

const MAX_PARALLEL_HASHES = 4;

/** A file whose bytes a document in this matter already holds. */
export type DuplicateFile = {
  file: File;
  entityName: string;
};

/** A document the matter holds whose current file has one of the hashes. */
export type ExactDuplicateMatch = {
  sha256Hex: string;
  entityName: string;
};

/** Asks the matter which of these hashes its documents already hold. */
export type ExactDuplicateLookup = (request: {
  sha256Hexes: readonly string[];
  entityCount: number;
}) => Promise<readonly ExactDuplicateMatch[]>;

export const exactDuplicateLookup =
  (workspaceId: string): ExactDuplicateLookup =>
  async ({ sha256Hexes, entityCount }) => {
    const uploadsApi = api.uploads({
      workspaceId: toSafeId<"workspace">(workspaceId),
    });
    const { duplicates } = await invokeAppOnlyWrite(
      "uploads.entity-create.preflight",
      async () =>
        unwrapApiResponse(
          await uploadsApi["entity-create"].preflight.post({
            entityCount,
            sha256Hexes: [...sha256Hexes],
          }),
        ),
    );
    return duplicates;
  };

/**
 * A refusal the lookup is expected to meet: the matter is at its item limit,
 * or the user may not add to it. The upload that follows meets the same
 * refusal and tells the user, so it is not a failure worth reporting. A
 * validation refusal still is: it means this client sent a malformed request.
 */
const isExpectedRefusal = (error: unknown): boolean =>
  APIError.is(error) &&
  error.status >= 400 &&
  error.status < 500 &&
  error.code !== API_VALIDATION_ERROR_CODE;

type ResolveExactDuplicatesOptions = {
  files: readonly File[];
  lookup: ExactDuplicateLookup;
  /** Telemetry for a lookup that failed unexpectedly; the files still upload. */
  onError: (error: Error) => void;
  /** Test seam; production hashes through the active-upload guard. */
  hashFile?: (file: File) => Promise<string>;
};

/**
 * Find which of these files are byte-identical to a document the matter
 * already holds. A failed hash or lookup is treated as "no duplicate": it can
 * only cost the user the question, never the upload.
 */
export const resolveExactDuplicates = async ({
  files,
  lookup,
  onError,
  hashFile = hashActiveUploadFile,
}: ResolveExactDuplicatesOptions): Promise<DuplicateFile[]> => {
  if (files.length === 0) {
    return [];
  }

  const result = await Result.tryPromise(async () => {
    const hashed = await mapWithConcurrency({
      items: files,
      limit: MAX_PARALLEL_HASHES,
      operation: async (file) => ({
        file,
        // An unreadable or oversized file fails again, visibly, in the upload.
        sha256Hex: (
          await Result.tryPromise(async () => await hashFile(file))
        ).unwrapOr(null),
      }),
    });
    const sha256Hexes = [
      ...new Set(
        hashed
          .map(({ sha256Hex }) => sha256Hex)
          .filter((sha256Hex) => sha256Hex !== null),
      ),
    ];
    if (sha256Hexes.length === 0) {
      return [];
    }

    const duplicates = await lookup({
      sha256Hexes,
      entityCount: files.length,
    });
    const bySha256 = new Map(
      duplicates.map((duplicate) => [duplicate.sha256Hex, duplicate]),
    );
    return hashed.flatMap(({ file, sha256Hex }) => {
      const match = sha256Hex === null ? undefined : bySha256.get(sha256Hex);
      return match === undefined
        ? []
        : [{ file, entityName: match.entityName }];
    });
  });

  if (Result.isError(result)) {
    if (!isExpectedRefusal(result.error.cause)) {
      onError(result.error);
    }
    return [];
  }
  return result.value;
};
