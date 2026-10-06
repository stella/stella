import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import { featureEnrolments } from "@/api/db/schema";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { ensureOrganizationExists, ensureTestUsers } from "./seed-test-user";

const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)("test user seed (postgres)", () => {
  test("replays preserve the owner's enrolment without enrolling colleagues or another organization", async () => {
    const db = openMaintenanceDb({ readOnly: false });
    const organizationId = mintAuthProviderId<"organization">();
    const otherOrganizationId = mintAuthProviderId<"organization">();
    const organizationIds = [organizationId, otherOrganizationId];
    const readEnrolments = async () =>
      await db.transaction(
        async (tx) =>
          await tx
            .select()
            .from(featureEnrolments)
            .where(inArray(featureEnrolments.organizationId, organizationIds)),
      );

    try {
      await ensureOrganizationExists(otherOrganizationId);
      expect(await readEnrolments()).toEqual([]);

      const first = await ensureTestUsers(organizationId);
      const enrolled = await readEnrolments();
      expect(enrolled).toHaveLength(1);
      expect(enrolled.at(0)).toMatchObject({
        organizationId,
        userId: first.testUserId,
        featureId: "time-billing",
      });
      expect(first.colleagueUserIds.length).toBeGreaterThan(0);
      expect(first.colleagueUserIds).not.toContain(first.testUserId);
      const owner = await db.transaction(
        async (tx) =>
          await tx
            .select({ emailVerified: user.emailVerified })
            .from(user)
            .where(eq(user.id, first.testUserId)),
      );
      expect(owner).toEqual([{ emailVerified: true }]);

      expect(await ensureTestUsers(organizationId)).toEqual(first);
      expect(await readEnrolments()).toEqual(enrolled);
    } finally {
      await db.transaction(async (tx) => {
        await tx
          .delete(organization)
          .where(inArray(organization.id, organizationIds));
      });
    }
  });
});
