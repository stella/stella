import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  billingCodes,
  rateEntries,
  rateTables,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import { resolveRate } from "./rates";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl || process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true") {
  describe.skip("activity rate precedence (postgres)", () => {
    test("requires the Postgres test configuration", () =>
      expect(true).toBe(true));
  });
} else {
  describe("activity rate precedence (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const workspaceId = createSafeId<"workspace">();
    const rateTableId = createSafeId<"rateTable">();
    const activityCodeId = createSafeId<"billingCode">();
    cleanUp(async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
    });
    cleanUp(async () => {
      await db.delete(user).where(eq(user.id, userId));
    });

    test("overlapping effective dates obey all six precedence branches and inclusive boundaries", async () => {
      await db.insert(user).values({
        id: userId,
        name: "Rate member",
        email: `${userId}@example.test`,
        emailVerified: true,
      });
      await db.insert(organization).values({
        id: organizationId,
        name: "Rate organization",
        slug: organizationId,
        createdAt: new Date(),
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      });
      await db.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Rate matter",
        reference: workspaceId,
      });
      await db.insert(workspaceMembers).values({ workspaceId, userId });
      await db.insert(rateTables).values({
        id: rateTableId,
        organizationId,
        workspaceId,
        name: "Effective rates",
        currency: "EUR",
        isDefault: true,
      });
      await db.insert(billingCodes).values({
        id: activityCodeId,
        organizationId,
        workspaceId,
        type: "activity",
        code: "A1",
        label: "Research",
      });
      const selectors = [
        { userId, role: null, activityCodeId },
        { userId: null, role: "member", activityCodeId },
        { userId: null, role: null, activityCodeId },
        { userId, role: null, activityCodeId: null },
        { userId: null, role: "member", activityCodeId: null },
        { userId: null, role: null, activityCodeId: null },
      ] as const;
      const entries = selectors.map((selector, index) => ({
        ...selector,
        id: createSafeId<"rateEntry">(),
        rateTableId,
        workspaceId,
        hourlyRate: cents(600 - index * 100),
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-12-31",
      }));
      await db.insert(rateEntries).values(entries);
      const safeDb = createSafeDb(
        markRlsDatabase(db),
        [workspaceId],
        organizationId,
        userId,
      );
      const resolve = async (dateWorked: string) => {
        const result = await Result.gen(async function* () {
          return Result.ok(
            yield* resolveRate({
              safeDb,
              workspaceId,
              userId,
              activityCode: "A1",
              dateWorked,
            }),
          );
        });
        if (result.isErr()) {
          throw result.error;
        }
        return result.value;
      };
      expect(await resolve("2025-12-31")).toBeNull();
      expect(await resolve("2027-01-01")).toBeNull();
      expect((await resolve("2026-01-01"))?.hourlyRate).toBe(600);
      expect((await resolve("2026-12-31"))?.hourlyRate).toBe(600);
      for (const entry of entries) {
        expect((await resolve("2026-06-01"))?.hourlyRate).toBe(
          entry.hourlyRate,
        );
        await db.delete(rateEntries).where(eq(rateEntries.id, entry.id));
      }
      expect(await resolve("2026-06-01")).toBeNull();
    });
  });
}
