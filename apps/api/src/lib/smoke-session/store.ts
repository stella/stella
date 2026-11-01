/**
 * Root-db helpers for the synthetic-monitoring session endpoint
 * (handlers/smoke). The route is unauthenticated (secret-guarded),
 * so there is no `ctx.scopedDb`; per /conventions-security all
 * `rootDb` access lives here as narrow helpers instead of being
 * imported by the handler.
 *
 * The default smoke principal deliberately mirrors the production
 * default state for a fresh organization: owner role, no usage
 * entitlement row, no AI provider config. Synthetic checks must
 * exercise what real new users get, not a specially provisioned account.
 *
 * The `ai` principal is a second, equally plain organization. Nothing
 * here configures its AI: the smoke caller sets that up through the
 * organization settings API, exactly as a real owner would.
 */

import { panic } from "better-result";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { member, organization, session, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { env } from "@/api/env";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { sessionCookieName } from "@/api/lib/auth/auth-cookie-name";
import { acceptProfessionalUse } from "@/api/lib/auth/professional-use";
import { createSignedSessionCookieValue } from "@/api/lib/auth/signed-session-cookie";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import { logger } from "@/api/lib/observability/logger";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import type { DECLARED_SCHEDULER_JOBS } from "@/api/lib/scheduler/jobs";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { runtimeMode } from "@/api/runtime-mode";

const SMOKE_PRINCIPAL = {
  default: "default",
  ai: "ai",
} as const;

type SmokePrincipal = (typeof SMOKE_PRINCIPAL)[keyof typeof SMOKE_PRINCIPAL];

type SmokePrincipalRecord = {
  memberId: string;
  org: { id: string; name: string; slug: string };
  user: { email: string; id: string; name: string };
};

const SMOKE_PRINCIPALS = {
  default: {
    user: {
      id: "smoke-user-stella",
      name: "Synthetic Monitor",
      email: "smoke@stella.dev",
    },
    org: {
      id: "smoke-org-stella",
      name: "Synthetic Monitoring",
      slug: "synthetic-monitoring",
    },
    memberId: "smoke-member-stella",
  },
  ai: {
    user: {
      id: "smoke-ai-user-stella",
      name: "Synthetic Monitor (AI)",
      email: "smoke-ai@stella.dev",
    },
    org: {
      id: "smoke-ai-org-stella",
      name: "Synthetic Monitoring (AI)",
      slug: "synthetic-monitoring-ai",
    },
    memberId: "smoke-ai-member-stella",
  },
} as const satisfies Record<SmokePrincipal, SmokePrincipalRecord>;

export const parseSmokePrincipal = (
  value: string | null,
): SmokePrincipal | null => {
  if (value === null || value === SMOKE_PRINCIPAL.default) {
    return SMOKE_PRINCIPAL.default;
  }
  return value === SMOKE_PRINCIPAL.ai ? SMOKE_PRINCIPAL.ai : null;
};

/** Short-lived on purpose: one session per smoke run. */
const SMOKE_SESSION_LIFETIME_MS = 15 * 60 * 1000;

export type SmokeSession = {
  cookieName: string;
  cookieValue: string;
  expiresAt: string;
};

const ensureSmokePrincipal = async (
  { memberId, org, user: smokeUser }: SmokePrincipalRecord,
  now: Date,
): Promise<void> => {
  const existingUser = await rootDb.query.user.findFirst({
    where: { id: { eq: smokeUser.id } },
    columns: { id: true },
  });
  if (!existingUser) {
    await rootDb.insert(user).values({
      ...smokeUser,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const existingOrg = await rootDb.query.organization.findFirst({
    where: { id: { eq: org.id } },
    columns: { id: true },
  });
  if (!existingOrg) {
    // A direct insert skips the organization plugin's creation hook, so the
    // access state a real new organization gets is recorded here.
    await rootDb.transaction(async (tx) => {
      await tx.insert(organization).values({
        ...org,
        createdAt: now,
      });
      await recordNewOrganizationAccessState(tx, {
        organizationId: brandPersistedOrganizationId(org.id),
        now,
      });
    });
  }

  const existingMember = await rootDb.query.member.findFirst({
    where: { id: { eq: memberId } },
    columns: { id: true },
  });
  if (!existingMember) {
    // A direct insert skips the organization plugin's membership hooks, so
    // the member defaults a real new owner gets are installed here.
    await rootDb.transaction(async (tx) => {
      await tx.insert(member).values({
        id: memberId,
        organizationId: org.id,
        userId: smokeUser.id,
        role: "owner",
        createdAt: now,
      });
      await seedDefaultSkills({
        organizationId: brandPersistedOrganizationId(org.id),
        tx,
        userId: brandPersistedUserId(smokeUser.id),
      });
    });
  }
};

const smokeCookieName = sessionCookieName;

export const mintSmokeSession = async (
  principal: SmokePrincipal,
): Promise<SmokeSession> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SMOKE_SESSION_LIFETIME_MS);
  const record = SMOKE_PRINCIPALS[principal];

  await ensureSmokePrincipal(record, now);
  // A real new account has accepted the professional-use statement before it
  // works in the product. The synthetic principal accepts as its operator on
  // every mint, so a principal created before acceptances existed converges.
  await withAggregateTransaction(rootDb, async (tx) => {
    await acceptProfessionalUse({
      tx,
      userId: brandPersistedUserId(record.user.id),
    });
  });

  // No cleanup of prior rows: sessions expire after 15 minutes and
  // better-auth ignores expired rows, so one row per deploy is inert.
  const token = Bun.randomUUIDv7();
  // Full token in the id: a UUIDv7 prefix is timestamp-dominated, so
  // two mints in the same window would collide on the primary key.
  await rootDb.insert(session).values({
    id: `smoke-session-${token}`,
    token,
    refreshMode: "fixed",
    userId: record.user.id,
    activeOrganizationId: record.org.id,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    ipAddress: "synthetic-monitor",
    userAgent: "stella-smoke/deploy-verify",
  });

  // Emit an alertable signal on every mint. This endpoint issues a real
  // owner session (scoped to the fixed synthetic org, never a real tenant),
  // guarded only by SMOKE_SESSION_SECRET; a structured event lets an operator
  // detect a mint firing in an environment where synthetic monitoring is not
  // expected — the belt-and-suspenders the secret gate alone cannot provide.
  logger.warn("smoke.session_minted", {
    "smoke.org_id": record.org.id,
    "smoke.runtime_mode": runtimeMode().mode,
    "smoke.session_expires_at": expiresAt.toISOString(),
  });

  return {
    cookieName: smokeCookieName(),
    cookieValue: createSignedSessionCookieValue(token, env.BETTER_AUTH_SECRET),
    expiresAt: expiresAt.toISOString(),
  };
};

type DeclaredSchedulerJobId = (typeof DECLARED_SCHEDULER_JOBS)[number]["id"];

/**
 * The recurring jobs that read the public corpus. The staging release proof
 * brings them forward and runs its MCP load while they run, because a heavy
 * job and user traffic only interfere when they overlap.
 */
const RELEASE_LOAD_JOB_IDS = [
  "caseLaw.reportFreshness.fiveMinute",
  "caseLaw.refreshSitemapShards.hourly",
  "caseLaw.refreshBrowseFacets.hourly",
  "caseLaw.refreshSourceArrivals.threeHourly",
  "legislation.refreshSitemapShards.hourly",
  "legislation.refreshFacetCounts.hourly",
] as const satisfies readonly DeclaredSchedulerJobId[];

const releaseLoadJobColumns = {
  id: schedulerJobs.id,
  lastRunAt: schedulerJobs.lastRunAt,
  lockedAt: schedulerJobs.lockedAt,
  nextRunAt: schedulerJobs.nextRunAt,
};

const releaseLoadJobListed = inArray(schedulerJobs.id, RELEASE_LOAD_JOB_IDS);

/**
 * The recurring runs within this window are a handful per job (the listed
 * jobs run hourly at most, plus one brought forward), so the cap only guards
 * against a misconfigured schedule.
 */

const RELEASE_LOAD_RUN_CAP = 20 * RELEASE_LOAD_JOB_IDS.length;

/**
 * The scheduler's own records of the release-load jobs' runs that started in
 * the last half hour: when each started and, once it has, finished.
 */
export const readReleaseLoadJobRuns = async () => {
  const read = await readBounded(
    rootDb
      .select({
        jobId: schedulerJobRuns.jobId,
        status: schedulerJobRuns.status,
        startedAt: schedulerJobRuns.startedAt,
        finishedAt: schedulerJobRuns.finishedAt,
      })
      .from(schedulerJobRuns)
      .where(
        and(
          inArray(schedulerJobRuns.jobId, RELEASE_LOAD_JOB_IDS),
          // The cutoff is the database's own clock, at the column's precision.
          sql`${schedulerJobRuns.startedAt} >= now() - interval '30 minutes'`,
        ),
      )
      .orderBy(schedulerJobRuns.startedAt, schedulerJobRuns.jobId),
    RELEASE_LOAD_RUN_CAP,
  );
  return read.type === "complete"
    ? read.rows
    : panic("More release-load job runs than their schedules allow", {
        cap: read.cap,
      });
};

/**
 * Makes every enabled, unpaused release-load job due now; the next scheduler
 * sweep on any replica claims them through its usual lease. A job already
 * running keeps its lease, and its finish sets its next slot as usual.
 */
export const bringReleaseLoadJobsForward = async () =>
  // audit: skip — scheduler system state on the staging deployment; the smoke route logs the ids it moved.
  await rootDb
    .update(schedulerJobs)
    .set({ nextRunAt: sql`now()` })
    .where(
      and(
        releaseLoadJobListed,
        eq(schedulerJobs.enabled, true),
        or(
          isNull(schedulerJobs.pausedUntil),
          lte(schedulerJobs.pausedUntil, sql`now()`),
        ),
      ),
    )
    .returning(releaseLoadJobColumns);
