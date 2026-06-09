/**
 * Root-db helpers for the synthetic-monitoring session endpoint
 * (handlers/smoke). The route is unauthenticated (secret-guarded),
 * so there is no `ctx.scopedDb`; per /conventions-security all
 * `rootDb` access lives here as narrow helpers instead of being
 * imported by the handler.
 *
 * The smoke principal deliberately mirrors the production default
 * state for a fresh organization: owner role, no usage entitlement
 * row, no AI provider config. Synthetic checks must exercise what
 * real new users get, not a specially provisioned account.
 */

import { member, organization, session, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";

const SMOKE_USER = {
  id: "smoke-user-stella",
  name: "Synthetic Monitor",
  email: "smoke@stella.dev",
} as const;

const SMOKE_ORG = {
  id: "smoke-org-stella",
  name: "Synthetic Monitoring",
  slug: "synthetic-monitoring",
} as const;

const SMOKE_MEMBER_ID = "smoke-member-stella";

/** Short-lived on purpose: one session per smoke run. */
const SMOKE_SESSION_LIFETIME_MS = 15 * 60 * 1000;

export type SmokeSession = {
  cookieName: string;
  cookieValue: string;
  expiresAt: string;
};

const ensureSmokePrincipal = async (now: Date): Promise<void> => {
  const existingUser = await rootDb.query.user.findFirst({
    where: { id: { eq: SMOKE_USER.id } },
    columns: { id: true },
  });
  if (!existingUser) {
    await rootDb.insert(user).values({
      ...SMOKE_USER,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const existingOrg = await rootDb.query.organization.findFirst({
    where: { id: { eq: SMOKE_ORG.id } },
    columns: { id: true },
  });
  if (!existingOrg) {
    await rootDb.insert(organization).values({
      ...SMOKE_ORG,
      createdAt: now,
    });
  }

  const existingMember = await rootDb.query.member.findFirst({
    where: { id: { eq: SMOKE_MEMBER_ID } },
    columns: { id: true },
  });
  if (!existingMember) {
    await rootDb.insert(member).values({
      id: SMOKE_MEMBER_ID,
      organizationId: SMOKE_ORG.id,
      userId: SMOKE_USER.id,
      role: "owner",
      createdAt: now,
    });
  }
};

// Mirrors better-auth's createCookieGetter naming: `__Secure-` prefix
// whenever useSecureCookies is on (auth.ts sets it to !env.isDev).
const smokeCookieName = (): string => {
  if (env.isDev) {
    return `${env.BETTER_AUTH_COOKIE_PREFIX ?? "stella-dev"}.session_token`;
  }
  return "__Secure-better-auth.session_token";
};

export const mintSmokeSession = async (): Promise<SmokeSession> => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SMOKE_SESSION_LIFETIME_MS);

  await ensureSmokePrincipal(now);

  // No cleanup of prior rows: sessions expire after 15 minutes and
  // better-auth ignores expired rows, so one row per deploy is inert.
  const token = Bun.randomUUIDv7();
  // Full token in the id: a UUIDv7 prefix is timestamp-dominated, so
  // two mints in the same window would collide on the primary key.
  await rootDb.insert(session).values({
    id: `smoke-session-${token}`,
    token,
    userId: SMOKE_USER.id,
    activeOrganizationId: SMOKE_ORG.id,
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

  return {
    cookieName: smokeCookieName(),
    cookieValue: `${token}.${signature}`,
    expiresAt: expiresAt.toISOString(),
  };
};
