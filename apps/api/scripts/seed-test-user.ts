/**
 * Seed a test user with a valid session for local development.
 *
 * Creates:
 *  - A user (test@stella.dev)
 *  - An organization ("Test Firm")
 *  - A membership linking the two
 *  - A session with a known token
 *  - A Playwright storage-state JSON for browser automation
 *
 * Usage:
 *   bun apps/api/scripts/seed-test-user.ts
 *
 * Requires a full .env (same vars as the API server) since
 * it imports the shared env module.
 *
 * The script is idempotent: running it again refreshes the
 * session expiry without duplicating data.
 */

import { and, eq, inArray } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { member, organization, session, user } from "@/api/db/auth-schema";
import { db } from "@/api/db/root";
import { env } from "@/api/env";

import {
  ALL_TEST_USER_IDS,
  DEFAULT_ORG_ID,
  DEFAULT_TEST_USER_COLLEAGUE_COUNT,
  DEFAULT_USER_ID,
  getSeedColleagues,
} from "./seed-utils";

const TEST_USER = {
  id: DEFAULT_USER_ID,
  name: "Test User",
  email: "test@stella.dev",
} as const;

const COLLEAGUES = getSeedColleagues(DEFAULT_TEST_USER_COLLEAGUE_COUNT);

const TEST_ORG = {
  id: DEFAULT_ORG_ID,
  name: "Test Firm",
  slug: "test-firm",
} as const;

// Token that Playwright will send as a cookie.
const SESSION_TOKEN = "stella-test-session-token";

const SESSION_ID = "test-session-stella-dev";

// 30 days from now.
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const now = new Date();

const DEFAULT_MEMBER_ROLE = "member" as const;
const OWNER_MEMBER_ROLE = "owner" as const;

const getSeedOrganizationIdentity = (organizationId: string) => {
  if (organizationId === TEST_ORG.id) {
    return TEST_ORG;
  }

  return {
    id: organizationId,
    name: `Seed Organization ${organizationId.slice(0, 8)}`,
    slug: `seed-org-${organizationId.toLowerCase()}`,
  };
};

const buildMemberId = (organizationId: string, userId: string): string => {
  const hash = new Bun.CryptoHasher("sha256")
    .update(`${organizationId}:${userId}`)
    .digest("hex");
  return `seed-member-${hash.slice(0, 24)}`;
};

const ensureUserExists = async ({
  id,
  name,
  email,
  image,
}: {
  id: string;
  name: string;
  email: string;
  image?: string;
}) => {
  if (
    await db.query.user.findFirst({
      where: { id },
      columns: { id: true },
    })
  ) {
    return;
  }

  await db.insert(user).values({
    id,
    name,
    email,
    image,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
};

export const ensureOrganizationExists = async (organizationId: string) => {
  if (
    await db.query.organization.findFirst({
      where: { id: { eq: organizationId } },
      columns: { id: true },
    })
  ) {
    return;
  }

  const org = getSeedOrganizationIdentity(organizationId);

  await db.insert(organization).values({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: now,
  });
};

export const ensureMembershipExists = async ({
  organizationId,
  userId,
  role,
}: {
  organizationId: string;
  userId: string;
  role: typeof DEFAULT_MEMBER_ROLE | typeof OWNER_MEMBER_ROLE;
}) => {
  const existingMembership = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .limit(1);

  if (existingMembership.length > 0) {
    return;
  }

  await db.insert(member).values({
    id: buildMemberId(organizationId, userId),
    organizationId,
    userId,
    role,
    createdAt: now,
  });
};

export async function ensureSeedColleagueUsers({
  colleagueCount = DEFAULT_TEST_USER_COLLEAGUE_COUNT,
}: {
  colleagueCount?: number;
} = {}) {
  for (const colleague of getSeedColleagues(colleagueCount)) {
    await ensureUserExists(colleague);
  }
}

export async function ensureSeedColleaguesInOrganization({
  organizationId,
  colleagueCount = 3,
}: {
  organizationId: string;
  colleagueCount?: number;
}) {
  await ensureSeedColleagueUsers({ colleagueCount });

  for (const colleague of getSeedColleagues(colleagueCount)) {
    await ensureMembershipExists({
      organizationId,
      userId: colleague.id,
      role: DEFAULT_MEMBER_ROLE,
    });
  }
}

export async function ensurePrimarySeedUserInOrganization({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  await ensureOrganizationExists(organizationId);

  const existingUser = await db.query.user.findFirst({
    where: { id: { eq: userId } },
    columns: { id: true },
  });

  if (!existingUser) {
    throw new Error(
      `Primary seed user ${userId} does not exist; sign in first or run db:seed-test-user`,
    );
  }

  await ensureMembershipExists({
    organizationId,
    userId,
    role: OWNER_MEMBER_ROLE,
  });
}

/**
 * Ensure all test users and their memberships exist.
 *
 * Idempotent: uses findFirst to skip rows that already exist.
 * Called by `seed-dev.ts` so "Clean + Seed" from the dev menu
 * never hits FK violations on `entities.created_by`.
 */
export async function ensureTestUsers(organizationId: string = TEST_ORG.id) {
  await ensureUserExists(TEST_USER);
  await ensureOrganizationExists(organizationId);
  await ensureMembershipExists({
    organizationId,
    userId: TEST_USER.id,
    role: OWNER_MEMBER_ROLE,
  });
  await ensureSeedColleagueUsers();

  for (const colleague of COLLEAGUES) {
    await ensureMembershipExists({
      organizationId,
      userId: colleague.id,
      role: DEFAULT_MEMBER_ROLE,
    });
  }
}

async function seed() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run: NODE_ENV must not be 'production'.");
    process.exit(1);
  }

  const existingUsers = await db
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, ALL_TEST_USER_IDS));
  const existingUserIds = new Set(
    existingUsers.map((existingUser) => existingUser.id),
  );
  const orgExistedBeforeSeed = !!(await db.query.organization.findFirst({
    where: { id: { eq: TEST_ORG.id } },
    columns: { id: true },
  }));

  await ensureTestUsers();

  if (existingUserIds.has(TEST_USER.id)) {
    console.log("Test user already exists:", TEST_USER.email);
  } else {
    console.log("Created test user:", TEST_USER.email);
  }

  for (const colleague of COLLEAGUES) {
    if (existingUserIds.has(colleague.id)) {
      console.log("Colleague already exists:", colleague.email);
      continue;
    }

    console.log("Created colleague:", colleague.email);
  }

  if (orgExistedBeforeSeed) {
    console.log("Test organization already exists:", TEST_ORG.name);
  } else {
    console.log("Created test organization:", TEST_ORG.name);
  }

  console.log("Ensured memberships for test organization users");

  // --- session (always refresh expiry) ---
  const existingSession = await db.query.session.findFirst({
    where: { id: { eq: SESSION_ID } },
    columns: { id: true },
  });

  if (existingSession) {
    await db
      .update(session)
      .set({
        expiresAt,
        activeOrganizationId: TEST_ORG.id,
      })
      .where(eq(session.id, SESSION_ID));
    console.log("Refreshed test session expiry");
  } else {
    await db.insert(session).values({
      id: SESSION_ID,
      token: SESSION_TOKEN,
      userId: TEST_USER.id,
      activeOrganizationId: TEST_ORG.id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      ipAddress: "127.0.0.1",
      userAgent: "playwright-mcp/seed",
    });
    console.log("Created test session");
  }

  // --- Playwright storage-state ---
  // better-auth uses signed cookies: the cookie value is
  // "{token}.{hmac_base64}" where HMAC is SHA-256 with the
  // BETTER_AUTH_SECRET. We replicate this so getSignedCookie()
  // can verify and extract the token.
  const signature = new Bun.CryptoHasher("sha256", env.BETTER_AUTH_SECRET)
    .update(SESSION_TOKEN)
    .digest("base64");
  const signedCookieValue = `${SESSION_TOKEN}.${signature}`;

  const storageState = {
    cookies: [
      {
        name: "better-auth.session_token",
        value: signedCookieValue,
        domain: "localhost",
        path: "/",
        expires: Math.floor(expiresAt.getTime() / 1000),
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };

  const outDir = resolve(import.meta.dir, "../../../.playwright");
  mkdirSync(outDir, { recursive: true });

  const outPath = resolve(outDir, "storage-state.json");
  await Bun.write(outPath, JSON.stringify(storageState, null, 2));
  console.log("Wrote storage state to:", outPath);

  console.log("\nDone. Playwright MCP will auto-load the");
  console.log("session from .playwright/storage-state.json");

  process.exit(0);
}

if (import.meta.main) {
  seed().catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
