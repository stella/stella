import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { randomBytes } from "node:crypto";

import { session } from "@/api/db/auth-schema";
import { revokeUserSessionById } from "@/api/lib/auth-artifacts";
import {
  SESSION_ABSOLUTE_AGE_MS,
  SESSION_PRIOR_TOKEN_GRACE_MS,
} from "@/api/lib/auth/session-lifetime";
import type { SessionLifetimeStore } from "@/api/lib/auth/session-lifetime";
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

  // Every credential check enforces the absolute lifetime from creation, so
  // no request path, boundary or activity level can keep a session past it.
  const liveSessionPredicate = (now: Date, table = session) =>
    and(
      sql`${table.expiresAt} > ${now}::timestamptz`,
      sql`${table.createdAt} > ${new Date(now.getTime() - SESSION_ABSOLUTE_AGE_MS)}::timestamptz`,
      or(
        isNull(table.lastSeenAt),
        sql`${table.expiresAt} > ${table.lastSeenAt}::timestamptz`,
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
    observe: async ({ token, now }) => {
      const current = await findCurrentSession(token, now);
      if (!current) {
        return null;
      }
      const staleBefore = new Date(
        now.getTime() - SESSION_ACTIVITY_WRITE_INTERVAL_MS,
      );
      if (current.lastSeenAt !== null && current.lastSeenAt > staleBefore) {
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
          lastSeenAt: sql`GREATEST(${session.lastSeenAt}, ${now}::timestamptz)`,
          updatedAt: session.updatedAt,
        })
        .where(
          and(
            credentialPredicate({ token, now }),
            liveSessionPredicate(now),
            staleActivity,
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
      const rows = await db
        .update(session)
        .set({
          token: randomBytes(32).toString("hex"),
          priorTokenHash: hashSessionToken(token),
          priorTokenExpiresAt: new Date(
            now.getTime() + SESSION_PRIOR_TOKEN_GRACE_MS,
          ),
          // A refresh never reaches past the absolute lifetime.
          expiresAt: sql`LEAST(${expiresAt}::timestamptz, ${session.createdAt} + ${`${SESSION_ABSOLUTE_AGE_MS} milliseconds`}::interval)`,
          updatedAt: now,
          lastSeenAt: sql`GREATEST(${session.lastSeenAt}, ${now}::timestamptz)`,
        })
        .where(
          and(
            eq(session.token, token),
            eq(session.refreshMode, "automatic"),
            liveSessionPredicate(now),
            // Due inside the refresh window, and at most once per update interval:
            // an expiry shortened by the absolute lifetime stays inside the
            // window, so the last refresh time keeps it from rotating every request.
            sql`${session.expiresAt} <= ${new Date(now.getTime() + (expiresIn - updateAge) * 1000)}::timestamptz`,
            sql`${session.updatedAt} <= ${new Date(now.getTime() - updateAge * 1000)}::timestamptz`,
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
