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
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { JOURNEY_PREREQUISITE_STATE } from "@stll/api-contract/journey-prerequisites";
import type {
  JourneyPrerequisiteId,
  JourneyPrerequisiteReport,
} from "@stll/api-contract/journey-prerequisites";

import { member, session, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { schedulerJobRuns, schedulerJobs } from "@/api/db/schema";
import { env } from "@/api/env";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { sessionCookieName } from "@/api/lib/auth/auth-cookie-name";
import { acceptProfessionalUse } from "@/api/lib/auth/professional-use";
import { createSignedSessionCookieValue } from "@/api/lib/auth/signed-session-cookie";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { insertOrganizationWithEvaluation } from "@/api/lib/db/organization-creation";
import { readBounded } from "@/api/lib/db/read-bounded";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { sanctionsPublicReadDb } from "@/api/lib/lists/sanctions/public-read-owner";
import { logger } from "@/api/lib/observability/logger";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import {
  JOURNEY_PREREQUISITES,
  judgePrerequisiteRun,
  unavailableSanctionsSources,
} from "@/api/lib/smoke-session/journey-prerequisites";
import type {
  DeclaredSchedulerJobId,
  JourneyPrerequisiteCheck,
} from "@/api/lib/smoke-session/journey-prerequisites";
import {
  newOrganizationEvaluation,
  recordNewOrganizationAccessState,
} from "@/api/lib/usage/organization-access-state";
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
    // evaluation grant, account audit and access state a real new
    // organization gets are recorded here.
    const organizationId = brandPersistedOrganizationId(org.id);
    await withAggregateTransaction(rootDb, async (tx) => {
      const created = await insertOrganizationWithEvaluation(tx, {
        userId: brandPersistedUserId(smokeUser.id),
        evaluation: newOrganizationEvaluation(),
        organization: { ...org, id: organizationId, createdAt: now },
      });
      if (created.isErr()) {
        abortTransaction(created.error);
      }
      await recordNewOrganizationAccessState(tx, { organizationId, now });
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

/**
 * The recurring jobs that read the public corpus. The staging release proof
 * brings them forward and runs its MCP load while they run, because a heavy
 * job and user traffic only interfere when they overlap.
 */
const RELEASE_LOAD_JOB_IDS = [
  "caseLaw.reportFreshness.fiveMinute",
  "caseLaw.refreshSitemapShards.hourly",
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
 * Moves the listed jobs' next run to `dueAt` when they are enabled and not
 * paused; the next scheduler sweep on any replica claims them through its
 * usual lease. A job already running keeps its lease, and its finish sets its
 * next slot as usual. The smoke routes' only write to the scheduler.
 */
const bringScheduledJobsForward = async (
  jobIds: readonly DeclaredSchedulerJobId[],
  dueAt: SQL,
) =>
  // audit: skip — scheduler system state on the staging deployment; the smoke route logs the ids it moved.
  await rootDb
    .update(schedulerJobs)
    .set({ nextRunAt: dueAt })
    .where(
      and(
        inArray(schedulerJobs.id, jobIds),
        eq(schedulerJobs.enabled, true),
        or(
          isNull(schedulerJobs.pausedUntil),
          lte(schedulerJobs.pausedUntil, sql`now()`),
        ),
      ),
    )
    .returning(releaseLoadJobColumns);

/** Makes every enabled, unpaused release-load job due now. */
export const bringReleaseLoadJobsForward = async () =>
  await bringScheduledJobsForward(RELEASE_LOAD_JOB_IDS, sql`now()`);

const journeyPrerequisiteJobIds = (journey: JourneyPrerequisiteId) =>
  JOURNEY_PREREQUISITES[journey].map(({ jobId }) => jobId);

/**
 * Makes a journey's prerequisite jobs due ahead of every other due job. After
 * staging was off, every recurring job is overdue and the runner claims the
 * oldest first, one at a time per replica, so a slot at "now" would queue the
 * journey's jobs behind all of them.
 */
export const bringJourneyPrerequisitesForward = async (
  journey: JourneyPrerequisiteId,
) =>
  await bringScheduledJobsForward(
    journeyPrerequisiteJobIds(journey),
    sql`least(now(), (select min(${schedulerJobs.nextRunAt}) from ${schedulerJobs}) - interval '1 millisecond')`,
  );

const prerequisiteCheckFailures = async (
  check: JourneyPrerequisiteCheck,
): Promise<string[]> => {
  switch (check.type) {
    case "sanctions-sources-available":
      // The lists as public screening sees them, through its read-only role.
      return unavailableSanctionsSources(
        await readSanctionsFreshness({ db: sanctionsPublicReadDb }),
        check.sources,
      );
    default:
      check.type satisfies never;
      return panic("Unhandled journey prerequisite check");
  }
};

/** The latest run still running or finished at or after `since`. */
const readLatestPrerequisiteRun = async (
  jobId: DeclaredSchedulerJobId,
  since: Date,
) => {
  const [run] = await rootDb
    .select({
      status: schedulerJobRuns.status,
      startedAt: schedulerJobRuns.startedAt,
      finishedAt: schedulerJobRuns.finishedAt,
      error: schedulerJobRuns.error,
    })
    .from(schedulerJobRuns)
    .where(
      and(
        eq(schedulerJobRuns.jobId, jobId),
        or(
          isNull(schedulerJobRuns.finishedAt),
          // The caller's instant, at millisecond precision, as a timestamptz.
          sql`${schedulerJobRuns.finishedAt} >= ${since.toISOString()}::timestamptz`,
        ),
      ),
    )
    .orderBy(desc(schedulerJobRuns.startedAt))
    .limit(1);
  return run ?? null;
};

/**
 * Each prerequisite of the journey judged from its scheduler row and its
 * latest run since `since`, the instant the journey brought it forward; a
 * successful run is then held to the journey's check.
 */
export const readJourneyPrerequisites = async (
  journey: JourneyPrerequisiteId,
  since: Date,
): Promise<JourneyPrerequisiteReport[]> => {
  const prerequisites = JOURNEY_PREREQUISITES[journey];
  const read = await readBounded(
    rootDb
      .select({
        id: schedulerJobs.id,
        enabled: schedulerJobs.enabled,
        lockedAt: schedulerJobs.lockedAt,
        nextRunAt: schedulerJobs.nextRunAt,
        pausedUntil: schedulerJobs.pausedUntil,
      })
      .from(schedulerJobs)
      .where(inArray(schedulerJobs.id, journeyPrerequisiteJobIds(journey))),
    prerequisites.length,
  );
  const jobs =
    read.type === "complete"
      ? read.rows
      : panic("More prerequisite jobs than the journey declares", {
          cap: read.cap,
        });
  const now = new Date();
  return await Promise.all(
    prerequisites.map(
      async ({ jobId, check }): Promise<JourneyPrerequisiteReport> => {
        const verdict = judgePrerequisiteRun({
          jobId,
          job: jobs.find(({ id }) => id === jobId) ?? null,
          run: await readLatestPrerequisiteRun(jobId, since),
          now,
        });
        if (verdict.state !== "check") {
          return verdict;
        }
        const failures = await prerequisiteCheckFailures(check);
        return failures.length === 0
          ? { jobId, state: JOURNEY_PREREQUISITE_STATE.ready }
          : {
              jobId,
              state: JOURNEY_PREREQUISITE_STATE.failed,
              detail: `${jobId} ran, but ${failures.join("; ")}`,
            };
      },
    ),
  );
};
