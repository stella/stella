import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import {
  SESSION_SIGN_IN_REVIEW,
  type SessionSignInLocation,
  type SessionSignInReview,
} from "@stll/api-contract/session-sign-ins";
import type { MapPlace } from "@stll/transactional/map/location-map";

import { session } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { sessionSignIns } from "@/api/db/schema";
import {
  createAuditRecorder,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { SESSION_SIGN_IN_REVIEW_TRANSITIONS } from "@/api/lib/auth/session-sign-in-review-transitions";
import type { ViewerLocation } from "@/api/lib/auth/viewer-location";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { liveSessionPredicate } from "@/api/lib/db/session-liveness";
import { transitionScopedCount } from "@/api/lib/db/transitions";

type SessionSignInDatabase = {
  transaction: <T>(run: (tx: Transaction) => Promise<T>) => Promise<T>;
};

type SessionSignInRow = typeof sessionSignIns.$inferSelect;

/** One of the account holder's live sessions, as the security page shows it. */
export type SessionSignInSummary = {
  id: string;
  location: SessionSignInLocation;
  review: SessionSignInReview;
};

type RecordSessionSignInOptions = {
  sessionId: string;
  location: ViewerLocation;
};

type SessionSignInScope = {
  userId: SafeId<"user">;
  sessionId: string;
};

type DecideSessionSignInOptions = SessionSignInScope & {
  review: (typeof SESSION_SIGN_IN_REVIEW)["confirmed" | "pending"];
  /** The deciding request; absent when the server calls the endpoint itself. */
  request: Request | undefined;
};

/** Why a review decision changed nothing. */
export const SESSION_SIGN_IN_REVIEW_REFUSAL = {
  /** No live session of this account holder has that id. */
  notFound: "not_found",
  /** The sign-in never asked for review, so there is nothing to decide. */
  notUnderReview: "not_under_review",
} as const;

export type SessionSignInReviewRefusal =
  (typeof SESSION_SIGN_IN_REVIEW_REFUSAL)[keyof typeof SESSION_SIGN_IN_REVIEW_REFUSAL];

/** The audit event each review transition records. */
const REVIEW_AUDIT_EVENT = {
  [SESSION_SIGN_IN_REVIEW.pending]: "account.sign_in.confirmation_undone",
  [SESSION_SIGN_IN_REVIEW.confirmed]: "account.sign_in.confirmed",
} as const;

/** A decision moves a sign-in only out of the other reviewable status. */
const REVIEW_MOVE = {
  [SESSION_SIGN_IN_REVIEW.pending]: {
    from: [SESSION_SIGN_IN_REVIEW.confirmed],
    to: SESSION_SIGN_IN_REVIEW.pending,
  },
  [SESSION_SIGN_IN_REVIEW.confirmed]: {
    from: [SESSION_SIGN_IN_REVIEW.pending],
    to: SESSION_SIGN_IN_REVIEW.confirmed,
  },
} as const;

const toLocationRow = (
  location: ViewerLocation,
): Omit<typeof sessionSignIns.$inferInsert, "sessionId"> => {
  switch (location.type) {
    case "unknown":
      return { locationKind: "unknown" };
    case "known":
      return {
        locationKind: "known",
        countryCode: location.countryCode,
        region: location.region,
        city: location.city,
        latitude: location.coordinates?.latitude ?? null,
        longitude: location.coordinates?.longitude ?? null,
      };
    default:
      location satisfies never;
      return panic("Unknown viewer location kind");
  }
};

/**
 * Reads a stored location back. A session from before locations were recorded
 * has no row; the caller reports it as unknown, like a location the edge did
 * not report.
 */
const toLocation = (
  row: Pick<
    SessionSignInRow,
    | "locationKind"
    | "countryCode"
    | "region"
    | "city"
    | "latitude"
    | "longitude"
  >,
): SessionSignInLocation => {
  switch (row.locationKind) {
    case "unknown":
      return { type: "unknown" };
    case "known":
      return {
        type: "known",
        countryCode:
          row.countryCode ?? panic("A known sign-in location names a country"),
        region: row.region,
        city: row.city,
        coordinates:
          row.latitude === null || row.longitude === null
            ? null
            : { latitude: row.latitude, longitude: row.longitude },
      };
    default:
      row.locationKind satisfies never;
      return panic("Unknown sign-in location status");
  }
};

const ownLiveSession = ({ userId, sessionId }: SessionSignInScope, now: Date) =>
  and(
    eq(session.id, sessionId),
    eq(session.userId, userId),
    liveSessionPredicate(now),
  );

/** The sign-in row of one of the account holder's own live sessions. */
const ownSignIn = (scope: SessionSignInScope, now: Date) =>
  sql`${sessionSignIns.sessionId} = ${scope.sessionId} AND EXISTS (SELECT 1 FROM ${session} WHERE ${ownLiveSession(scope, now)})`;

export const createSessionSignInStore = ({
  database,
  now = () => new Date(),
}: {
  database: SessionSignInDatabase;
  now?: () => Date;
}) => ({
  /** Records where a new session signed in from; a replay keeps the first. */
  record: async ({ sessionId, location }: RecordSessionSignInOptions) => {
    await withAggregateTransaction(database, async (tx) => {
      // audit: skip - written as part of creating the session it describes
      await tx
        .insert(sessionSignIns)
        .values({ sessionId, ...toLocationRow(location) })
        .onConflictDoNothing({ target: sessionSignIns.sessionId });
    });
  },

  /**
   * Marks a sign-in the new-device email is about to report as waiting for
   * review. Only a sign-in nobody has decided on yet moves, so a repeated
   * notice never reopens a confirmed one.
   */
  requestReview: async ({ userId, sessionId }: SessionSignInScope) => {
    await withAggregateTransaction(database, async (tx) => {
      await transitionScopedCount({
        tx,
        spec: SESSION_SIGN_IN_REVIEW_TRANSITIONS,
        where: ownSignIn({ userId, sessionId }, now()),
        options: {
          from: [SESSION_SIGN_IN_REVIEW.notRequired],
          to: SESSION_SIGN_IN_REVIEW.pending,
        },
        recordTransitionAuditEvent: async (auditTx) => {
          await createBackgroundAuditRecorder({ account: { userId } })(
            auditTx,
            { type: "account.sign_in.review_requested", resourceId: sessionId },
          );
        },
      });
    });
  },

  /**
   * Confirms a pending sign-in, or undoes that confirmation. Scoped to the
   * account holder's own live sessions in the same statement that moves it;
   * deciding the status it already has changes nothing and records nothing.
   */
  decide: async ({
    userId,
    sessionId,
    review,
    request,
  }: DecideSessionSignInOptions): Promise<
    Result<SessionSignInReview, SessionSignInReviewRefusal>
  > =>
    await withAggregateTransaction(database, async (tx) => {
      const scope = ownLiveSession({ userId, sessionId }, now());
      // The expected status and the ownership scope sit in the statement that
      // moves the row, so a concurrent decision cannot be overwritten.
      const moved = await transitionScopedCount({
        tx,
        spec: SESSION_SIGN_IN_REVIEW_TRANSITIONS,
        where: ownSignIn({ userId, sessionId }, now()),
        options: {
          ...REVIEW_MOVE[review],
          set: {
            reviewedAt:
              review === SESSION_SIGN_IN_REVIEW.confirmed ? now() : null,
          },
        },
        recordTransitionAuditEvent: async (auditTx) => {
          const event = {
            type: REVIEW_AUDIT_EVENT[review],
            resourceId: sessionId,
          } as const;
          await (request === undefined
            ? createBackgroundAuditRecorder({ account: { userId } })(
                auditTx,
                event,
              )
            : createAuditRecorder({
                account: { userId },
                request,
                server: null,
              })(auditTx, event));
        },
      });
      if (moved > 0) {
        return Result.ok(review);
      }
      const current = await tx
        .select({
          sessionId: session.id,
          signInSessionId: sessionSignIns.sessionId,
          review: sessionSignIns.review,
        })
        .from(session)
        .leftJoin(sessionSignIns, eq(sessionSignIns.sessionId, session.id))
        .where(scope)
        .limit(1);
      const row = current.at(0);
      if (row === undefined) {
        return Result.err(SESSION_SIGN_IN_REVIEW_REFUSAL.notFound);
      }
      // Deciding the status a sign-in already has changes nothing. A session
      // from before sign-ins were recorded was never reviewable.
      return row.review === review
        ? Result.ok(review)
        : Result.err(SESSION_SIGN_IN_REVIEW_REFUSAL.notUnderReview);
    }),

  /** Every live session of the account holder with its sign-in details. */
  list: async (userId: SafeId<"user">): Promise<SessionSignInSummary[]> =>
    await withAggregateTransaction(database, async (tx) => {
      const rows = await tx
        .select({
          id: session.id,
          signInSessionId: sessionSignIns.sessionId,
          locationKind: sessionSignIns.locationKind,
          countryCode: sessionSignIns.countryCode,
          region: sessionSignIns.region,
          city: sessionSignIns.city,
          latitude: sessionSignIns.latitude,
          longitude: sessionSignIns.longitude,
          review: sessionSignIns.review,
        })
        .from(session)
        .leftJoin(sessionSignIns, eq(sessionSignIns.sessionId, session.id))
        .where(and(eq(session.userId, userId), liveSessionPredicate(now())));
      return rows.map((row) =>
        row.signInSessionId === null ||
        row.locationKind === null ||
        row.review === null
          ? {
              id: row.id,
              location: { type: "unknown" } as const,
              review: SESSION_SIGN_IN_REVIEW.notRequired,
            }
          : {
              id: row.id,
              location: toLocation({
                locationKind: row.locationKind,
                countryCode: row.countryCode,
                region: row.region,
                city: row.city,
                latitude: row.latitude,
                longitude: row.longitude,
              }),
              review: row.review,
            },
      );
    }),

  /**
   * The place to draw for one of the account holder's own live sessions, or
   * null when that session is not theirs or its location has no coordinates.
   */
  mapPlace: async (scope: SessionSignInScope): Promise<MapPlace | null> =>
    await withAggregateTransaction(database, async (tx) => {
      const rows = await tx
        .select({
          countryCode: sessionSignIns.countryCode,
          latitude: sessionSignIns.latitude,
          longitude: sessionSignIns.longitude,
        })
        .from(session)
        .innerJoin(sessionSignIns, eq(sessionSignIns.sessionId, session.id))
        .where(ownLiveSession(scope, now()))
        .limit(1);
      const row = rows.at(0);
      const countryCode = row?.countryCode ?? null;
      const latitude = row?.latitude ?? null;
      const longitude = row?.longitude ?? null;
      if (countryCode === null || latitude === null || longitude === null) {
        return null;
      }
      return { countryCode, point: { latitude, longitude } };
    }),
});

export type SessionSignInStore = ReturnType<typeof createSessionSignInStore>;
