import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { randomBytes } from "node:crypto";

import { session } from "@/api/db/auth-schema";
import { revokeUserSessionById } from "@/api/lib/auth-artifacts";
import {
  isPendingRotation,
  SESSION_ABSOLUTE_AGE_MS,
  SESSION_PRIOR_TOKEN_CONFIRMED_GRACE_MS,
  SESSION_PRIOR_TOKEN_RECOVERY_MS,
} from "@/api/lib/auth/session-lifetime";
import type { SessionLifetimeStore } from "@/api/lib/auth/session-lifetime";
import { liveSessionPredicate } from "@/api/lib/auth/session-liveness";
import { hashSessionToken } from "@/api/lib/auth/session-token";

const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

type SessionLifetimeDatabase = {
  delete: (table: typeof session) => {
    where: (condition: SQL | undefined) => PromiseLike<unknown>;
  };
  update: (table: typeof session) => {
    set: (values: PgUpdateSetSource<typeof session>) => {
      where: (condition: SQL | undefined) => {
        returning: () => PromiseLike<(typeof session.$inferSelect)[]>;
      };
    };
  };
  query: {
    session: {
      findFirst: (options: {
        where: { RAW: (table: typeof session) => SQL };
      }) => PromiseLike<typeof session.$inferSelect | undefined>;
    };
  };
};

type DatabaseSessionLifetimeOptions = {
  expiresIn: number;
  updateAge: number;
};

export const createDatabaseSessionLifetimeStore = (
  db: SessionLifetimeDatabase,
  { expiresIn, updateAge }: DatabaseSessionLifetimeOptions,
): SessionLifetimeStore => {
  type CredentialPredicateOptions = {
    token: string;
    now: Date;
    table?: typeof session;
  };
  const credentialPredicate = ({
    token,
    now,
    table = session,
  }: CredentialPredicateOptions) =>
    or(
      eq(table.token, token),
      and(
        eq(table.priorTokenHash, hashSessionToken(token)),
        sql`${table.priorTokenExpiresAt} > ${now}::timestamptz`,
      ),
    );

  const findCurrentSession = async (token: string, now: Date) =>
    (await db.query.session.findFirst({
      where: {
        RAW: (table) =>
          sql`${credentialPredicate({ token, now, table })} AND ${liveSessionPredicate(now, table)}`,
      },
    })) ?? null;

  return {
    observe: async ({ token, now, presentedToken }) => {
      const current = await findCurrentSession(token, now);
      if (!current) {
        return null;
      }
      const staleBefore = new Date(
        now.getTime() - SESSION_ACTIVITY_WRITE_INTERVAL_MS,
      );
      // Internal SDK calls can use the resolved token before the client has it.
      const confirmsRotation =
        current.token === presentedToken &&
        isPendingRotation(current.priorTokenExpiresAt, now);
      const confirmedGraceEnd = new Date(
        now.getTime() + SESSION_PRIOR_TOKEN_CONFIRMED_GRACE_MS,
      );
      if (
        !confirmsRotation &&
        current.lastSeenAt !== null &&
        current.lastSeenAt > staleBefore
      ) {
        return current;
      }
      const staleActivity = or(
        isNull(session.lastSeenAt),
        sql`${session.lastSeenAt} <= ${staleBefore}::timestamptz`,
      );
      // Recheck activity under the row lock so concurrent requests write once.
      const rows = await db
        .update(session)
        .set({
          ...(confirmsRotation
            ? {
                priorTokenExpiresAt: sql`LEAST(${session.priorTokenExpiresAt}, ${confirmedGraceEnd}::timestamptz)`,
              }
            : {}),
          lastSeenAt: sql`GREATEST(${session.lastSeenAt}, ${now}::timestamptz)`,
          updatedAt: session.updatedAt,
        })
        .where(
          and(
            credentialPredicate({ token, now }),
            liveSessionPredicate(now),
            confirmsRotation
              ? and(
                  eq(session.token, token),
                  sql`${session.priorTokenExpiresAt} > ${confirmedGraceEnd}::timestamptz`,
                )
              : staleActivity,
          ),
        )
        .returning();
      const observed = rows.at(0);
      if (observed) {
        return observed.expiresAt > now ? observed : null;
      }
      return await findCurrentSession(token, now);
    },
    refresh: async ({ token, now, expiresAt }) => {
      const rotationDueAt = new Date(now.getTime() - updateAge * 1000);
      const rotatedToken = randomBytes(32).toHex();
      const rows = await db
        .update(session)
        .set({
          token: sql`CASE WHEN ${session.updatedAt} <= ${rotationDueAt}::timestamptz THEN ${rotatedToken} ELSE ${session.token} END`,
          priorTokenHash: sql`CASE WHEN ${session.updatedAt} <= ${rotationDueAt}::timestamptz THEN ${hashSessionToken(token)} ELSE ${session.priorTokenHash} END`,
          priorTokenExpiresAt: sql`CASE WHEN ${session.updatedAt} <= ${rotationDueAt}::timestamptz THEN ${new Date(now.getTime() + SESSION_PRIOR_TOKEN_RECOVERY_MS)}::timestamptz ELSE ${session.priorTokenExpiresAt} END`,
          // A refresh never reaches past the absolute lifetime or a text
          // handoff's absolute deadline (LEAST ignores a null deadline).
          expiresAt: sql`LEAST(${expiresAt}::timestamptz, ${session.createdAt} + ${`${SESSION_ABSOLUTE_AGE_MS} milliseconds`}::interval, ${session.handoffAbsoluteExpiresAt})`,
          updatedAt: sql`CASE WHEN ${session.updatedAt} <= ${rotationDueAt}::timestamptz THEN ${now}::timestamptz ELSE ${session.updatedAt} END`,
          lastSeenAt: sql`GREATEST(${session.lastSeenAt}, ${now}::timestamptz)`,
        })
        .where(
          and(
            eq(session.token, token),
            eq(session.refreshMode, "automatic"),
            sql`${session.expiresAt} < ${session.createdAt}::timestamptz + ${`${SESSION_ABSOLUTE_AGE_MS} milliseconds`}::interval`,
            liveSessionPredicate(now),
            // Due inside the refresh window. Rotation remains limited to once per
            // update interval, but expiry extension cannot wait for that throttle.
            sql`${session.expiresAt} <= ${new Date(now.getTime() + (expiresIn - updateAge) * 1000)}::timestamptz`,
          ),
        )
        .returning();
      const updated = rows.at(0);
      if (updated) {
        return updated;
      }
      // A concurrent refresh converges; fixed credentials retain their expiry.
      return await findCurrentSession(token, now);
    },
    revokeById: async (options) => await revokeUserSessionById(db, options),
  };
};
