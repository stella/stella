import { Result } from "better-result";
import { and, eq, gt, inArray, like, lte, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import { verification } from "@/api/db/auth-schema";
import { rootDb, rlsDb } from "@/api/db/root";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { resolveCredentialMemberAuthorization } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { DESKTOP_ACCOUNT_PERMISSION } from "@/api/lib/business-registries/desktop/config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import { isMemberRole } from "@/api/lib/member-roles";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import {
  AUTH_PROVIDER_ID_PATTERN,
  brandActorSessionIdentity,
} from "@/api/lib/safe-id-boundaries";

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
type LinkGrantDb = {
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

type CreateDesktopLinkGrantOptions = {
  correlationId: string;
  verifierHash: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  db?: LinkGrantDb;
  now?: Date;
};

export const createDesktopLinkGrant = async ({
  correlationId,
  verifierHash,
  userId,
  organizationId,
  db = rootDb,
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

type ConsumeDesktopLinkGrantOptions = {
  correlationId: string;
  verifier: string;
  expectedUserId: string;
  expectedOrganizationId: string;
  db?: LinkGrantDb;
  now?: Date;
};

export const consumeDesktopLinkGrant = async ({
  correlationId,
  verifier,
  expectedUserId,
  expectedOrganizationId,
  db = rootDb,
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
                verifierHash: createHash("sha256")
                  .update(verifier)
                  .digest("hex"),
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

const desktopLinkCredentials = v.strictObject({
  correlationId: v.pipe(v.string(), v.uuid()),
  verifier: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  expectedUserId: v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
  expectedOrganizationId: v.pipe(v.string(), v.regex(AUTH_PROVIDER_ID_PATTERN)),
});

export const parseDesktopLinkCredentials = (input: unknown) =>
  v.safeParse(desktopLinkCredentials, input);

export const authorizeDesktopLinkGrant = async (input: unknown) => {
  const parsed = parseDesktopLinkCredentials(input);
  if (!parsed.success) {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Desktop connection grant is invalid or expired",
      }),
    );
  }
  const consumed = await consumeDesktopLinkGrant(parsed.output);
  if (consumed.isErr()) {
    return Result.err(consumed.error);
  }
  const identity = consumed.value;
  const member = await Result.tryPromise({
    try: async () => await resolveCredentialMemberAuthorization(identity),
    catch: (cause) =>
      new HandlerError({
        status: 503,
        message: "Desktop account is unavailable",
        cause,
      }),
  });
  if (member.isErr()) {
    return Result.err(member.error);
  }
  if (
    !member.value ||
    !isMemberRole(member.value.role) ||
    !hasMemberPermission(
      { role: member.value.role },
      DESKTOP_ACCOUNT_PERMISSION,
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 401,
        message: "Desktop account is unavailable",
      }),
    );
  }
  return Result.ok({
    ...identity,
    scopedDb: createMembershipScopedDb(rlsDb, {
      ...identity,
      serverValidatedWorkspaceIds: [],
    }),
  });
};
