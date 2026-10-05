import { Result } from "better-result";

import { DAY_IN_MS, Temporal } from "@stll/time";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { decodePaginationCursor } from "@/api/lib/pagination";

export const REGISTRATION_LOOKBACK_MS = 31 * DAY_IN_MS;
export const REGISTRATION_PAGE_CAP = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_CURSOR_LENGTH = 1024;

export type RegistrationQuery = {
  since: string;
  limit: number;
  cursor: { createdAt: string; id: string } | null;
};

type ParseRegistrationQueryOptions = {
  query: {
    since?: string | undefined;
    limit?: string | undefined;
    cursor?: string | undefined;
  };
  now: number;
};

const invalidQuery = (message: string) =>
  Result.err(new HandlerError({ status: 400, message }));

export const parseRegistrationQuery = ({
  query,
  now,
}: ParseRegistrationQueryOptions) => {
  const since = Result.try(() =>
    Temporal.Instant.from(query.since ?? ""),
  ).unwrapOr(null);
  if (since === null) {
    return invalidQuery("since must be an ISO 8601 timestamp with a time zone");
  }
  const current = Temporal.Instant.fromEpochMilliseconds(now);
  if (
    Temporal.Instant.compare(since, current) > 0 ||
    Temporal.Instant.compare(
      since,
      current.subtract({ milliseconds: REGISTRATION_LOOKBACK_MS }),
    ) < 0
  ) {
    return invalidQuery("since must be within the past 31 days");
  }

  const requestedLimit =
    query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    return invalidQuery("limit must be a positive integer");
  }
  const limit = Math.min(requestedLimit, REGISTRATION_PAGE_CAP);
  let cursor: RegistrationQuery["cursor"] = null;
  if (query.cursor !== undefined) {
    if (query.cursor.length > MAX_CURSOR_LENGTH) {
      return invalidQuery("Invalid cursor; restart without cursor");
    }
    const parts = decodePaginationCursor(query.cursor);
    if (parts?.length !== 3) {
      return invalidQuery("Invalid cursor; restart without cursor");
    }
    const [cursorSince, createdAt, id] = parts;
    const position = Result.try(() =>
      typeof createdAt === "string" ? Temporal.Instant.from(createdAt) : null,
    ).unwrapOr(null);
    if (
      cursorSince !== since.toString() ||
      position === null ||
      typeof createdAt !== "string" ||
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 128 ||
      !id.isWellFormed() ||
      id.includes("\0") ||
      position.epochNanoseconds % 1000n !== 0n ||
      Temporal.Instant.compare(position, since) < 0 ||
      Temporal.Instant.compare(position, current) > 0
    ) {
      return invalidQuery("Invalid cursor; restart without cursor");
    }
    cursor = { createdAt: position.toString(), id };
  }
  return Result.ok({ since: since.toString(), limit, cursor });
};
