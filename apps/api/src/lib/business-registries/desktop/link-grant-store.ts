import { Result } from "better-result";
import { and, eq, gt, inArray, like, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as v from "valibot";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { verification } from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";
import { checkSessionCredentialIssuer } from "@/api/lib/synthetic-principal/credential-policy";

const LINK_GRANT_LIFETIME_MS = 60_000;
const LINK_GRANT_PREFIX = "desktop-link";

type GrantClaim = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  verifierHash: string;
  deviceJkt: string;
};

const claimValue = ({
  userId,
  organizationId,
  verifierHash,
  deviceJkt,
}: GrantClaim) =>
  JSON.stringify({ userId, organizationId, verifierHash, deviceJkt });

// The issuing browser session is stored beside the claim: the desktop never
// learns it, and redemption issues its credential only while it is live.
const ISSUING_SESSION_FIELD = "sessionId";
const grantValue = (claim: GrantClaim & { sessionId: string }) =>
  JSON.stringify({
    userId: claim.userId,
    organizationId: claim.organizationId,
    verifierHash: claim.verifierHash,
    deviceJkt: claim.deviceJkt,
    [ISSUING_SESSION_FIELD]: claim.sessionId,
  });
const issuingSessionSchema = v.object({
  [ISSUING_SESSION_FIELD]: v.pipe(v.string(), v.nonEmpty()),
});

// Auth verification rows deny ordinary application access. A single root
// DELETE commits the claim independently of later credential issuance.
export type LinkGrantDb = {
  insert: (table: typeof verification) => {
    values: (row: typeof verification.$inferInsert) => PromiseLike<unknown>;
  };
  delete: (table: typeof verification) => {
    where: (condition: SQL | undefined) => {
      returning: () => PromiseLike<(typeof verification.$inferSelect)[]>;
    };
  };
};

const sweepExpiredLinkGrants = async (db: LinkGrantDb, now: Date) => {
  const expired = sql`(select ${verification.id} from ${verification}
    where ${like(verification.identifier, `${escapeLike(LINK_GRANT_PREFIX)}:%`)}
    and ${lte(verification.expiresAt, sql`${now.toISOString()}::timestamptz`)}
    limit 100)`;
  await db
    .delete(verification)
    .where(inArray(verification.id, expired))
    .returning();
};

export type CreateDesktopLinkGrantOptions = {
  correlationId: string;
  verifierHash: string;
  deviceJkt: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  /** The browser session that requests the connection. */
  sessionId: string;
  db: LinkGrantDb;
  now?: Date;
};

export const createDesktopLinkGrant = async ({
  correlationId,
  verifierHash,
  deviceJkt,
  userId,
  organizationId,
  sessionId,
  db,
  now = new Date(Temporal.Now.instant().epochMilliseconds),
}: CreateDesktopLinkGrantOptions) => {
  const access = checkSessionCredentialIssuer("desktopAccount", {
    userId,
    organizationId,
  });
  if (Result.isError(access)) {
    return Result.err(access.error);
  }
  return await Result.tryPromise({
    try: async () => {
      await sweepExpiredLinkGrants(db, now);
      const expiresAt = new Date(now.getTime() + LINK_GRANT_LIFETIME_MS);
      await db.insert(verification).values({
        id: `${LINK_GRANT_PREFIX}:${correlationId}`,
        identifier: `${LINK_GRANT_PREFIX}:${correlationId}`,
        value: grantValue({
          userId,
          organizationId,
          verifierHash,
          deviceJkt,
          sessionId,
        }),
        expiresAt,
      });
      return { userId, organizationId, expiresAt: expiresAt.toISOString() };
    },
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Could not connect desktop account",
        cause,
      }),
  });
};

export type ConsumeDesktopLinkGrantOptions = {
  correlationId: string;
  verifier: string;
  expectedUserId: string;
  expectedOrganizationId: string;
  deviceJkt: string;
  db: LinkGrantDb;
  now?: Date;
};

export const consumeDesktopLinkGrant = async ({
  correlationId,
  verifier,
  expectedUserId,
  expectedOrganizationId,
  deviceJkt,
  db,
  now = new Date(Temporal.Now.instant().epochMilliseconds),
}: ConsumeDesktopLinkGrantOptions) => {
  const identity = brandActorSessionIdentity({
    userId: expectedUserId,
    organizationId: expectedOrganizationId,
  });
  const consumed = await Result.tryPromise({
    try: async () =>
      await db
        .delete(verification)
        .where(
          and(
            eq(verification.id, `${LINK_GRANT_PREFIX}:${correlationId}`),
            eq(
              verification.identifier,
              `${LINK_GRANT_PREFIX}:${correlationId}`,
            ),
            eq(
              sql`${verification.value}::text::jsonb - ${ISSUING_SESSION_FIELD}::text`,
              sql`${claimValue({
                userId: identity.userId,
                organizationId: identity.organizationId,
                deviceJkt,
                verifierHash: hashSha256Hex(verifier),
              })}::text::jsonb`,
            ),
            gt(verification.expiresAt, sql`${now.toISOString()}::timestamptz`),
          ),
        )
        .returning(),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Desktop connection is unavailable",
        cause,
      }),
  });
  if (consumed.isErr()) {
    return Result.err(consumed.error);
  }
  const [claimed] = consumed.value;
  const issuing = v.safeParse(
    issuingSessionSchema,
    Result.try((): unknown => JSON.parse(claimed?.value ?? "")).unwrapOr(null),
  );
  if (consumed.value.length !== 1 || !issuing.success) {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Desktop connection grant is invalid or expired",
      }),
    );
  }
  // The conditional claim proves these exact identity values were stored by
  // the signed-in browser; request identity alone never authorizes a member.
  return Result.ok({
    ...identity,
    deviceJkt,
    sessionId: issuing.output[ISSUING_SESSION_FIELD],
  });
};
