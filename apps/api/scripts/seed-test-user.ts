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

import "dotenv/config";
import { eq } from "drizzle-orm";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { db } from "@/api/db";
import { member, organization, session, user } from "@/api/db/auth-schema";
import { env } from "@/api/env";

const TEST_USER = {
  id: "test-user-stella-dev",
  name: "Test User",
  email: "test@stella.dev",
} as const;

const COLLEAGUES = [
  {
    id: "test-user-alice-johnson",
    memberId: "test-member-alice-johnson",
    name: "Alice Johnson",
    email: "alice@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=alice&backgroundColor=b6e3f4",
  },
  {
    id: "test-user-bob-martinez",
    memberId: "test-member-bob-martinez",
    name: "Bob Martinez",
    email: "bob@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=bob&backgroundColor=d1d4f9",
  },
  {
    id: "test-user-clara-novak",
    memberId: "test-member-clara-novak",
    name: "Clara Novak",
    email: "clara@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=clara&backgroundColor=ffd5dc",
  },
  {
    id: "test-user-david-kim",
    memberId: "test-member-david-kim",
    name: "David Kim",
    email: "david@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=david&backgroundColor=c0aede",
  },
  {
    id: "test-user-eva-schmidt",
    memberId: "test-member-eva-schmidt",
    name: "Eva Schmidt",
    email: "eva@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=eva&backgroundColor=b6e3f4",
  },
  {
    id: "test-user-frank-horvat",
    memberId: "test-member-frank-horvat",
    name: "Frank Horvát",
    email: "frank@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=frank&backgroundColor=d1d4f9",
  },
  {
    id: "test-user-greta-jones",
    memberId: "test-member-greta-jones",
    name: "Greta Jones",
    email: "greta@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=greta&backgroundColor=ffd5dc",
  },
] as const;

const TEST_ORG = {
  id: "test-org-stella-dev",
  name: "Test Firm",
  slug: "test-firm",
} as const;

const TEST_MEMBER = {
  id: "test-member-stella-dev",
  role: "owner",
} as const;

// Token that Playwright will send as a cookie.
const SESSION_TOKEN = "stella-test-session-token";

const SESSION_ID = "test-session-stella-dev";

// 30 days from now.
const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const now = new Date();

/**
 * Ensure all test users and their memberships exist.
 *
 * Idempotent: uses findFirst to skip rows that already exist.
 * Called by `seed-dev.ts` so "Clean + Seed" from the dev menu
 * never hits FK violations on `entities.created_by`.
 */
export async function ensureTestUsers(organizationId: string = TEST_ORG.id) {
  const ts = new Date();

  // --- primary user ---
  if (
    !(await db.query.user.findFirst({
      where: { id: TEST_USER.id },
      columns: { id: true },
    }))
  ) {
    await db.insert(user).values({
      id: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
      emailVerified: true,
      createdAt: ts,
      updatedAt: ts,
    });
  }

  // --- colleague users ---
  for (const colleague of COLLEAGUES) {
    if (
      !(await db.query.user.findFirst({
        where: { id: colleague.id },
        columns: { id: true },
      }))
    ) {
      await db.insert(user).values({
        id: colleague.id,
        name: colleague.name,
        email: colleague.email,
        image: colleague.image,
        emailVerified: true,
        createdAt: ts,
        updatedAt: ts,
      });
    }
  }

  // --- org ---
  if (
    !(await db.query.organization.findFirst({
      where: { id: organizationId },
      columns: { id: true },
    }))
  ) {
    await db.insert(organization).values({
      id: organizationId,
      name: TEST_ORG.name,
      slug: TEST_ORG.slug,
      createdAt: ts,
    });
  }

  // --- memberships ---
  if (
    !(await db.query.member.findFirst({
      where: { id: TEST_MEMBER.id },
      columns: { id: true },
    }))
  ) {
    await db.insert(member).values({
      id: TEST_MEMBER.id,
      organizationId,
      userId: TEST_USER.id,
      role: TEST_MEMBER.role,
      createdAt: ts,
    });
  }

  for (const colleague of COLLEAGUES) {
    if (
      !(await db.query.member.findFirst({
        where: { id: colleague.memberId },
        columns: { id: true },
      }))
    ) {
      await db.insert(member).values({
        id: colleague.memberId,
        organizationId,
        userId: colleague.id,
        role: "member",
        createdAt: ts,
      });
    }
  }
}

async function seed() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run: NODE_ENV must not be 'production'.");
    process.exit(1);
  }

  // --- user ---
  const existingUser = await db.query.user.findFirst({
    where: { id: TEST_USER.id },
    columns: { id: true },
  });

  if (existingUser) {
    console.log("Test user already exists:", TEST_USER.email);
  } else {
    await db.insert(user).values({
      id: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    console.log("Created test user:", TEST_USER.email);
  }

  // --- colleague users ---
  for (const colleague of COLLEAGUES) {
    const existing = await db.query.user.findFirst({
      where: { id: colleague.id },
      columns: { id: true },
    });

    if (existing) {
      console.log("Colleague already exists:", colleague.email);
    } else {
      await db.insert(user).values({
        id: colleague.id,
        name: colleague.name,
        email: colleague.email,
        image: colleague.image,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
      console.log("Created colleague:", colleague.email);
    }
  }

  // --- organization ---
  const existingOrg = await db.query.organization.findFirst({
    where: { id: TEST_ORG.id },
    columns: { id: true },
  });

  if (existingOrg) {
    console.log("Test organization already exists:", TEST_ORG.name);
  } else {
    await db.insert(organization).values({
      id: TEST_ORG.id,
      name: TEST_ORG.name,
      slug: TEST_ORG.slug,
      createdAt: now,
    });
    console.log("Created test organization:", TEST_ORG.name);
  }

  // --- membership ---
  const existingMember = await db.query.member.findFirst({
    where: { id: TEST_MEMBER.id },
    columns: { id: true },
  });

  if (existingMember) {
    console.log("Test membership already exists");
  } else {
    await db.insert(member).values({
      id: TEST_MEMBER.id,
      organizationId: TEST_ORG.id,
      userId: TEST_USER.id,
      role: TEST_MEMBER.role,
      createdAt: now,
    });
    console.log("Created test membership (owner)");
  }

  // --- colleague memberships ---
  for (const colleague of COLLEAGUES) {
    const existing = await db.query.member.findFirst({
      where: { id: colleague.memberId },
      columns: { id: true },
    });

    if (existing) {
      console.log("Colleague membership already exists:", colleague.name);
    } else {
      await db.insert(member).values({
        id: colleague.memberId,
        organizationId: TEST_ORG.id,
        userId: colleague.id,
        role: "member",
        createdAt: now,
      });
      console.log("Created colleague membership:", colleague.name);
    }
  }

  // --- session (always refresh expiry) ---
  const existingSession = await db.query.session.findFirst({
    where: { id: SESSION_ID },
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
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
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
