import { parsePgTimestampCursorValue } from "@/api/lib/db-pagination";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";

export type WorkspaceActivityType = "entity" | "thread";

export type WorkspaceActivityCursor = {
  activityAt: string;
  id: string;
  type: WorkspaceActivityType;
};

export const encodeWorkspaceActivityCursor = ({
  activityAt,
  id,
  type,
}: WorkspaceActivityCursor): string =>
  encodePaginationCursor([activityAt, id, type]);

export const decodeWorkspaceActivityCursor = (
  cursor: string | undefined,
): WorkspaceActivityCursor | null => {
  if (cursor === undefined) {
    return null;
  }

  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 3) {
    return null;
  }

  const [activityAt, id, type] = parts;
  if (
    typeof activityAt !== "string" ||
    parsePgTimestampCursorValue(activityAt) === null ||
    !isUuidPaginationCursorPart(id) ||
    (type !== "entity" && type !== "thread")
  ) {
    return null;
  }

  return { activityAt, id, type };
};
