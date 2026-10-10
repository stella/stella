import { afterAll, beforeAll, expect, test, setDefaultTimeout } from "bun:test";
import { and, eq } from "drizzle-orm";

import { apikey, member, session } from "@/api/db/auth-schema";
import {
  auditLogs,
  contacts,
  entities,
  flowRuns,
  flowRunSteps,
  taskAssignees,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { getAuth, resolveMemberAuthorization } from "@/api/lib/auth";
import { canApproveAssignedTimeEntry } from "@/api/lib/billing/time-entry-authorization";
import { createSafeId } from "@/api/lib/branded-types";
import { TASK_STATUS } from "@/api/lib/entity-constants";
import { MACHINE_API_KEY_CONFIG_ID } from "@/api/lib/machine-api-key-config";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
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
        organizationId: brandPersistedOrganizationId(org.id),
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
        organizationId: brandPersistedOrganizationId(otherOrg.id),
        userId: leaver.userId,
        role: "member",
      },
      headers: owner.headers(),
    });
    const otherWorkspaceId = createSafeId<"workspace">();
    const otherTaskId = createSafeId<"entity">();
    await db.insert(workspaces).values({
      id: otherWorkspaceId,
      organizationId: brandPersistedOrganizationId(otherOrg.id),
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
      organizationId: brandPersistedOrganizationId(org.id),
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
    const runId = createSafeId<"flowRun">();
    await db.insert(flowRuns).values({
      id: runId,
      workspaceId: coassigned.workspaceId,
      status: "awaiting_review",
      definitionSnapshot: {
        name: "Assignment review",
        steps: [{ kind: "review-gate", name: "Review", instructions: "" }],
      },
      triggerSource: { type: "manual", userId: leaver.userId },
    });
    const stepId = createSafeId<"flowRunStep">();
    await db.insert(flowRunSteps).values({
      id: stepId,
      workspaceId: coassigned.workspaceId,
      runId,
      index: 0,
      kind: "review-gate",
      status: "awaiting_review",
    });
    const headers = owner.headers();
    headers.set("content-type", "application/json");
    headers.set("origin", "http://localhost:3001");
    const response = await auth.handler(
      new Request("http://localhost:3001/api/auth/organization/remove-member", {
        method: "POST",
        headers,
        body: JSON.stringify({
          organizationId: brandPersistedOrganizationId(org.id),
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
    expect(
      await db
        .select({ status: flowRuns.status })
        .from(flowRuns)
        .where(eq(flowRuns.id, runId)),
    ).toEqual([{ status: refused ? "awaiting_review" : "cancelled" }]);
    const runAudits = await db
      .select({
        changes: auditLogs.changes,
        workspaceId: auditLogs.workspaceId,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, runId));
    // The owner audits each step transition separately from its run transition.
    expect(runAudits).toHaveLength(refused ? 0 : 2);
    expect(runAudits).toEqual(
      refused
        ? []
        : expect.arrayContaining([
            {
              workspaceId: coassigned.workspaceId,
              changes: {
                stepStatus: { old: "awaiting_review", new: "skipped" },
              },
              metadata: { cause: "membership_removed", stepId },
            },
            {
              workspaceId: coassigned.workspaceId,
              changes: { status: { old: "awaiting_review", new: "cancelled" } },
              metadata: { cause: "membership_removed" },
            },
          ]),
    );
    const membershipAudit = await db
      .select({ metadata: auditLogs.metadata, userId: auditLogs.userId })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, org.id));
    expect(
      membershipAudit.filter(
        ({ metadata }) => metadata?.["change"] === "member-removed",
      ),
    ).toEqual(
      refused
        ? []
        : [
            {
              userId: owner.userId,
              metadata: {
                change: "member-removed",
                memberId: added.id,
                userId: leaver.userId,
              },
            },
          ],
    );
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

const removeMemberRequest = (
  headers: Headers,
  body: Record<string, unknown>,
) => {
  headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost:3001");
  return new Request(
    "http://localhost:3001/api/auth/organization/remove-member",
    { method: "POST", headers, body: JSON.stringify(body) },
  );
};

test("a re-invited member returns without credentials, matters or approvals", async () => {
  const owner = await signInHuman(
    `rejoin-owner-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const leaver = await signInHuman(
    `rejoin-leaver-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const auth = getAuth();
  const org = await auth.api.createOrganization({
    body: { name: "Rejoin fixture", slug: `rejoin-${Bun.randomUUIDv7()}` },
    headers: owner.headers(),
  });
  const organizationId = brandPersistedOrganizationId(org.id);
  const leaverId = brandPersistedUserId(leaver.userId);
  const added = await auth.api.addMember({
    body: { organizationId: org.id, userId: leaver.userId, role: "member" },
    headers: owner.headers(),
  });
  await leaver.setActiveOrganization(org.id);
  const workspaceId = createSafeId<"workspace">();
  const openTaskId = createSafeId<"entity">();
  const doneTaskId = createSafeId<"entity">();
  const entryId = createSafeId<"timeEntry">();
  const apiKeyId = Bun.randomUUIDv7();
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: brandPersistedOrganizationId(org.id),
    name: "Rejoin matter",
    reference: workspaceId,
    leadUserId: leaver.userId,
  });
  await db
    .insert(workspaceMembers)
    .values(
      [owner.userId, leaver.userId].map((userId) => ({ workspaceId, userId })),
    );
  await db.insert(entities).values([
    {
      id: openTaskId,
      workspaceId,
      kind: "task",
      name: "Open work",
      status: TASK_STATUS.IN_PROGRESS,
    },
    {
      id: doneTaskId,
      workspaceId,
      kind: "task",
      name: "Finished work",
      status: TASK_STATUS.DONE,
    },
  ]);
  await db.insert(taskAssignees).values(
    [openTaskId, doneTaskId].map((entityId) => ({
      entityId,
      workspaceId,
      userId: leaver.userId,
      role: "assignee" as const,
    })),
  );
  await db.insert(timeEntries).values({
    id: entryId,
    organizationId,
    workspaceId,
    userId: owner.userId,
    approverUserId: leaver.userId,
    dateWorked: new Date().toISOString().slice(0, 10),
    timezoneId: "UTC",
    durationMinutes: 30,
    billedMinutes: 30,
    rateAtEntry: cents(10_000),
    currency: "EUR",
    narrative: "Drafted the brief",
  });
  await db.insert(apikey).values({
    id: apiKeyId,
    configId: MACHINE_API_KEY_CONFIG_ID,
    key: `rejoin-${apiKeyId}`,
    referenceId: leaver.userId,
    metadata: JSON.stringify({ organizationId: org.id }),
  });
  const outsider = await auth.handler(
    removeMemberRequest(owner.headers(), {
      organizationId: brandPersistedOrganizationId(org.id),
      memberIdOrEmail: added.id,
      reassign_to: `not-${leaver.userId}`,
    }),
  );
  expect(outsider.status).toBe(400);
  expect(await outsider.json()).toMatchObject({
    message: "User is not a member of this organization",
  });
  expect(await db.$count(member, eq(member.id, added.id))).toBe(1);

  const removed = await auth.handler(
    removeMemberRequest(owner.headers(), {
      organizationId: brandPersistedOrganizationId(org.id),
      memberIdOrEmail: added.id,
      reassign_to: owner.userId,
    }),
  );
  expect(removed.status).toBe(200);
  const reinvited = await auth.api.addMember({
    body: { organizationId: org.id, userId: leaver.userId, role: "member" },
    headers: owner.headers(),
  });
  expect(reinvited.id).not.toBe(added.id);

  // Credentials of the first membership stay ended after the second begins.
  expect(
    await auth.api.getSession({
      headers: leaver.headers(),
      query: { disableCookieCache: true },
    }),
  ).toBeNull();
  expect(
    await db.$count(
      session,
      and(
        eq(session.userId, leaver.userId),
        eq(session.activeOrganizationId, org.id),
      ),
    ),
  ).toBe(0);
  expect(
    await db
      .select({ enabled: apikey.enabled })
      .from(apikey)
      .where(eq(apikey.id, apiKeyId)),
  ).toEqual([{ enabled: false }]);

  // The authorization layer grants the rejoined member no matter access.
  const authorization = await resolveMemberAuthorization(
    { organizationId, userId: leaverId, workspaceId },
    db,
  );
  expect(authorization).toMatchObject({ role: "member", workspace: null });

  // Pending approval went back to the approver pool, with history kept.
  const [entry] = await db
    .select({ approverUserId: timeEntries.approverUserId })
    .from(timeEntries)
    .where(eq(timeEntries.id, entryId));
  expect(entry).toEqual({ approverUserId: null });
  expect(
    canApproveAssignedTimeEntry({
      memberRole: sessionMemberRole("member"),
      currentUserId: leaverId,
      approverUserId: entry?.approverUserId ?? null,
    }),
  ).toBe(false);
  expect(
    await db
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, entryId)),
  ).toEqual([
    expect.objectContaining({
      changes: { approverUserId: { old: leaver.userId, new: null } },
    }),
  ]);

  // Open work moved; finished work keeps its former assignee as history.
  const assignments = await db
    .select({ entityId: taskAssignees.entityId, userId: taskAssignees.userId })
    .from(taskAssignees)
    .where(eq(taskAssignees.workspaceId, workspaceId));
  expect(assignments).toHaveLength(2);
  expect(assignments).toEqual(
    expect.arrayContaining([
      { entityId: openTaskId, userId: owner.userId },
      { entityId: doneTaskId, userId: leaver.userId },
    ]),
  );
  expect(
    await db
      .select({ lead: workspaces.leadUserId })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId)),
  ).toEqual([{ lead: null }]);
});
