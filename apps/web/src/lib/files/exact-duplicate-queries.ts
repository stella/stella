import { Result } from "better-result";

import { mapWithConcurrency } from "@stll/concurrency";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { hashActiveUploadFile } from "@/lib/files/active-uploads";
import { toSafeId } from "@/lib/safe-id";

const MAX_PARALLEL_HASHES = 4;

/** A file whose bytes a document in this matter already holds. */
export type DuplicateFile = {
  file: File;
  entityId: string;
  entityName: string | null;
};

type ResolveExactDuplicatesOptions = {
  files: readonly File[];
  workspaceId: string;
  /** Telemetry for a lookup that failed; the files still upload. */
  onError: (error: Error) => void;
};

/**
 * Find which of these files are byte-identical to a document the matter
 * already holds. A failed hash or lookup is reported and treated as "no
 * duplicate": it can only cost the user the question, never the upload.
 */
export const resolveExactDuplicates = async ({
  files,
  workspaceId,
  onError,
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
          await Result.tryPromise(async () => await hashActiveUploadFile(file))
        ).unwrapOr(null),
      }),
    });
    const sha256Hexes = [
      ...new Set(hashed.flatMap(({ sha256Hex }) => sha256Hex ?? [])),
    ];
    if (sha256Hexes.length === 0) {
      return [];
    }

    const uploadsApi = api.uploads({
      workspaceId: toSafeId<"workspace">(workspaceId),
    });
    const { duplicates } = unwrapApiResponse(
      await uploadsApi["entity-create"].preflight.post({
        entityCount: files.length,
        sha256Hexes,
      }),
    );
    const bySha256 = new Map(
      duplicates.map((duplicate) => [duplicate.sha256Hex, duplicate]),
    );
    return hashed.flatMap(({ file, sha256Hex }) => {
      const match = sha256Hex === null ? undefined : bySha256.get(sha256Hex);
      return match === undefined
        ? []
        : [{ file, entityId: match.entityId, entityName: match.entityName }];
    });
  });

  if (Result.isError(result)) {
    onError(result.error);
    return [];
  }
  return result.value;
};
