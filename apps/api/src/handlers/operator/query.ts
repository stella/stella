import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, asc, gte } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";
import { timingSafeEqual } from "node:crypto";

import { DAY_IN_MS } from "@stll/time";

// eslint-disable-next-line security-guards/no-unscoped-user-query -- operator observability is deliberately instance-wide: the endpoint is token-gated at the deployment level and lists registrations across the whole instance, so there is no organization to scope by.
import { user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import { LIMITS } from "@/api/lib/limits";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

/**
 * Registrations older than this cannot be listed. The endpoint exists for
 * operational visibility into recent sign-ups, not as a bulk account-export
 * surface, so the readable window stays deliberately short.
 */
export const OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS = 90;

const MAX_LOOKBACK_MS = OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS * DAY_IN_MS;

/** Better Auth user ids are text (not UUIDs); mirror `tUserId`'s bounds. */
const isUserIdCursorPart = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 128;

const registrationCursor = createTimestampIdCursorCodec({
  column: user.createdAt,
  brandId: brandPersistedUserId,
  isIdPart: isUserIdCursorPart,
});

/**
 * Route-level schema is deliberately permissive: Elysia validates the query
 * before the handler's token gate runs, so a strict schema would emit 422s
 * to unauthenticated probes — leaking both the endpoint's existence (which
 * must read as 404 while unconfigured) and its parameter shape. All real
 * validation happens post-authorization in `validateRegistrationsFilter`.
 */
export const readRegistrationsQuerySchema = t.Object({
  since: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  cursor: t.Optional(t.String()),
});

export type ReadRegistrationsQuery = Static<
  typeof readRegistrationsQuerySchema
>;

const BEARER_PREFIX = "Bearer ";

type AuthorizeOperatorAccessOptions = {
  /** The deployment's configured token; undefined when the feature is off. */
  configuredToken: string | undefined;
  /** Raw `Authorization` request header, if any. */
  authorizationHeader: string | null;
};

export type OperatorAccess =
  | { status: "disabled" }
  | { status: "unauthorized" }
  | { status: "authorized" };

/**
 * Gate for the operator endpoints. No configured token means the feature is
 * off (`disabled` → the route reports 404, like other unconfigured
 * operational surfaces). Token comparison is constant-time over sha256
 * digests so neither length nor prefix leaks.
 */
export const authorizeOperatorAccess = ({
  configuredToken,
  authorizationHeader,
}: AuthorizeOperatorAccessOptions): OperatorAccess => {
  if (!configuredToken) {
    return { status: "disabled" };
  }
  if (
    authorizationHeader === null ||
    !authorizationHeader.startsWith(BEARER_PREFIX)
  ) {
    return { status: "unauthorized" };
  }
  const presented = authorizationHeader.slice(BEARER_PREFIX.length);
  const configuredDigest = new Bun.CryptoHasher("sha256")
    .update(configuredToken)
    .digest();
  const presentedDigest = new Bun.CryptoHasher("sha256")
    .update(presented)
    .digest();
  return timingSafeEqual(configuredDigest, presentedDigest)
    ? { status: "authorized" }
    : { status: "unauthorized" };
};

/**
 * Replicates every 400 the read path rejects on before any query runs
 * (`since` outside the lookback window, malformed cursor). Returns the
 * human-readable reason, or null when the filter is valid.
 */
export type RegistrationsFilter = {
  since: Date;
  limit: number;
  cursor: string | undefined;
};

export type RegistrationsFilterResult =
  | { ok: true; filter: RegistrationsFilter }
  | { ok: false; message: string };

export const validateRegistrationsFilter = (
  query: ReadRegistrationsQuery,
  now: Date,
): RegistrationsFilterResult => {
  if (query.since === undefined) {
    return { ok: false, message: "since is required" };
  }
  const since = new Date(query.since);
  if (Number.isNaN(since.getTime())) {
    return { ok: false, message: "since must be an ISO date-time" };
  }
  if (now.getTime() - since.getTime() > MAX_LOOKBACK_MS) {
    return {
      ok: false,
      message: `since must be within the last ${OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS} days`,
    };
  }
  let limit: number = LIMITS.operatorRegistrationsPageSizeDefault;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > LIMITS.operatorRegistrationsPageSizeMax
    ) {
      return {
        ok: false,
        message: `limit must be an integer between 1 and ${LIMITS.operatorRegistrationsPageSizeMax}`,
      };
    }
    limit = parsed;
  }
  if (query.cursor !== undefined && !registrationCursor.decode(query.cursor)) {
    return { ok: false, message: "Invalid cursor" };
  }
  return { ok: true, filter: { since, limit, cursor: query.cursor } };
};

/**
 * Runs the validated registrations listing: accounts created at or after
 * `since`, oldest first, keyset-paged on `(created_at, id)`. Callers must
 * invoke `validateRegistrationsFilter` first. Returns only the four
 * operator-visible fields (id, email, name, createdAt).
 *
 * @yields SafeDb errors out to the safe-handler runner.
 */
export const queryRegistrationsPage = async function* ({
  safeDb,
  filter,
}: {
  safeDb: SafeDb;
  filter: RegistrationsFilter;
}) {
  const { limit } = filter;

  const conditions: SQL[] = [gte(user.createdAt, filter.since)];
  if (filter.cursor) {
    const cursor = registrationCursor.decode(filter.cursor);
    if (cursor) {
      const cursorCondition = registrationCursor.keysetAfter({
        cursor,
        idColumn: user.id,
        direction: "ascending",
      });
      if (cursorCondition) {
        conditions.push(cursorCondition);
      }
    }
  }

  const rows = yield* Result.await(
    safeDb(
      async (tx) =>
        await tx
          .select({
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.createdAt,
            createdAtCursor:
              registrationCursor.cursorValue.as("created_at_cursor"),
          })
          .from(user)
          .where(and(...conditions))
          .orderBy(asc(user.createdAt), asc(user.id))
          .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) =>
      registrationCursor.encode(item.createdAtCursor, item.id),
  });

  return Result.ok({
    ...page,
    items: page.items.map(
      ({ createdAtCursor: _createdAtCursor, ...item }) => item,
    ),
  });
};
