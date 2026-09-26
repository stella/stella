/**
 * Seed a test user with a valid session for local development.
 *
 * Creates:
 *  - A user (test@stella.dev)
 *  - An organization ("Harbrook & Partners")
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

import { panic } from "better-result";
import { and, eq, inArray, or } from "drizzle-orm";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { member, organization, session, user } from "@/api/db/auth-schema";
import { env } from "@/api/env";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { sessionCookieName } from "@/api/lib/auth-cookie-name";
import { toSafeId } from "@/api/lib/branded-types";
import { assertConfiguredBetterAuthOAuthPolicy } from "@/api/lib/db/assert-better-auth-oauth-policy";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { ensureDefaultDocumentTypes } from "@/api/lib/document-types/defaults";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import {
  ALL_TEST_USER_IDS,
  DEFAULT_ORG_ID,
  DEFAULT_TEST_USER_COLLEAGUE_COUNT,
  DEFAULT_USER_ID,
  getSeedColleagues,
} from "./seed-utils";

const db = openMaintenanceDb({ readOnly: false });

// Display names belong to the same fictional world as the rest of the dev
// seed (Novák & Partners, Česká Energie, Meridian Capital Partners in
// seed-dev.ts): the marketing captures film these surfaces, so a placeholder
// like "Test User"/"Test Firm" would ship in the recordings. `id` and `email`
// stay as they are — they are the stable keys the seeds, the Playwright
// storage state, and the e2e sign-in all join on.
const TEST_USER = {
  id: DEFAULT_USER_ID,
  name: "Petra Harbrook",
  email: "test@stella.dev",
} as const;

const COLLEAGUES = getSeedColleagues(DEFAULT_TEST_USER_COLLEAGUE_COUNT);

const TEST_ORG = {
  id: DEFAULT_ORG_ID,
  name: "Harbrook & Partners",
  slug: "harbrook-partners",
} as const;

// Token that Playwright will send as a cookie.
const SESSION_TOKEN = "stella-test-session-token";

const SESSION_ID = "test-session-stella-dev";

// 30 days from now.
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const now = new Date();

const DEFAULT_MEMBER_ROLE = "member" as const;
const OWNER_MEMBER_ROLE = "owner" as const;

const AUTH_COOKIE_NAME = sessionCookieName();

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

// Better Auth may create the local test email before this seed runs, using its
// own generated user id. Resolve by either unique identity so the seed
// converges on that row instead of colliding on the email constraint.
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
}) =>
  db.transaction(async (transaction) => {
    await transaction
      .insert(user)
      .values({
        id,
        name,
        email,
        image,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const matches = await transaction
      .select({ id: user.id })
      .from(user)
      .where(or(eq(user.id, id), eq(user.email, email)))
      .limit(2);
    const match = matches.at(0);
    if (!match || matches.length !== 1) {
      return panic(
        `Seed user identity is ambiguous for id ${id} and email ${email}`,
      );
    }
    const resolvedId = match.id;

    // Reconcile every seed-owned display/login field in place. The unique
    // lookup above proves no second row owns the target email.
    await transaction
      .update(user)
      .set({ email, emailVerified: true, image, name, updatedAt: now })
      .where(eq(user.id, resolvedId));

    return resolvedId;
  });

export const ensureOrganizationExists = async (organizationId: string) => {
  const org = getSeedOrganizationIdentity(organizationId);

  if (
    await db.transaction(
      async (tx) =>
        await tx.query.organization.findFirst({
          where: { id: { eq: organizationId } },
          columns: { id: true },
        }),
    )
  ) {
    // Reconcile the display name in place so a re-seed renames an existing
    // row (see ensureUserExists). Scoped to the seed's own deterministic org:
    // an operator-supplied STELLA_SEED_ORG_ID points at a real organization
    // whose name and slug are not this script's to rewrite.
    if (organizationId === TEST_ORG.id) {
      await db.transaction(
        async (tx) =>
          await tx
            .update(organization)
            .set({ name: org.name, slug: org.slug })
            .where(eq(organization.id, organizationId)),
      );
    }
    return;
  }

  await db.transaction(
    async (tx) =>
      await tx.insert(organization).values({
        id: org.id,
        name: org.name,
        slug: org.slug,
        createdAt: now,
      }),
  );

  // Listing document types is a pure read, and this seed inserts the org
  // directly (bypassing the `afterCreateOrganization` hook that seeds it in
  // production), so seed the starter taxonomy here for parity. Idempotent via
  // the (organization_id, key) unique.
  await db.transaction(
    async (tx) =>
      await ensureDefaultDocumentTypes(toSafeId<"organization">(org.id), tx),
  );
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
  const existingMembership = await db.transaction(
    async (tx) =>
      await tx
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, userId),
          ),
        )
        .limit(1),
  );

  if (existingMembership.length > 0) {
    return;
  }

  // This seed inserts the membership directly, bypassing the organization
  // plugin's membership hooks, so it installs the member defaults itself.
  await db.transaction(async (tx) => {
    await tx.insert(member).values({
      id: buildMemberId(organizationId, userId),
      organizationId,
      userId,
      role,
      createdAt: now,
    });
    await seedDefaultSkills({
      organizationId: toSafeId<"organization">(organizationId),
      tx,
      userId: toSafeId<"user">(userId),
    });
  });
};

export async function ensureSeedColleagueUsers({
  colleagueCount = DEFAULT_TEST_USER_COLLEAGUE_COUNT,
}: {
  colleagueCount?: number;
} = {}) {
  const userIds: string[] = [];
  for (const colleague of getSeedColleagues(colleagueCount)) {
    userIds.push(await ensureUserExists(colleague));
  }
  return userIds;
}

export async function ensureSeedColleaguesInOrganization({
  organizationId,
  colleagueCount = 3,
}: {
  organizationId: string;
  colleagueCount?: number;
}) {
  const userIds = await ensureSeedColleagueUsers({ colleagueCount });

  for (const userId of userIds) {
    await ensureMembershipExists({
      organizationId,
      userId,
      role: DEFAULT_MEMBER_ROLE,
    });
  }

  return userIds;
}

export async function ensurePrimarySeedUserInOrganization({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  await ensureOrganizationExists(organizationId);

  const existingUser = await db.transaction(
    async (tx) =>
      await tx.query.user.findFirst({
        where: { id: { eq: userId } },
        columns: { id: true },
      }),
  );

  if (!existingUser) {
    panic(
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
  // Test fixtures must establish the same OAuth resource policy as API
  // startup before creating the first identity. This keeps fresh E2E databases
  // valid without weakening the fail-closed census for existing databases.
  await assertConfiguredBetterAuthOAuthPolicy();

  const testUserId = await ensureUserExists(TEST_USER);
  await ensureOrganizationExists(organizationId);
  await ensureMembershipExists({
    organizationId,
    userId: testUserId,
    role: OWNER_MEMBER_ROLE,
  });
  const colleagueUserIds = await ensureSeedColleagueUsers();

  for (const userId of colleagueUserIds) {
    await ensureMembershipExists({
      organizationId,
      userId,
      role: DEFAULT_MEMBER_ROLE,
    });
  }

  return { colleagueUserIds, testUserId };
}

async function seed() {
  requireLocalDevOpen("Seeding");

  const existingUsers = await db.transaction(
    async (tx) =>
      await tx
        .select({ email: user.email, id: user.id })
        .from(user)
        .where(
          or(
            inArray(user.id, ALL_TEST_USER_IDS),
            inArray(
              user.email,
              [TEST_USER, ...COLLEAGUES].map(({ email }) => email),
            ),
          ),
        ),
  );
  const existingUserIds = new Set(
    existingUsers.map((existingUser) => existingUser.id),
  );
  const existingUserEmails = new Set(
    existingUsers.map((existingUser) => existingUser.email),
  );
  const orgExistedBeforeSeed = !!(await db.transaction(
    async (tx) =>
      await tx.query.organization.findFirst({
        where: { id: { eq: TEST_ORG.id } },
        columns: { id: true },
      }),
  ));

  const { testUserId } = await ensureTestUsers();

  if (
    existingUserIds.has(TEST_USER.id) ||
    existingUserEmails.has(TEST_USER.email)
  ) {
    console.log("Test user already exists:", TEST_USER.email);
  } else {
    console.log("Created test user:", TEST_USER.email);
  }

  for (const colleague of COLLEAGUES) {
    if (
      existingUserIds.has(colleague.id) ||
      existingUserEmails.has(colleague.email)
    ) {
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
  const existingSession = await db.transaction(
    async (tx) =>
      await tx.query.session.findFirst({
        where: { id: { eq: SESSION_ID } },
        columns: { id: true },
      }),
  );

  if (existingSession) {
    // createdAt must be refreshed along with expiresAt: better-auth gates
    // sensitive endpoints (e.g. /list-sessions) on session *freshness*, which
    // is derived from createdAt. On a long-lived dev database an old row would
    // 403 those endpoints even though the session is otherwise valid.
    await db.transaction(
      async (tx) =>
        await tx
          .update(session)
          .set({
            expiresAt,
            createdAt: now,
            updatedAt: now,
            activeOrganizationId: TEST_ORG.id,
            userId: testUserId,
          })
          .where(eq(session.id, SESSION_ID)),
    );
    console.log("Refreshed test session expiry");
  } else {
    await db.transaction(
      async (tx) =>
        await tx.insert(session).values({
          id: SESSION_ID,
          token: SESSION_TOKEN,
          userId: testUserId,
          activeOrganizationId: TEST_ORG.id,
          expiresAt,
          createdAt: now,
          updatedAt: now,
          ipAddress: "127.0.0.1",
          userAgent: "playwright-mcp/seed",
        }),
    );
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
        name: AUTH_COOKIE_NAME,
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

  const outDir = path.resolve(import.meta.dir, "../../../.playwright");
  mkdirSync(outDir, { recursive: true });

  const outPath = path.resolve(outDir, "storage-state.json");
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
