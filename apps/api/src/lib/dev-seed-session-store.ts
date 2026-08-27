import { panic } from "better-result";

import { session } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { sessionCookieName } from "@/api/lib/auth-cookie-name";
import type { SafeId } from "@/api/lib/branded-types";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";

const DEV_SEED_SESSION_LIFETIME_MS = 2 * 60 * 60 * 1000;

type MintDevSeedSessionOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type DevSeedSession = {
  cookie: string;
};

export const resolveMemberDevOrganization = async (
  organizationIdValue: string,
  userId: SafeId<"user">,
): Promise<SafeId<"organization"> | null> => {
  const organizationId =
    parseAuthProviderId<"organization">(organizationIdValue);
  if (organizationId === null) {
    return null;
  }
  const membership = await rootDb.query.member.findFirst({
    columns: { id: true },
    where: {
      organizationId: { eq: organizationId },
      userId: { eq: userId },
    },
  });
  return membership ? organizationId : null;
};

/**
 * Mint an isolated session for the background importer.
 *
 * The browser session's active organization is mutable. Reusing that cookie
 * would let a tab switch redirect later upload requests into another org, so
 * the job gets its own short-lived session pinned to the server-bound user and
 * organization captured by the authenticated dev route.
 */
export const mintDevSeedSession = async ({
  organizationId,
  userId,
}: MintDevSeedSessionOptions): Promise<DevSeedSession> => {
  if (!env.isDev) {
    panic("Dev seed sessions are unavailable outside development.");
  }

  const now = new Date();
  const token = Bun.randomUUIDv7();
  // audit: skip — dev-only ephemeral auth state for a synthetic corpus import
  await rootDb.insert(session).values({
    id: `dev-seed-session-${token}`,
    token,
    userId,
    activeOrganizationId: organizationId,
    expiresAt: new Date(now.getTime() + DEV_SEED_SESSION_LIFETIME_MS),
    createdAt: now,
    updatedAt: now,
    ipAddress: "dev-seed",
    userAgent: "stella-dev-firm-knowledge-seed",
  });

  const signature = new Bun.CryptoHasher("sha256", env.BETTER_AUTH_SECRET)
    .update(token)
    .digest("base64");

  return {
    cookie: `${sessionCookieName()}=${token}.${signature}`,
  };
};
