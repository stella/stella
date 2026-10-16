import { panic, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { MATTER_VISIBILITY } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { hasUsableSteward } from "@/api/lib/workspaces/visibility";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

class StewardUnavailable extends TaggedError("StewardUnavailable")<{
  message: string;
}> {}

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
    test.each([
      "role change",
      "assignment deletion",
      "membership deletion",
      "lead clearing",
      "new assignment handover",
    ] as const)(
      "narrowing a matter and %s never both commit",
      async (mutation) => {
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
            leadUserId:
              mutation === "new assignment handover" ? ownerId : leadUserId,
            visibility: MATTER_VISIBILITY.adminsAndAssigned,
          });
          await db.insert(workspaceMembers).values({
            workspaceId,
            userId:
              mutation === "new assignment handover" ? ownerId : leadUserId,
          });

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
                      if (mutation === "new assignment handover") {
                        await tx
                          .insert(workspaceMembers)
                          .values({ workspaceId, userId: leadUserId });
                        return;
                      }
                      const locked = await withAggregateRowQuery({
                        tx,
                        aggregate: "workspace",
                        id: { id: workspaceId, organizationId },
                        mode: "update",
                        select: (lockTx) =>
                          lockTx
                            .select({
                              id: workspaces.id,
                              organizationId: workspaces.organizationId,
                              leadUserId: workspaces.leadUserId,
                            })
                            .from(workspaces),
                      });
                      const matter =
                        locked.rows.at(0) ?? panic("Fixture matter missing");
                      if (
                        !(await hasUsableSteward(tx, {
                          organizationId,
                          workspaceId,
                          leadUserId: matter.leadUserId,
                        }))
                      ) {
                        throw new StewardUnavailable({
                          message: "The lead can no longer steward it",
                        });
                      }
                    },
                  },
                  {
                    name: "narrow",
                    run: async (tx) => {
                      await tx
                        .update(workspaces)
                        .set({
                          visibility: MATTER_VISIBILITY.assignedOnly,
                          ...(mutation === "new assignment handover"
                            ? { leadUserId }
                            : {}),
                        })
                        .where(eq(workspaces.id, workspaceId));
                    },
                  },
                ],
              },
              b: {
                steps: [
                  {
                    name: "removeSteward",
                    run: async (tx) => {
                      switch (mutation) {
                        case "new assignment handover":
                        case "role change":
                          await tx
                            .update(member)
                            .set({ role: "external" })
                            .where(eq(member.id, leadMemberId));
                          return;
                        case "assignment deletion":
                          await tx
                            .delete(workspaceMembers)
                            .where(
                              and(
                                eq(workspaceMembers.workspaceId, workspaceId),
                                eq(workspaceMembers.userId, leadUserId),
                              ),
                            );
                          return;
                        case "membership deletion":
                          await tx
                            .delete(member)
                            .where(eq(member.id, leadMemberId));
                          return;
                        case "lead clearing":
                          await tx
                            .update(workspaces)
                            .set({ leadUserId: null })
                            .where(eq(workspaces.id, workspaceId));
                          return;
                        default: {
                          const exhaustive: never = mutation;
                          return exhaustive;
                        }
                      }
                    },
                  },
                ],
              },
              reset: async () => {
                await db
                  .update(workspaces)
                  .set({
                    visibility: MATTER_VISIBILITY.adminsAndAssigned,
                    leadUserId:
                      mutation === "new assignment handover"
                        ? ownerId
                        : leadUserId,
                  })
                  .where(eq(workspaces.id, workspaceId));
                await db
                  .insert(member)
                  .values({
                    id: leadMemberId,
                    organizationId,
                    userId: leadUserId,
                    role: "member",
                    createdAt: new Date(),
                  })
                  .onConflictDoUpdate({
                    target: member.id,
                    set: { role: "member" },
                  });
                if (mutation === "new assignment handover") {
                  await db
                    .delete(workspaceMembers)
                    .where(
                      and(
                        eq(workspaceMembers.workspaceId, workspaceId),
                        eq(workspaceMembers.userId, leadUserId),
                      ),
                    );
                } else {
                  await db
                    .insert(workspaceMembers)
                    .values({ workspaceId, userId: leadUserId })
                    .onConflictDoNothing();
                }
              },
              readState: async () =>
                await db.transaction(async (tx) => {
                  const matters = await tx
                    .select({
                      visibility: workspaces.visibility,
                      leadUserId: workspaces.leadUserId,
                    })
                    .from(workspaces)
                    .where(eq(workspaces.id, workspaceId));
                  const matter =
                    matters.at(0) ?? panic("Fixture matter missing");
                  return {
                    visibility: matter.visibility,
                    usableSteward: await hasUsableSteward(tx, {
                      organizationId,
                      workspaceId,
                      leadUserId: matter.leadUserId,
                    }),
                  };
                }),
              invariant: ({ outcomes, state }) => {
                const committed = [outcomes.a, outcomes.b].filter(
                  ({ status }) => status === "committed",
                );
                expect(committed).toHaveLength(1);
                expect(state).toEqual(
                  outcomes.a.status === "committed"
                    ? {
                        visibility: MATTER_VISIBILITY.assignedOnly,
                        usableSteward: true,
                      }
                    : {
                        visibility: MATTER_VISIBILITY.adminsAndAssigned,
                        usableSteward: mutation === "new assignment handover",
                      },
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
      },
    );
  });
}
