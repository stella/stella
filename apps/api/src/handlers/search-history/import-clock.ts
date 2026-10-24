import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import * as v from "valibot";

import { API_STORABLE_INSTANT_CHECK } from "@stll/api-contract/api-date";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { keyedContentLookupKey } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  assertSearchHistoryScope,
  searchHistoryScopeQuery,
} from "./scope-precondition";

export const searchHistoryImportClockSchema = v.strictObject({
  issuedAt: v.pipe(
    v.string(),
    v.isoTimestamp(),
    API_STORABLE_INSTANT_CHECK,
    v.maxLength(64),
    v.description(
      "The database time returned by search-history/import-clock. Obtain it before capturing clientNow.",
    ),
  ),
  signature: v.pipe(
    v.string(),
    v.regex(/^[a-f0-9]{64}$/u),
    v.minLength(64),
    v.maxLength(64),
  ),
});

// Use the deletion barriers' database clock, with precision rounded down.
export const readSearchHistoryDatabaseClock = async (tx: Transaction) => {
  const row = (
    await tx
      .select({
        issuedAt: sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      })
      .from(sql`(SELECT 1) AS clock_row`)
  ).at(0);
  return row?.issuedAt ?? panic("Expected the search history database clock");
};

type ImportClockOwner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
const clockSignature = async (
  { organizationId, userId }: ImportClockOwner,
  issuedAt: string,
) =>
  (
    await keyedContentLookupKey(
      organizationId,
      JSON.stringify(["search-history-import-clock:v1", userId, issuedAt]),
    )
  ).mapError(
    (cause) =>
      new HandlerError({
        status: 503,
        message: "Search history import is unavailable. Retry later.",
        cause,
      }),
  );

type VerifySearchHistoryImportClockOptions = ImportClockOwner & {
  clock: v.InferOutput<typeof searchHistoryImportClockSchema>;
  databaseNow: string;
};
export const verifySearchHistoryImportClock = async ({
  organizationId,
  userId,
  clock,
  databaseNow,
}: VerifySearchHistoryImportClockOptions): Promise<
  Result<number, HandlerError>
> => {
  const issuedAt = Result.try(() =>
    Temporal.Instant.from(clock.issuedAt),
  ).unwrapOr(null);
  const now = Temporal.Instant.from(databaseNow);
  if (
    issuedAt === null ||
    issuedAt.epochNanoseconds > now.epochNanoseconds ||
    !/^[a-f0-9]{64}$/u.test(clock.signature)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "Search history import clock is invalid. Obtain a new clock and retry.",
      }),
    );
  }
  const expected = await clockSignature(
    { organizationId, userId },
    clock.issuedAt,
  );
  if (expected.isErr()) {
    return Result.err(expected.error);
  }
  if (
    !timingSafeEqual(Buffer.from(expected.value), Buffer.from(clock.signature))
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "Search history import clock is invalid. Obtain a new clock and retry.",
      }),
    );
  }
  return Result.ok(issuedAt.epochMilliseconds);
};

const config = {
  contract: "patch",
  query: searchHistoryScopeQuery,
  permissions: { searchHistory: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "search_ui" },
} satisfies HandlerConfig;

const importClock = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, query }) {
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    yield* assertSearchHistoryScope({ query, ...owner });
    const issuedAt = yield* Result.await(
      safeDb(readSearchHistoryDatabaseClock),
    );
    const signature = yield* Result.await(clockSignature(owner, issuedAt));
    return Result.ok({ issuedAt, signature });
  },
);

export default importClock;
