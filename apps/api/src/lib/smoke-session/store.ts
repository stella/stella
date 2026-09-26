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

import { member, organization, session, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { sessionCookieName } from "@/api/lib/auth-cookie-name";
import { logger } from "@/api/lib/observability/logger";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
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
    await rootDb.insert(organization).values({
      ...org,
      createdAt: now,
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

  // No cleanup of prior rows: sessions expire after 15 minutes and
  // better-auth ignores expired rows, so one row per deploy is inert.
  const token = Bun.randomUUIDv7();
  // Full token in the id: a UUIDv7 prefix is timestamp-dominated, so
  // two mints in the same window would collide on the primary key.
  await rootDb.insert(session).values({
    id: `smoke-session-${token}`,
    token,
    userId: record.user.id,
    activeOrganizationId: record.org.id,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    ipAddress: "synthetic-monitor",
    userAgent: "stella-smoke/deploy-verify",
  });

  // better-auth cookies are "{token}.{hmac_base64}" signed with
  // BETTER_AUTH_SECRET (same scheme as scripts/seed-test-user.ts).
  const signature = new Bun.CryptoHasher("sha256", env.BETTER_AUTH_SECRET)
    .update(token)
    .digest("base64");

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
    cookieValue: `${token}.${signature}`,
    expiresAt: expiresAt.toISOString(),
  };
};
