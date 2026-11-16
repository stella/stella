import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { PROFESSIONAL_USE_ACCEPTANCE_SOURCE } from "@/api/db/schema";
import { recordAccountProfessionalUse } from "@/api/lib/auth/professional-use";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { resolveServerStartedMember } from "@/api/lib/chat/server-started-member";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";

// The member lookup reads through the root pool, so the fixture is written
// through it too.
const db = rootDb;
const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const clock = createTestClock();

const seedMember = async ({ accepted }: { accepted: boolean }) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Queued turn fixture",
    slug: organizationId,
    createdAt: new Date(clock.now()),
  });
  await recordNewOrganizationAccessState(db, {
    organizationId,
    now: new Date(clock.now()),
  });
  await db.insert(user).values({
    id: userId,
    name: "Fixture member",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  if (accepted) {
    const recorded = await recordAccountProfessionalUse({
      userId,
      source: PROFESSIONAL_USE_ACCEPTANCE_SOURCE.interactive,
    });
    expect(recorded.isOk()).toBe(true);
  }
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(clock.now()),
  });
  return {
    organizationId,
    userId,
    cleanUp: async () => {
      await deleteOrganizationsForTest(db, [organizationId]);
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

const resolve = async (owner: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}) =>
  await resolveServerStartedMember({
    ...owner,
    threadId: createSafeId<"chatThread">(),
    queuedMessageId: createSafeId<"chatMessage">(),
    signal: new AbortController().signal,
  });

if (!databaseUrl || !enabled) {
  describe.skip("server-started member (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("server-started member (postgres)", () => {
    test("a current member is proved again from their membership", async () => {
      const owner = await seedMember({ accepted: true });
      try {
        const resolved = await resolve(owner);
        expect(resolved.isOk()).toBe(true);
        const value = resolved.isOk() ? resolved.value : null;
        expect(value?.type).toBe("member");
        if (value?.type === "member") {
          expect(value.caller.user.id).toBe(owner.userId);
          expect(value.caller.session.activeOrganizationId).toBe(
            owner.organizationId,
          );
          // No browser session stands behind the turn.
          expect(value.caller.session.id.startsWith("chat-queue:")).toBe(true);
          expect(value.caller.session.originConsentId).toBeNull();
        }
      } finally {
        await owner.cleanUp();
      }
    });

    test("a member removed since queueing is refused", async () => {
      const owner = await seedMember({ accepted: true });
      try {
        await db
          .delete(member)
          .where(
            and(
              eq(member.organizationId, owner.organizationId),
              eq(member.userId, owner.userId),
            ),
          );
        const resolved = await resolve(owner);
        expect(resolved.isOk() ? resolved.value.type : "error").toBe(
          "unavailable",
        );
      } finally {
        await owner.cleanUp();
      }
    });

    test("an account that has not accepted professional use is refused", async () => {
      const owner = await seedMember({ accepted: false });
      try {
        const resolved = await resolve(owner);
        expect(resolved.isOk() ? resolved.value.type : "error").toBe(
          "unavailable",
        );
      } finally {
        await owner.cleanUp();
      }
    });
  });
}
