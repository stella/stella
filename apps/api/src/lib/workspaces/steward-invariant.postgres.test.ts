import { panic, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import { MATTER_VISIBILITY } from "@stll/api-contract";
import { INTERNAL_MEMBER_ROLES } from "@stll/permissions";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  ORGANIZATION_ACCESS_STATE_ORIGIN,
  organizationAccessStates,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  lockMatterStewardship,
  withAggregateRowQuery,
} from "@/api/lib/db/aggregate-lock";
import { insertWorkspaceRowsInTransaction } from "@/api/lib/workspaces/create-workspace-row";
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
    test("overlapping matter handovers wait and commit without deadlocking", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const organizationId = mintAuthProviderId<"organization">();
        const firstLeadId = mintAuthProviderId<"user">();
        const secondLeadId = mintAuthProviderId<"user">();
        const firstMatterId = createSafeId<"workspace">();
        const sharedMatterId = createSafeId<"workspace">();
        const lastMatterId = createSafeId<"workspace">();
        const workspaceIds = [firstMatterId, sharedMatterId, lastMatterId];
        const userIds = [firstLeadId, secondLeadId];
        await db.insert(organization).values({
          id: organizationId,
          name: "Concurrent stewardship",
          slug: organizationId,
          createdAt: new Date(),
        });
        try {
          await db.insert(organizationAccessStates).values({
            organizationId,
            state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
            origin: ORGANIZATION_ACCESS_STATE_ORIGIN.creation,
          });
          await db.insert(user).values(
            userIds.map((id) => ({
              id,
              name: "Matter lead",
              email: `${id}@stewardship.example.test`,
            })),
          );
          await db.insert(member).values(
            userIds.map((userId) => ({
              id: mintAuthProviderIdValue(),
              organizationId,
              userId,
              role: "member" as const,
              createdAt: new Date(),
            })),
          );
          await db.transaction(async (tx) => {
            await insertWorkspaceRowsInTransaction({
              tx,
              candidateUserIds: userIds,
              rows: workspaceIds.map((id) => ({
                id,
                organizationId,
                name: "Stewarded matter",
                reference: id,
                visibility: MATTER_VISIBILITY.assignedOnly,
                leadUserId: firstLeadId,
              })),
            });
            await tx
              .insert(workspaceMembers)
              .values(
                workspaceIds.flatMap((workspaceId) =>
                  userIds.map((userId) => ({ workspaceId, userId })),
                ),
              );
          });
          await withInterleaving({
            databaseUrl,
            schedules: [["a.handover", "b.handover", "a.commit", "b.commit"]],
            a: {
              steps: [
                {
                  name: "handover",
                  run: async (tx) => {
                    const matters = [firstMatterId, sharedMatterId];
                    await lockMatterStewardship({
                      tx,
                      requests: [
                        { organizationId, workspaceIds: matters, userIds },
                      ],
                      mode: "update",
                    });
                    await tx
                      .update(workspaces)
                      .set({ leadUserId: secondLeadId })
                      .where(
                        and(
                          eq(workspaces.organizationId, organizationId),
                          inArray(workspaces.id, matters),
                        ),
                      );
                  },
                },
              ],
            },
            b: {
              steps: [
                {
                  name: "handover",
                  run: async (tx) => {
                    const matters = [lastMatterId, sharedMatterId];
                    await lockMatterStewardship({
                      tx,
                      requests: [
                        { organizationId, workspaceIds: matters, userIds },
                      ],
                      mode: "update",
                    });
                    await tx
                      .update(workspaces)
                      .set({ leadUserId: firstLeadId })
                      .where(
                        and(
                          eq(workspaces.organizationId, organizationId),
                          inArray(workspaces.id, matters),
                        ),
                      );
                  },
                },
              ],
            },
            reset: async () => undefined,
            readState: async () =>
              await db.transaction(async (tx) => {
                await lockMatterStewardship({
                  tx,
                  requests: [{ organizationId, workspaceIds, userIds }],
                  mode: "update",
                });
                return await tx
                  .select({
                    id: workspaces.id,
                    leadUserId: workspaces.leadUserId,
                    visibility: workspaces.visibility,
                    leadAssignmentId: workspaceMembers.id,
                    leadMemberRole: member.role,
                  })
                  .from(workspaces)
                  .leftJoin(
                    workspaceMembers,
                    and(
                      eq(workspaceMembers.workspaceId, workspaces.id),
                      eq(workspaceMembers.userId, workspaces.leadUserId),
                    ),
                  )
                  .leftJoin(
                    member,
                    and(
                      eq(member.organizationId, workspaces.organizationId),
                      eq(member.userId, workspaces.leadUserId),
                    ),
                  )
                  .where(
                    and(
                      eq(workspaces.organizationId, organizationId),
                      inArray(workspaces.id, workspaceIds),
                    ),
                  )
                  .limit(workspaceIds.length);
              }),
            invariant: ({ blocked, outcomes, state }) => {
              // The interleaving owner records this only after Postgres reports a lock wait.
              expect(blocked).toContain("b.handover");
              expect(outcomes).toEqual({
                a: { status: "committed" },
                b: { status: "committed" },
              });
              expect(state).toHaveLength(workspaceIds.length);
              expect(
                new Map(state.map((matter) => [matter.id, matter.leadUserId])),
              ).toEqual(
                new Map([
                  [firstMatterId, secondLeadId],
                  [sharedMatterId, firstLeadId],
                  [lastMatterId, firstLeadId],
                ]),
              );
              for (const matter of state) {
                expect(matter.visibility).toBe(MATTER_VISIBILITY.assignedOnly);
                expect(matter.leadAssignmentId).not.toBeNull();
                expect(
                  INTERNAL_MEMBER_ROLES.some(
                    (role) => role === matter.leadMemberRole,
                  ),
                ).toBe(true);
              }
            },
          });
        } finally {
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(inArray(user.id, userIds));
        }
      });
    });

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
          await db.transaction(async (tx) => {
            await lockMatterStewardship({
              tx,
              requests: [
                {
                  organizationId,
                  workspaceIds: [workspaceId],
                  userIds: [leadUserId, ownerId],
                },
              ],
              mode: "update",
            });
            await tx.insert(workspaceMembers).values({
              workspaceId,
              userId:
                mutation === "new assignment handover" ? ownerId : leadUserId,
            });
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
                      await lockMatterStewardship({
                        tx,
                        requests: [
                          {
                            organizationId,
                            workspaceIds: [workspaceId],
                            userIds: [leadUserId, ownerId],
                          },
                        ],
                        mode: "update",
                      });
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
                      await lockMatterStewardship({
                        tx,
                        requests: [
                          {
                            organizationId,
                            workspaceIds: [workspaceId],
                            userIds: [leadUserId, ownerId],
                            membershipUserIds:
                              mutation === "assignment deletion" ||
                              mutation === "lead clearing"
                                ? []
                                : [leadUserId],
                          },
                        ],
                        mode: "update",
                      });
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
                          panic("Unexpected steward mutation", exhaustive);
                        }
                      }
                    },
                  },
                ],
              },
              reset: async () => {
                await db.transaction(async (tx) => {
                  await lockMatterStewardship({
                    tx,
                    requests: [
                      {
                        organizationId,
                        workspaceIds: [workspaceId],
                        userIds: [leadUserId, ownerId],
                        membershipUserIds: [leadUserId],
                      },
                    ],
                    mode: "update",
                  });
                  await tx
                    .update(workspaces)
                    .set({
                      visibility: MATTER_VISIBILITY.adminsAndAssigned,
                      leadUserId:
                        mutation === "new assignment handover"
                          ? ownerId
                          : leadUserId,
                    })
                    .where(eq(workspaces.id, workspaceId));
                  await tx
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
                    await tx
                      .delete(workspaceMembers)
                      .where(
                        and(
                          eq(workspaceMembers.workspaceId, workspaceId),
                          eq(workspaceMembers.userId, leadUserId),
                        ),
                      );
                  } else {
                    await tx
                      .insert(workspaceMembers)
                      .values({ workspaceId, userId: leadUserId })
                      .onConflictDoNothing();
                  }
                });
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
                expect(outcomes.a.status).not.toBe("deadlock");
                expect(outcomes.b.status).not.toBe("deadlock");
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
