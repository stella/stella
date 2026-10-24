import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { DesktopBillingDraftRequest } from "@stll/api-contract/desktop-billing-drafts";
import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  agentSkillResources,
  agentSkills,
  billingDraftUserSettings,
  billingGuidelineFiles,
  organizationSettings,
  timeEntries,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import { loadBillingDraftContext } from "./billing-drafts-context";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const today = Temporal.PlainDate.from("2026-10-09");
const clock = spyOn(Temporal.Now, "plainDateISO").mockReturnValue(today);

if (!databaseUrl || !runPostgres) {
  describe.skip("billing draft context (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  test("context enforces caller, selected matter, and the 90-day history bound", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const otherUserId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const otherWorkspaceId = createSafeId<"workspace">();
      const skillId = createSafeId<"agentSkill">();
      const resourceId = createSafeId<"agentSkillResource">();
      const currentId = createSafeId<"timeEntry">();
      const boundaryId = createSafeId<"timeEntry">();
      const expiredId = createSafeId<"timeEntry">();
      const otherCallerId = createSafeId<"timeEntry">();
      const colleagueId = createSafeId<"timeEntry">();

      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Billing draft PostgreSQL fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values([
          {
            id: userId,
            name: "Draft caller",
            email: `${userId}@example.test`,
            emailVerified: true,
          },
          {
            id: otherUserId,
            name: "Other caller",
            email: `${otherUserId}@example.test`,
            emailVerified: true,
          },
        ]);
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await db.insert(organizationSettings).values({
          id: createSafeId<"organizationSettings">(),
          organizationId,
          aiBillingDraftsMode: "enabled",
        });
        // Both tables force row security, so fixtures write as the member.
        const asCaller = createSafeDb(db, [], organizationId, userId);
        (
          await asCaller((tx) =>
            tx.insert(billingDraftUserSettings).values({
              organizationId,
              userId,
              consentAt: new Date("2026-10-01T12:00:00Z"),
              preference: "Concise narratives",
            }),
          )
        ).unwrap();
        await db.insert(workspaces).values([
          {
            id: workspaceId,
            organizationId,
            name: "Selected matter",
            reference: Bun.randomUUIDv7(),
          },
          {
            id: otherWorkspaceId,
            organizationId,
            name: "Other matter",
            reference: Bun.randomUUIDv7(),
          },
        ]);
        await db.insert(agentSkills).values({
          id: skillId,
          organizationId,
          userId,
          scope: "team",
          origin: "authored",
          slug: "billing-rules",
          name: "Billing rules",
          description: "Rules",
          contentHash: "a".repeat(64),
          body: "Rules",
        });
        await db.insert(agentSkillResources).values({
          id: resourceId,
          organizationId,
          skillId,
          path: "references/firm.md",
          content: "# Billing\nDescribe the work",
          sizeBytes: 29,
        });
        (
          await asCaller((tx) =>
            tx.insert(billingGuidelineFiles).values({
              organizationId,
              resourceId,
              clientId: null,
            }),
          )
        ).unwrap();
        const history = [
          { id: currentId, userId, workspaceId, dateWorked: today.toString() },
          {
            id: boundaryId,
            userId,
            workspaceId,
            dateWorked: today.subtract({ days: 90 }).toString(),
          },
          {
            id: expiredId,
            userId,
            workspaceId,
            dateWorked: today.subtract({ days: 91 }).toString(),
          },
          {
            id: otherCallerId,
            userId: otherUserId,
            workspaceId: otherWorkspaceId,
            dateWorked: today.toString(),
          },
          {
            id: colleagueId,
            userId: otherUserId,
            workspaceId,
            dateWorked: today.toString(),
          },
        ];
        await db.insert(timeEntries).values(
          history.map((entry) => ({
            ...entry,
            organizationId,
            timezoneId: "Europe/Prague",
            durationMinutes: 30,
            billedMinutes: 30,
            rateAtEntry: cents(100),
            currency: "CZK",
            narrative: "Reviewed agreement",
          })),
        );

        const safeDb = createSafeDb(db, [workspaceId], organizationId, userId);
        const body = {
          entries: [
            {
              matterId: workspaceId,
              date: today.toString(),
              timezone: "Europe/Prague",
              durationMinutes: 60,
              appNames: ["Editor"],
            },
          ],
        } satisfies DesktopBillingDraftRequest;
        const result = await loadBillingDraftContext({
          safeDb,
          organizationId,
          userId,
          body,
        });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(
            result.value.earlierEntries.map(({ id }) => id).toSorted(),
          ).toEqual([currentId, boundaryId].toSorted());
          expect(
            result.value.earlierEntries.every(
              ({ matterId }) => matterId === workspaceId,
            ),
          ).toBe(true);
          expect(result.value.preference).toBe("Concise narratives");
        }

        const otherMatter = await loadBillingDraftContext({
          safeDb,
          organizationId,
          userId,
          body: {
            entries: [{ ...body.entries[0], matterId: otherWorkspaceId }],
          },
        });
        expect(otherMatter.isErr()).toBe(true);
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(inArray(user.id, [userId, otherUserId]));
      }
    });
  });

  test("organization disablement and revoked consent refuse context", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Disabled fixture",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(user).values({
          id: userId,
          name: "Caller",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(member).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        });
        await db.insert(organizationSettings).values({
          id: createSafeId<"organizationSettings">(),
          organizationId,
        });
        const safeDb = createSafeDb(db, [], organizationId, userId);
        (
          await safeDb((tx) =>
            tx.insert(billingDraftUserSettings).values({
              organizationId,
              userId,
              consentAt: new Date("2026-10-01T12:00:00Z"),
            }),
          )
        ).unwrap();
        const disabled = await loadBillingDraftContext({
          safeDb,
          organizationId,
          userId,
          body: {
            entries: [
              {
                matterId: createSafeId<"workspace">(),
                date: today.toString(),
                timezone: "Europe/Prague",
                durationMinutes: 30,
                appNames: [],
              },
            ],
          },
        });
        expect(disabled.isErr()).toBe(true);
        if (disabled.isErr()) {
          expect(disabled.error.message).toContain(
            "organization enablement and personal consent",
          );
        }

        await db
          .update(organizationSettings)
          .set({ aiBillingDraftsMode: "enabled" })
          .where(eq(organizationSettings.organizationId, organizationId));
        (
          await safeDb((tx) =>
            tx
              .update(billingDraftUserSettings)
              .set({ consentAt: null })
              .where(
                and(
                  eq(billingDraftUserSettings.organizationId, organizationId),
                  eq(billingDraftUserSettings.userId, userId),
                ),
              ),
          )
        ).unwrap();
        const revoked = await loadBillingDraftContext({
          safeDb,
          organizationId,
          userId,
          body: {
            entries: [
              {
                matterId: createSafeId<"workspace">(),
                date: today.toString(),
                timezone: "Europe/Prague",
                durationMinutes: 30,
                appNames: [],
              },
            ],
          },
        });
        expect(revoked.isErr()).toBe(true);
        if (revoked.isErr()) {
          expect(revoked.error.message).toContain(
            "organization enablement and personal consent",
          );
        }
      } finally {
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });

  test("consent granted in one organization does not authorize another organization", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: rawDb } = openClient();
      const db = markRlsDatabase(rawDb);
      const organizationA = mintAuthProviderId<"organization">();
      const organizationB = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      try {
        await db.insert(organization).values([
          {
            id: organizationA,
            name: "Consent organization A",
            slug: organizationA,
            createdAt: new Date(),
          },
          {
            id: organizationB,
            name: "Consent organization B",
            slug: organizationB,
            createdAt: new Date(),
          },
        ]);
        await db.insert(user).values({
          id: userId,
          name: "Shared member",
          email: `${userId}@example.test`,
          emailVerified: true,
        });
        await db.insert(member).values([
          {
            id: mintAuthProviderIdValue(),
            organizationId: organizationA,
            userId,
            role: "owner",
            createdAt: new Date(),
          },
          {
            id: mintAuthProviderIdValue(),
            organizationId: organizationB,
            userId,
            role: "owner",
            createdAt: new Date(),
          },
        ]);
        await db.insert(organizationSettings).values([
          {
            id: createSafeId<"organizationSettings">(),
            organizationId: organizationA,
            aiBillingDraftsMode: "enabled",
          },
          {
            id: createSafeId<"organizationSettings">(),
            organizationId: organizationB,
            aiBillingDraftsMode: "enabled",
          },
        ]);
        const settingsA = createSafeDb(db, [], organizationA, userId);
        const settingsB = createSafeDb(db, [], organizationB, userId);
        (
          await settingsA((tx) =>
            tx.insert(billingDraftUserSettings).values({
              organizationId: organizationA,
              userId,
              consentAt: new Date("2026-10-01T12:00:00Z"),
              preference: "Organization A preference",
            }),
          )
        ).unwrap();
        (
          await settingsB((tx) =>
            tx.insert(billingDraftUserSettings).values({
              organizationId: organizationB,
              userId,
              consentAt: null,
            }),
          )
        ).unwrap();

        const result = await loadBillingDraftContext({
          safeDb: createSafeDb(db, [], organizationB, userId),
          organizationId: organizationB,
          userId,
          body: {
            entries: [
              {
                matterId: createSafeId<"workspace">(),
                date: today.toString(),
                timezone: "Europe/Prague",
                durationMinutes: 30,
                appNames: [],
              },
            ],
          },
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.message).toContain(
            "organization enablement and personal consent",
          );
        }
        const initialB = (
          await settingsB((tx) => tx.select().from(billingDraftUserSettings))
        ).unwrap();
        expect(initialB).toMatchObject([
          { organizationId: organizationB, userId, consentAt: null },
        ]);
        await settingsB((tx) =>
          tx
            .update(billingDraftUserSettings)
            .set({
              consentAt: new Date("2026-10-02T12:00:00Z"),
              preference: "Organization B preference",
            })
            .where(
              and(
                eq(billingDraftUserSettings.organizationId, organizationB),
                eq(billingDraftUserSettings.userId, userId),
              ),
            ),
        );
        await settingsA((tx) =>
          tx
            .update(billingDraftUserSettings)
            .set({ consentAt: null })
            .where(
              and(
                eq(billingDraftUserSettings.organizationId, organizationA),
                eq(billingDraftUserSettings.userId, userId),
              ),
            ),
        );
        const remainingB = (
          await settingsB((tx) => tx.select().from(billingDraftUserSettings))
        ).unwrap();
        expect(remainingB).toMatchObject([
          {
            organizationId: organizationB,
            userId,
            consentAt: new Date("2026-10-02T12:00:00Z"),
            preference: "Organization B preference",
          },
        ]);
        const stillGranted = await loadBillingDraftContext({
          safeDb: createSafeDb(db, [], organizationB, userId),
          organizationId: organizationB,
          userId,
          body: {
            entries: [
              {
                matterId: createSafeId<"workspace">(),
                date: today.toString(),
                timezone: "Europe/Prague",
                durationMinutes: 30,
                appNames: [],
              },
            ],
          },
        });
        expect(stillGranted.isErr()).toBe(true);
        if (stillGranted.isErr()) {
          expect(stillGranted.error.message).toBe(
            "Selected matter is unavailable",
          );
        }
      } finally {
        await db
          .delete(organization)
          .where(inArray(organization.id, [organizationA, organizationB]));
        await db.delete(user).where(eq(user.id, userId));
      }
    });
  });
}

afterAll(() => clock.mockRestore());
