import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { createHash, randomBytes } from "node:crypto";

import { session } from "@/api/db/auth-schema";
import {
  SESSION_ABSOLUTE_AGE_MS,
  SESSION_IDLE_AGE_MS,
  SESSION_PRIOR_TOKEN_GRACE_MS,
} from "@/api/lib/auth/session-lifetime";
import type { SessionLifetimeStore } from "@/api/lib/auth/session-lifetime";

export const hashSessionToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

type SessionLifetimeDatabase = {
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
        where: SQL | undefined;
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
  const credentialPredicate = (token: string, now: Date) =>
    or(
      eq(session.token, token),
      and(
        eq(session.priorTokenHash, hashSessionToken(token)),
        sql`${session.priorTokenExpiresAt} > ${now}::timestamptz`,
      ),
    );

  // A startup expiration ends at lastSeenAt; earlier requests cannot reopen it.
  const liveSessionPredicate = (now: Date) =>
    and(
      sql`${session.expiresAt} > ${now}::timestamptz`,
      or(
        isNull(session.lastSeenAt),
        sql`${session.expiresAt} > ${session.lastSeenAt}::timestamptz`,
      ),
    );

  return {
    observe: async ({ token, now, boundary }) => {
      const expiredAtBoundary =
        boundary === "startup"
          ? sql<boolean>`${session.createdAt} <= ${new Date(now.getTime() - SESSION_ABSOLUTE_AGE_MS)}::timestamptz
              AND ${session.lastSeenAt} <= ${new Date(now.getTime() - SESSION_IDLE_AGE_MS)}::timestamptz`
          : sql<boolean>`false`;
      // The activity observation and startup decision share the row's atomic write.
      const rows = await db
        .update(session)
        .set({
          lastSeenAt: sql`GREATEST(${session.lastSeenAt}, ${now}::timestamptz)`,
          expiresAt: sql`CASE WHEN ${expiredAtBoundary} THEN ${now}::timestamptz ELSE ${session.expiresAt} END`,
          updatedAt: session.updatedAt,
        })
        .where(and(credentialPredicate(token, now), liveSessionPredicate(now)))
        .returning();
      const current = rows.at(0);
      return current && current.expiresAt > now ? current : null;
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
          expiresAt,
          updatedAt: now,
          lastSeenAt: sql`GREATEST(${session.lastSeenAt}, ${now}::timestamptz)`,
        })
        .where(
          and(
            eq(session.token, token),
            liveSessionPredicate(now),
            sql`${session.expiresAt} <= ${new Date(now.getTime() + (expiresIn - updateAge) * 1000)}::timestamptz`,
          ),
        )
        .returning();
      const updated = rows.at(0);
      if (updated) {
        return updated;
      }
      // A concurrent refresh converges to the credential already installed.
      return (
        (await db.query.session.findFirst({
          where: and(
            credentialPredicate(token, now),
            liveSessionPredicate(now),
          ),
        })) ?? null
      );
    },
  };
};
