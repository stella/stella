import { panic } from "better-result";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { CLIENT_MATTER_ADMIN_ROLES } from "@stll/permissions";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  featureEnrolments,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  buildFeatureAccessSnapshot,
  resolveFeatureAccess,
} from "@/api/lib/auth/feature-access/context";
import type { SafeId } from "@/api/lib/branded-types";
import { readCursorPage } from "@/api/lib/db/read-bounded";
import { timestampCasToken } from "@/api/lib/db/timestamp-cas";
import type { TimestampCasToken } from "@/api/lib/db/timestamp-cas";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

type BackgroundFeatureAccessOptions = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  userId: string | null;
  featureId: "signals" | "flows";
};

/** Background actors use the same live membership and enrolment as requests. */
export const isBackgroundFeatureEnabled = async ({
  tx,
  organizationId,
  userId,
  featureId,
}: BackgroundFeatureAccessOptions): Promise<boolean> => {
  if (
    !isDeploymentFeatureEnabled(
      featureId === "signals" ? "FEATURE_SIGNALS" : "FEATURE_FLOWS",
    )
  ) {
    return false;
  }
  const decision = await resolveFeatureAccess({
    tx,
    organizationId,
    userId,
    featureId,
  });
  return decision.status === "enabled";
};

const SIGNAL_ACTOR_CANDIDATE_BATCH_SIZE = 32;

type FindSignalsBackgroundActorOptions = {
  tx: Pick<Transaction, "select">;
  organizationId: SafeId<"organization">;
  workspaceId?: SafeId<"workspace">;
};

/** A scout must represent an enrolled live member, never an arbitrary RLS actor. */
export const findSignalsBackgroundActor = async ({
  tx,
  organizationId,
  workspaceId,
}: FindSignalsBackgroundActorOptions): Promise<SafeId<"user"> | null> => {
  if (!isDeploymentFeatureEnabled("FEATURE_SIGNALS")) {
    return null;
  }
  const candidateMembers = alias(member, "signals_actor_candidates");
  let cursor: { id: string; createdAtToken: TimestampCasToken } | undefined;
  for (;;) {
    // db-await-in-loop: keyset-search every admitted candidate; one refused snapshot cannot hide later members.
    const page = await readCursorPage(
      tx
        .select({
          id: candidateMembers.id,
          createdAtToken: timestampCasToken(candidateMembers.createdAt),
          userId: candidateMembers.userId,
          email: user.email,
          emailVerified: user.emailVerified,
        })
        .from(candidateMembers)
        .innerJoin(
          user,
          and(
            eq(user.id, candidateMembers.userId),
            eq(user.emailVerified, true),
            isNull(user.deletedAt),
          ),
        )
        .innerJoin(
          featureEnrolments,
          and(
            eq(
              featureEnrolments.organizationId,
              candidateMembers.organizationId,
            ),
            eq(featureEnrolments.userId, candidateMembers.userId),
            eq(featureEnrolments.featureId, "signals"),
          ),
        )
        .where(
          and(
            eq(candidateMembers.organizationId, organizationId),
            cursor === undefined
              ? undefined
              : sql`(${candidateMembers.createdAt}, ${candidateMembers.id}) > (${cursor.createdAtToken}::timestamptz, ${cursor.id})`,
            workspaceId === undefined
              ? undefined
              : backgroundFeatureActorExists({
                  organizationId,
                  workspaceId,
                  featureId: "signals",
                  userId: candidateMembers.userId,
                }),
          ),
        )
        .orderBy(asc(candidateMembers.createdAt), asc(candidateMembers.id)),
      {
        limit: SIGNAL_ACTOR_CANDIDATE_BATCH_SIZE,
        cursorForItem: (candidate) => candidate.id,
      },
    );
    for (const candidate of page.items) {
      const snapshot = buildFeatureAccessSnapshot({
        organizationId,
        userId: candidate.userId,
        identity: {
          email: candidate.email,
          emailVerified: candidate.emailVerified,
        },
        enrolments: [
          { organizationId, userId: candidate.userId, featureId: "signals" },
        ],
      });
      if (snapshot.decisions.get("signals")?.status === "enabled") {
        return brandPersistedUserId(candidate.userId);
      }
    }
    if (page.nextCursor === null) {
      return null;
    }
    const last =
      page.items.at(-1) ??
      panic("Signal actor continuation requires a candidate");
    cursor = { id: last.id, createdAtToken: last.createdAtToken };
  }
};

type BackgroundFeaturePrincipal = {
  organizationId: SafeId<"organization">;
  userId: string;
};

type LoadBackgroundFeatureActorsOptions = {
  tx: Pick<Transaction, "select">;
  featureId: "signals" | "flows";
  principals: readonly BackgroundFeaturePrincipal[];
};

/** A bounded recovery page resolves all actors in one tenant-scoped read. */
export const loadBackgroundFeatureActors = async ({
  tx,
  featureId,
  principals,
}: LoadBackgroundFeatureActorsOptions): Promise<
  Map<SafeId<"organization">, Set<string>>
> => {
  const admitted = new Map<SafeId<"organization">, Set<string>>();
  if (
    principals.length === 0 ||
    !isDeploymentFeatureEnabled(
      featureId === "signals" ? "FEATURE_SIGNALS" : "FEATURE_FLOWS",
    )
  ) {
    return admitted;
  }
  const rows = await tx
    .select({
      organizationId: featureEnrolments.organizationId,
      userId: featureEnrolments.userId,
      featureId: featureEnrolments.featureId,
      email: user.email,
      emailVerified: user.emailVerified,
    })
    .from(featureEnrolments)
    .innerJoin(
      member,
      and(
        eq(member.organizationId, featureEnrolments.organizationId),
        eq(member.userId, featureEnrolments.userId),
      ),
    )
    .innerJoin(user, and(eq(user.id, member.userId), isNull(user.deletedAt)))
    .where(
      and(
        eq(featureEnrolments.featureId, featureId),
        or(
          ...principals.map((principal) =>
            and(
              eq(featureEnrolments.organizationId, principal.organizationId),
              eq(featureEnrolments.userId, principal.userId),
            ),
          ),
        ),
      ),
    )
    .limit(principals.length);
  for (const row of rows) {
    const snapshot = buildFeatureAccessSnapshot({
      organizationId: row.organizationId,
      userId: row.userId,
      identity: { email: row.email, emailVerified: row.emailVerified },
      enrolments: [row],
    });
    if (snapshot.decisions.get(featureId)?.status !== "enabled") {
      continue;
    }
    const users = admitted.get(row.organizationId);
    if (users) {
      users.add(row.userId);
    } else {
      admitted.set(row.organizationId, new Set([row.userId]));
    }
  }
  return admitted;
};

type BackgroundFeatureMemberExistsOptions = {
  organizationId: SQLWrapper | string;
  userId: SQLWrapper | string;
  featureId: "signals" | "flows";
};

/** SQL admission for org-only automation owners, matching live self-serve policy. */
export const backgroundFeatureMemberExists = ({
  organizationId,
  userId,
  featureId,
}: BackgroundFeatureMemberExistsOptions) => sql`EXISTS (
  SELECT 1 FROM ${member}
  JOIN ${user} ON ${user.id} = ${member.userId}
  JOIN ${featureEnrolments}
    ON ${featureEnrolments.organizationId} = ${member.organizationId}
    AND ${featureEnrolments.userId} = ${member.userId}
    AND ${featureEnrolments.featureId} = ${featureId}
  WHERE ${member.organizationId} = ${organizationId}
    AND ${member.userId} = ${userId}
    AND ${user.emailVerified} = true
    AND ${user.deletedAt} IS NULL
)`;

type BackgroundFeatureActorExistsOptions = {
  organizationId: SQLWrapper | string;
  workspaceId: SQLWrapper | string;
  featureId: "signals" | "flows";
  userId?: SQLWrapper | string;
};

/** Correlated admission keeps an ungranted prefix out of bounded recovery pages. */
export const backgroundFeatureActorExists = ({
  organizationId,
  workspaceId,
  featureId,
  userId,
}: BackgroundFeatureActorExistsOptions) => sql`EXISTS (
    SELECT 1 FROM ${member}
    JOIN ${user} ON ${user.id} = ${member.userId}
    JOIN ${featureEnrolments}
      ON ${featureEnrolments.organizationId} = ${member.organizationId}
      AND ${featureEnrolments.userId} = ${member.userId}
      AND ${featureEnrolments.featureId} = ${featureId}
    JOIN ${workspaces}
      ON ${workspaces.id} = ${workspaceId}
      AND ${workspaces.organizationId} = ${member.organizationId}
    LEFT JOIN ${workspaceMembers}
      ON ${workspaceMembers.workspaceId} = ${workspaces.id}
      AND ${workspaceMembers.userId} = ${member.userId}
    WHERE ${member.organizationId} = ${organizationId}
      AND ${user.emailVerified} = true
      AND ${user.deletedAt} IS NULL
      AND ${userId === undefined ? sql`true` : sql`${member.userId} = ${userId}`}
      AND (
        ${workspaceMembers.userId} IS NOT NULL
        OR (
          ${workspaces.clientId} IS NOT NULL
          AND ${member.role} IN (${sql.join(
            CLIENT_MATTER_ADMIN_ROLES.map((role) => sql`${role}`),
            sql`, `,
          )})
        )
      )
  )`;
