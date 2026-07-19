import { Result } from "better-result";
import type { SQL } from "drizzle-orm";
import { and, asc, gte } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";
import { timingSafeEqual } from "node:crypto";

import { user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import { tPaginationLimit } from "@/api/lib/custom-schema";
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

const MAX_LOOKBACK_MS =
  OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

/** Better Auth user ids are text (not UUIDs); mirror `tUserId`'s bounds. */
const isUserIdCursorPart = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 128;

const registrationCursor = createTimestampIdCursorCodec({
  column: user.createdAt,
  brandId: brandPersistedUserId,
  isIdPart: isUserIdCursorPart,
});

export const readRegistrationsQuerySchema = t.Object({
  since: t.String({ format: "date-time" }),
  limit: t.Optional(tPaginationLimit(LIMITS.operatorRegistrationsPageSizeMax)),
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
export const validateRegistrationsFilter = (
  query: ReadRegistrationsQuery,
  now: Date,
): string | null => {
  const since = new Date(query.since);
  if (now.getTime() - since.getTime() > MAX_LOOKBACK_MS) {
    return `since must be within the last ${OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS} days`;
  }
  if (query.cursor && !registrationCursor.decode(query.cursor)) {
    return "Invalid cursor";
  }
  return null;
};

/**
 * Runs the validated registrations listing: accounts created at or after
 * `since`, oldest first, keyset-paged on `(created_at, id)`. Callers must
 * invoke `validateRegistrationsFilter` first. Returns only the four
 * operator-visible fields (id, email, name, createdAt).
 */
export const queryRegistrationsPage = async function* ({
  safeDb,
  query,
}: {
  safeDb: SafeDb;
  query: ReadRegistrationsQuery;
}) {
  const limit = query.limit ?? LIMITS.operatorRegistrationsPageSizeDefault;

  const conditions: SQL[] = [gte(user.createdAt, new Date(query.since))];
  if (query.cursor) {
    const cursor = registrationCursor.decode(query.cursor);
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
