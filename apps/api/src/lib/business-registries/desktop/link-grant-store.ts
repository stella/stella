import { Result } from "better-result";
import { and, eq, gt, inArray, like, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { Temporal } from "@stll/time";

import { verification } from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";

const LINK_GRANT_LIFETIME_MS = 60_000;
const LINK_GRANT_PREFIX = "desktop-link";

const grantValue = ({
  userId,
  organizationId,
  verifierHash,
}: {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  verifierHash: string;
}) => JSON.stringify({ userId, organizationId, verifierHash });

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
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  db: LinkGrantDb;
  now?: Date;
};

export const createDesktopLinkGrant = async ({
  correlationId,
  verifierHash,
  userId,
  organizationId,
  db,
  now = new Date(Temporal.Now.instant().epochMilliseconds),
}: CreateDesktopLinkGrantOptions) =>
  await Result.tryPromise({
    try: async () => {
      await sweepExpiredLinkGrants(db, now);
      const expiresAt = new Date(now.getTime() + LINK_GRANT_LIFETIME_MS);
      await db.insert(verification).values({
        id: `${LINK_GRANT_PREFIX}:${correlationId}`,
        identifier: `${LINK_GRANT_PREFIX}:${correlationId}`,
        value: grantValue({ userId, organizationId, verifierHash }),
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

export type ConsumeDesktopLinkGrantOptions = {
  correlationId: string;
  verifier: string;
  expectedUserId: string;
  expectedOrganizationId: string;
  db: LinkGrantDb;
  now?: Date;
};

export const consumeDesktopLinkGrant = async ({
  correlationId,
  verifier,
  expectedUserId,
  expectedOrganizationId,
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
              verification.value,
              grantValue({
                userId: identity.userId,
                organizationId: identity.organizationId,
                verifierHash: hashSha256Hex(verifier),
              }),
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
  if (consumed.value.length !== 1) {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Desktop connection grant is invalid or expired",
      }),
    );
  }
  // The conditional claim proves these exact identity values were stored by
  // the signed-in browser; request identity alone never authorizes a member.
  return Result.ok(identity);
};
