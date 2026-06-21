import type { SafeId } from "@/api/lib/branded-types";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedEntityVersionId } from "@/api/lib/safe-id-boundaries";

export type VersionCursor = {
  versionNumber: number;
  id: SafeId<"entityVersion">;
};

export const encodeVersionCursor = ({
  versionNumber,
  id,
}: VersionCursor): string => encodePaginationCursor([versionNumber, id]);

export const decodeVersionCursor = (cursor: string): VersionCursor | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 2) {
    return null;
  }

  const [versionNumber, rawId] = parts;
  if (typeof versionNumber !== "number" || !isUuidPaginationCursorPart(rawId)) {
    return null;
  }

  return { versionNumber, id: brandPersistedEntityVersionId(rawId) };
};
