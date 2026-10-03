import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { and, eq } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import {
  auditLogs,
  contacts,
  entities,
  taskAssignees,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { getAuth } from "@/api/lib/auth";
import { createSafeId } from "@/api/lib/branded-types";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

setDefaultTimeout(120_000);
let db: Awaited<ReturnType<typeof initAgentAuthTestDb>>;
beforeAll(async () => {
  db = await initAgentAuthTestDb();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});
test.each([
  "unassigned",
  "replacement",
  "invalid",
  "partial-membership",
] as const)(
  "organization removal preserves work with %s disposition",
  async (disposition) => {
    const refused =
      disposition === "invalid" || disposition === "partial-membership";
    const owner = await signInHuman(
      `assignment-owner-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const leaver = await signInHuman(
      `assignment-leaver-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const outsider = await signInHuman(
      `assignment-other-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const auth = getAuth();
    const org = await auth.api.createOrganization({
      body: {
        name: "Assignment fixture",
        slug: `assignments-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    const added = await auth.api.addMember({
      body: { organizationId: org.id, userId: leaver.userId, role: "member" },
      headers: owner.headers(),
    });
    const workspaceIds = [
      createSafeId<"workspace">(),
      createSafeId<"workspace">(),
    ];
    const tasks = workspaceIds.map((workspaceId) => ({
      id: createSafeId<"entity">(),
      workspaceId,
      kind: "task" as const,
      name: "Retained task",
    }));
    await db.insert(workspaces).values(
      workspaceIds.map((id) => ({
        id,
        organizationId: org.id,
        name: "Assignment matter",
        reference: id,
      })),
    );
    await db.insert(workspaceMembers).values(
      workspaceIds.flatMap((workspaceId) =>
        [owner.userId, leaver.userId].map((userId) => ({
          workspaceId,
          userId,
        })),
      ),
    );
    await db.insert(entities).values(tasks);
    await db.insert(taskAssignees).values(
      tasks.map(({ id, workspaceId }) => ({
        entityId: id,
        workspaceId,
        userId: leaver.userId,
        role: "assignee" as const,
      })),
    );
    const coassigned = tasks.at(1);
    if (!coassigned) {
      throw new Error("Expected two matters");
    }
    await db.insert(taskAssignees).values({
      entityId: coassigned.id,
      workspaceId: coassigned.workspaceId,
      userId: owner.userId,
      role: "reviewer",
    });
    const otherOrg = await auth.api.createOrganization({
      body: {
        name: "Other assignment fixture",
        slug: `other-assignments-${Bun.randomUUIDv7()}`,
      },
      headers: owner.headers(),
    });
    const otherMembership = await auth.api.addMember({
      body: {
        organizationId: otherOrg.id,
        userId: leaver.userId,
        role: "member",
      },
      headers: owner.headers(),
    });
    const otherWorkspaceId = createSafeId<"workspace">();
    const otherTaskId = createSafeId<"entity">();
    await db.insert(workspaces).values({
      id: otherWorkspaceId,
      organizationId: otherOrg.id,
      name: "Other matter",
      reference: otherWorkspaceId,
    });
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: otherWorkspaceId, userId: leaver.userId });
    await db.insert(entities).values({
      id: otherTaskId,
      workspaceId: otherWorkspaceId,
      kind: "task",
      name: "Other work",
    });
    await db.insert(taskAssignees).values({
      entityId: otherTaskId,
      workspaceId: otherWorkspaceId,
      userId: leaver.userId,
      role: "assignee",
    });
    const contactId = createSafeId<"contact">();
    await db.insert(contacts).values({
      id: contactId,
      organizationId: org.id,
      type: "person",
      displayName: "Assignment contact",
      originatingAttorneyId: leaver.userId,
      responsibleAttorneyId: owner.userId,
    });
    if (disposition === "partial-membership") {
      await db
        .delete(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, coassigned.workspaceId),
            eq(workspaceMembers.userId, owner.userId),
          ),
        );
    }
    const headers = owner.headers();
    headers.set("content-type", "application/json");
    headers.set("origin", "http://localhost:3001");
    const response = await auth.handler(
      new Request("http://localhost:3001/api/auth/organization/remove-member", {
        method: "POST",
        headers,
        body: JSON.stringify({
          organizationId: org.id,
          memberIdOrEmail: added.id,
          ...(disposition === "unassigned"
            ? {}
            : {
                reassign_to:
                  disposition !== "invalid" ? owner.userId : outsider.userId,
              }),
        }),
      }),
    );
    expect(response.status).toBe(refused ? 400 : 200);
    expect(await db.$count(member, eq(member.id, otherMembership.id))).toBe(1);
    expect(
      await db.$count(taskAssignees, eq(taskAssignees.entityId, otherTaskId)),
    ).toBe(1);
    expect(await db.$count(member, eq(member.id, added.id))).toBe(
      refused ? 1 : 0,
    );
    for (const task of tasks) {
      const assigned = await db
        .select({ userId: taskAssignees.userId, role: taskAssignees.role })
        .from(taskAssignees)
        .where(eq(taskAssignees.entityId, task.id));
      const expected =
        task.id === coassigned.id
          ? [{ userId: owner.userId, role: "reviewer" }]
          : [];
      if (refused) {
        expected.push({ userId: leaver.userId, role: "assignee" });
      }
      if (disposition === "replacement" && task.id !== coassigned.id) {
        expected.push({ userId: owner.userId, role: "assignee" });
      }
      expect(assigned).toHaveLength(expected.length);
      expect(assigned).toEqual(expect.arrayContaining(expected));
      expect(await db.$count(entities, eq(entities.id, task.id))).toBe(1);
      const history = await db
        .select({ changes: auditLogs.changes })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, task.id));
      expect(history).toEqual(
        refused
          ? []
          : [
              expect.objectContaining({
                changes: expect.objectContaining({
                  assigneeUserId: {
                    old: leaver.userId,
                    new: disposition === "replacement" ? owner.userId : null,
                  },
                }),
              }),
            ],
      );
      expect(
        await db.$count(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, task.workspaceId),
            eq(workspaceMembers.userId, leaver.userId),
          ),
        ),
      ).toBe(refused ? 1 : 0);
    }
    expect(
      await db
        .select({
          originatingAttorneyId: contacts.originatingAttorneyId,
          responsibleAttorneyId: contacts.responsibleAttorneyId,
        })
        .from(contacts)
        .where(eq(contacts.id, contactId)),
    ).toEqual([
      {
        originatingAttorneyId: refused ? leaver.userId : null,
        responsibleAttorneyId: owner.userId,
      },
    ]);
    const history = await db
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, contactId));
    expect(history).toEqual(
      refused
        ? []
        : [
            expect.objectContaining({
              changes: {
                originatingAttorneyId: { old: leaver.userId, new: null },
              },
            }),
          ],
    );
  },
);
