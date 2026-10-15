import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { hasUsableSteward } from "@/api/lib/workspaces/visibility";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("matter steward invariant (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("matter steward invariant (postgres)", () => {
    test("narrowing a matter and turning its lead external never both commit", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const organizationId = mintAuthProviderId<"organization">();
        const leadUserId = mintAuthProviderId<"user">();
        const ownerId = mintAuthProviderId<"user">();
        const leadMemberId = mintAuthProviderIdValue();
        const workspaceId = createSafeId<"workspace">();
        const suffix = Bun.randomUUIDv7().replaceAll("-", "");
        await db.insert(organization).values({
          id: organizationId,
          name: "Steward invariant",
          slug: `steward-invariant-${suffix}`,
          createdAt: new Date(),
        });
        await db.insert(user).values([
          {
            id: leadUserId,
            name: "Lead",
            email: `lead-${suffix}@example.test`,
          },
          {
            id: ownerId,
            name: "Owner",
            email: `owner-${suffix}@example.test`,
          },
        ]);
        await db.insert(member).values([
          {
            id: leadMemberId,
            organizationId,
            userId: leadUserId,
            role: "member",
            createdAt: new Date(),
          },
          {
            id: mintAuthProviderIdValue(),
            organizationId,
            userId: ownerId,
            role: "owner",
            createdAt: new Date(),
          },
        ]);
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Stewarded matter",
          reference: suffix,
          leadUserId,
          visibility: "admins_and_assigned",
        });
        await db
          .insert(workspaceMembers)
          .values({ workspaceId, userId: leadUserId });

        try {
          await withInterleaving({
            databaseUrl,
            a: {
              // Narrowing, as the matter update does it: the steward check
              // takes the matter row, then the write.
              steps: [
                {
                  name: "checkSteward",
                  run: async (tx) => {
                    if (
                      !(await hasUsableSteward(tx, {
                        organizationId,
                        workspaceId,
                        leadUserId,
                      }))
                    ) {
                      throw new Error("The lead can no longer steward it");
                    }
                  },
                },
                {
                  name: "narrow",
                  run: async (tx) => {
                    await tx
                      .update(workspaces)
                      .set({ visibility: "assigned_only" })
                      .where(eq(workspaces.id, workspaceId));
                  },
                },
              ],
            },
            b: {
              // The membership plugin's role change: one member row update.
              steps: [
                {
                  name: "makeExternal",
                  run: async (tx) => {
                    await tx
                      .update(member)
                      .set({ role: "external" })
                      .where(eq(member.id, leadMemberId));
                  },
                },
              ],
            },
            reset: async () => {
              await db
                .update(workspaces)
                .set({ visibility: "admins_and_assigned", leadUserId })
                .where(eq(workspaces.id, workspaceId));
              await db
                .update(member)
                .set({ role: "member" })
                .where(eq(member.id, leadMemberId));
            },
            readState: async () => {
              const matter = await db
                .select({ visibility: workspaces.visibility })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId));
              const lead = await db
                .select({ role: member.role })
                .from(member)
                .where(
                  and(
                    eq(member.organizationId, organizationId),
                    eq(member.userId, leadUserId),
                  ),
                );
              return {
                visibility: matter.at(0)?.visibility,
                leadRole: lead.at(0)?.role,
              };
            },
            invariant: ({ outcomes, state }) => {
              const committed = [outcomes.a, outcomes.b].filter(
                ({ status }) => status === "committed",
              );
              expect(committed).toHaveLength(1);
              expect(state).toEqual(
                outcomes.a.status === "committed"
                  ? { visibility: "assigned_only", leadRole: "member" }
                  : { visibility: "admins_and_assigned", leadRole: "external" },
              );
            },
          });
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, leadUserId));
          await db.delete(user).where(eq(user.id, ownerId));
        }
      });
    });
  });
}
