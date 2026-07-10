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

const timestampPattern =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})\.(?<microsecond>\d{6})$/u;

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
    !isWorkspaceActivityTimestamp(activityAt) ||
    !isUuidPaginationCursorPart(id) ||
    (type !== "entity" && type !== "thread")
  ) {
    return null;
  }

  return { activityAt, id, type };
};

const isWorkspaceActivityTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }

  const match = timestampPattern.exec(value);
  if (!match) {
    return false;
  }

  const { year, month, day, hour, minute, second, microsecond } =
    match.groups ?? {};
  const values = [year, month, day, hour, minute, second, microsecond].map(
    Number,
  );
  const [yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] =
    values;
  if (
    yearValue === undefined ||
    monthValue === undefined ||
    dayValue === undefined ||
    hourValue === undefined ||
    minuteValue === undefined ||
    secondValue === undefined
  ) {
    return false;
  }

  const date = new Date(
    Date.UTC(
      yearValue,
      monthValue - 1,
      dayValue,
      hourValue,
      minuteValue,
      secondValue,
    ),
  );

  return (
    date.getUTCFullYear() === yearValue &&
    date.getUTCMonth() === monthValue - 1 &&
    date.getUTCDate() === dayValue &&
    date.getUTCHours() === hourValue &&
    date.getUTCMinutes() === minuteValue &&
    date.getUTCSeconds() === secondValue
  );
};
