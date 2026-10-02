import { panic } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { assignableRoles, roles } from "@stll/permissions";

import { invitation, member } from "@/api/db/auth-schema";
import { createAuth, getAuth } from "@/api/lib/auth";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { OWNER_REQUIRED_ERROR_CODE } from "@/api/lib/membership-role-invariants";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);
let testDb: TestDatabase;
const getTestDatabase = () => testDb;
beforeAll(async () => {
  testDb = await initAgentAuthTestDb();
});
afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const createOrganization = async () => {
  const owner = await signInHuman(
    `role-owner-${Bun.randomUUIDv7()}@stella.dev`,
  );
  const auth = getAuth();
  const organization = await auth.api.createOrganization({
    body: {
      name: "Membership roles",
      slug: `membership-roles-${Bun.randomUUIDv7()}`,
    },
    headers: owner.headers(),
  });
  await owner.setActiveOrganization(organization.id);
  return { auth, owner, organization };
};

describe("single membership roles", () => {
  for (const role of [
    ["admin", "member"],
    ["member"],
    ["admin", "admin"],
    "admin,member",
    " member ",
    "unrecognized-role",
  ]) {
    test(`refuses ${JSON.stringify(role)} on every membership write without persistence`, async () => {
      const { auth, owner, organization } = await createOrganization();
      const target = await signInHuman(
        `role-target-${Bun.randomUUIDv7()}@stella.dev`,
      );
      const added = await auth.api.addMember({
        body: {
          organizationId: organization.id,
          userId: target.userId,
          role: "member",
        },
        headers: owner.headers(),
      });
      const before = await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.id, added.id));
      const update = await auth.api.updateMemberRole({
        body: { organizationId: organization.id, memberId: added.id, role },
        headers: owner.headers(),
        asResponse: true,
      });
      expect(update.status).toBe(400);
      if (role !== "unrecognized-role") {
        expect(await update.json()).toMatchObject({
          code: "invalid_member_role",
        });
      }
      expect(
        await getTestDatabase()
          .select()
          .from(member)
          .where(eq(member.id, added.id)),
      ).toEqual(before);

      const newcomer = await signInHuman(
        `role-new-${Bun.randomUUIDv7()}@stella.dev`,
      );
      const add = await auth.api.addMember({
        body: {
          organizationId: organization.id,
          userId: newcomer.userId,
          role,
        },
        headers: owner.headers(),
        asResponse: true,
      });
      expect(add.status).toBe(400);
      expect(await add.json()).toMatchObject({ code: "invalid_member_role" });
      expect(
        await getTestDatabase()
          .select()
          .from(member)
          .where(
            and(
              eq(member.organizationId, organization.id),
              eq(member.userId, newcomer.userId),
            ),
          ),
      ).toEqual([]);

      const email = `role-invite-${Bun.randomUUIDv7()}@stella.dev`;
      const invite = await auth.api.createInvitation({
        body: { organizationId: organization.id, email, role },
        headers: owner.headers(),
        asResponse: true,
      });
      expect(invite.status).toBe(400);
      if (role !== "unrecognized-role") {
        expect(await invite.json()).toMatchObject({
          code: "invalid_member_role",
        });
      }
      expect(
        await getTestDatabase()
          .select()
          .from(invitation)
          .where(
            and(
              eq(invitation.organizationId, organization.id),
              eq(invitation.email, email),
            ),
          ),
      ).toEqual([]);
      expect(isMemberRole(before.at(0)?.role ?? "")).toBe(true);
    });
  }
});

const productRoles = Object.keys(roles).filter(isMemberRole);

describe("membership hook enforcement", () => {
  test("role updates and invitations apply the configured assignment policy beyond plugin grants", async () => {
    const { auth, owner, organization } = await createOrganization();
    const administrator = await signInHuman(
      `role-policy-admin-${Bun.randomUUIDv7()}@stella.dev`,
    );
    await auth.api.addMember({
      body: {
        organizationId: organization.id,
        userId: administrator.userId,
        role: "admin",
      },
      headers: owner.headers(),
    });
    await administrator.setActiveOrganization(organization.id);
    const target = await signInHuman(
      `role-policy-target-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const targetMember = await auth.api.addMember({
      body: {
        organizationId: organization.id,
        userId: target.userId,
        role: "member",
      },
      headers: owner.headers(),
    });
    const baselineUpdate = await auth.api.updateMemberRole({
      body: {
        organizationId: organization.id,
        memberId: targetMember.id,
        role: "admin",
      },
      headers: administrator.headers(),
      asResponse: true,
    });
    expect(baselineUpdate.status).toBe(200);
    await auth.api.updateMemberRole({
      body: {
        organizationId: organization.id,
        memberId: targetMember.id,
        role: "member",
      },
      headers: administrator.headers(),
    });
    const baselineEmail = `role-policy-baseline-${Bun.randomUUIDv7()}@stella.dev`;
    const baselineInvite = await auth.api.createInvitation({
      body: {
        organizationId: organization.id,
        email: baselineEmail,
        role: "admin",
      },
      headers: administrator.headers(),
      asResponse: true,
    });
    expect(baselineInvite.status).toBe(200);
    const before = await getTestDatabase()
      .select()
      .from(member)
      .where(eq(member.id, targetMember.id));
    const restrictedAuth = createAuth((actorRole) =>
      assignableRoles(actorRole).filter((targetRole) => targetRole !== "admin"),
    );
    expect(assignableRoles("admin")).toContain("admin");
    const update = await restrictedAuth.api.updateMemberRole({
      body: {
        organizationId: organization.id,
        memberId: targetMember.id,
        role: "admin",
      },
      headers: administrator.headers(),
      asResponse: true,
    });
    expect(update.status).toBe(403);
    expect(await update.json()).toMatchObject({
      code: "member_role_not_assignable",
    });
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.id, targetMember.id)),
    ).toEqual(before);
    const email = `role-policy-invite-${Bun.randomUUIDv7()}@stella.dev`;
    const invite = await restrictedAuth.api.createInvitation({
      body: { organizationId: organization.id, email, role: "admin" },
      headers: administrator.headers(),
      asResponse: true,
    });
    expect(invite.status).toBe(403);
    expect(await invite.json()).toMatchObject({
      code: "member_role_not_assignable",
    });
    expect(
      await getTestDatabase()
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organization.id),
            eq(invitation.email, email),
          ),
        ),
    ).toEqual([]);
  });

  test("the last-owner hook refuses after the plugin reads two owners and before the adapter writes", async () => {
    const { auth, owner, organization } = await createOrganization();
    const sibling = await signInHuman(
      `role-preflight-sibling-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const siblingMember = await auth.api.addMember({
      body: {
        organizationId: organization.id,
        userId: sibling.userId,
        role: "owner",
      },
      headers: owner.headers(),
    });
    const actorRows = await getTestDatabase()
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, organization.id),
          eq(member.userId, owner.userId),
        ),
      );
    const actorMember = actorRows.at(0);
    if (!actorMember) {
      panic("The assigning owner's membership was not persisted");
    }
    const context = await auth.$context;
    const originalFindMany = context.adapter.findMany;
    const originalUpdate = context.adapter.update;
    let pluginReadInterposed = false;
    let membershipWrites = 0;
    context.adapter.findMany = async <T>(
      args: Parameters<typeof originalFindMany>[0],
    ) => {
      const rows = await originalFindMany<T>(args);
      if (args.model === "member" && !pluginReadInterposed) {
        expect(rows).toHaveLength(2);
        pluginReadInterposed = true;
        await getTestDatabase()
          .update(member)
          .set({ role: "member" })
          .where(eq(member.id, siblingMember.id));
      }
      return rows;
    };
    context.adapter.update = async <T>(
      args: Parameters<typeof originalUpdate>[0],
    ) => {
      if (args.model === "member") {
        membershipWrites += 1;
      }
      return await originalUpdate<T>(args);
    };
    try {
      const response = await auth.api.updateMemberRole({
        body: {
          organizationId: organization.id,
          memberId: actorMember.id,
          role: "member",
        },
        headers: owner.headers(),
        asResponse: true,
      });
      expect(pluginReadInterposed).toBe(true);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: OWNER_REQUIRED_ERROR_CODE,
      });
      expect(membershipWrites).toBe(0);
      expect(
        await getTestDatabase()
          .select({ userId: member.userId, role: member.role })
          .from(member)
          .where(
            and(
              eq(member.organizationId, organization.id),
              eq(member.role, "owner"),
            ),
          ),
      ).toEqual([{ userId: owner.userId, role: "owner" }]);
    } finally {
      context.adapter.findMany = originalFindMany;
      context.adapter.update = originalUpdate;
    }
  });

  test("the adapter maps a last-owner trigger refusal after both preflights read two owners", async () => {
    const { auth, owner, organization } = await createOrganization();
    const sibling = await signInHuman(
      `role-trigger-sibling-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const siblingMember = await auth.api.addMember({
      body: {
        organizationId: organization.id,
        userId: sibling.userId,
        role: "owner",
      },
      headers: owner.headers(),
    });
    const actorRows = await getTestDatabase()
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, organization.id),
          eq(member.userId, owner.userId),
        ),
      );
    const actorMember = actorRows.at(0);
    if (!actorMember) {
      panic("The assigning owner's membership was not persisted");
    }
    const context = await auth.$context;
    const originalUpdate = context.adapter.update;
    let interposedWrite = false;
    context.adapter.update = async <T>(
      args: Parameters<typeof originalUpdate>[0],
    ) => {
      if (args.model === "member" && !interposedWrite) {
        expect(
          await getTestDatabase()
            .select()
            .from(member)
            .where(
              and(
                eq(member.organizationId, organization.id),
                eq(member.role, "owner"),
              ),
            ),
        ).toHaveLength(2);
        interposedWrite = true;
        await getTestDatabase()
          .update(member)
          .set({ role: "member" })
          .where(eq(member.id, siblingMember.id));
      }
      return await originalUpdate<T>(args);
    };
    try {
      const response = await auth.api.updateMemberRole({
        body: {
          organizationId: organization.id,
          memberId: actorMember.id,
          role: "member",
        },
        headers: owner.headers(),
        asResponse: true,
      });
      expect(interposedWrite).toBe(true);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: OWNER_REQUIRED_ERROR_CODE,
      });
      expect(
        await getTestDatabase()
          .select({ userId: member.userId, role: member.role })
          .from(member)
          .where(
            and(
              eq(member.organizationId, organization.id),
              eq(member.role, "owner"),
            ),
          ),
      ).toEqual([{ userId: owner.userId, role: "owner" }]);
    } finally {
      context.adapter.update = originalUpdate;
    }
  });
});

describe("membership assignment policy", () => {
  for (const actorRole of productRoles) {
    test(`${actorRole} submits exactly its offered single roles on add, invite and update`, async () => {
      const { auth, owner, organization } = await createOrganization();
      const actor =
        actorRole === "owner"
          ? owner
          : await signInHuman(`role-actor-${Bun.randomUUIDv7()}@stella.dev`);
      if (actorRole !== "owner") {
        await auth.api.addMember({
          body: {
            organizationId: organization.id,
            userId: actor.userId,
            role: actorRole,
          },
          headers: owner.headers(),
        });
        await actor.setActiveOrganization(organization.id);
      }
      const expected = assignableRoles(actorRole);
      const acceptedAdds: MemberRole[] = [];
      const acceptedInvites: MemberRole[] = [];
      const acceptedUpdates: MemberRole[] = [];
      for (const targetRole of productRoles) {
        const target = await signInHuman(
          `role-update-${Bun.randomUUIDv7()}@stella.dev`,
        );
        const existing = await auth.api.addMember({
          body: {
            organizationId: organization.id,
            userId: target.userId,
            role: "member",
          },
          headers: owner.headers(),
        });
        const before = await getTestDatabase()
          .select()
          .from(member)
          .where(eq(member.id, existing.id));
        const update = await auth.api.updateMemberRole({
          body: {
            organizationId: organization.id,
            memberId: existing.id,
            role: targetRole,
          },
          headers: actor.headers(),
          asResponse: true,
        });
        const allowed = expected.some((role) => role === targetRole);
        expect(update.status).toBe(allowed ? 200 : 403);
        const updatedRows = await getTestDatabase()
          .select()
          .from(member)
          .where(eq(member.id, existing.id));
        if (allowed) {
          acceptedUpdates.push(targetRole);
          expect(updatedRows.at(0)?.role).toBe(targetRole);
          expect(isMemberRole(updatedRows.at(0)?.role ?? "")).toBe(true);
        } else {
          expect(updatedRows).toEqual(before);
        }

        const newcomer = await signInHuman(
          `role-add-${Bun.randomUUIDv7()}@stella.dev`,
        );
        const add = await auth.api.addMember({
          body: {
            organizationId: organization.id,
            userId: newcomer.userId,
            role: targetRole,
          },
          headers: actor.headers(),
          asResponse: true,
        });
        expect(add.status).toBe(allowed ? 200 : 403);
        const newRows = await getTestDatabase()
          .select()
          .from(member)
          .where(
            and(
              eq(member.organizationId, organization.id),
              eq(member.userId, newcomer.userId),
            ),
          );
        if (allowed) {
          acceptedAdds.push(targetRole);
          expect(newRows).toHaveLength(1);
          expect(newRows.at(0)?.role).toBe(targetRole);
          expect(isMemberRole(newRows.at(0)?.role ?? "")).toBe(true);
        } else {
          expect(newRows).toEqual([]);
          expect(await add.json()).toMatchObject({
            code: "member_role_not_assignable",
          });
        }

        const invitee = await signInHuman(
          `role-invitee-${Bun.randomUUIDv7()}@stella.dev`,
        );
        const invite = await auth.api.createInvitation({
          body: {
            organizationId: organization.id,
            email: invitee.email,
            role: targetRole,
          },
          headers: actor.headers(),
          asResponse: true,
        });
        expect(invite.status).toBe(allowed ? 200 : 403);
        const invitations = await getTestDatabase()
          .select()
          .from(invitation)
          .where(
            and(
              eq(invitation.organizationId, organization.id),
              eq(invitation.email, invitee.email),
            ),
          );
        if (allowed) {
          acceptedInvites.push(targetRole);
          expect(invitations).toHaveLength(1);
          const savedInvitation = invitations.at(0);
          expect(savedInvitation?.role).toBe(targetRole);
          if (!savedInvitation) {
            panic("Accepted invitation was not persisted");
          }
          const accept = await auth.api.acceptInvitation({
            body: { invitationId: savedInvitation.id },
            headers: invitee.headers(),
            asResponse: true,
          });
          expect(accept.status).toBe(200);
          const joined = await getTestDatabase()
            .select()
            .from(member)
            .where(
              and(
                eq(member.organizationId, organization.id),
                eq(member.userId, invitee.userId),
              ),
            );
          expect(joined).toHaveLength(1);
          expect(joined.at(0)?.role).toBe(targetRole);
          expect(isMemberRole(joined.at(0)?.role ?? "")).toBe(true);
          await invitee.setActiveOrganization(organization.id);
        } else {
          expect(invitations).toEqual([]);
        }
      }
      expect(acceptedAdds).toEqual(expected);
      expect(acceptedInvites).toEqual(expected);
      expect(acceptedUpdates).toEqual(expected);
    });
  }

  test("member addition requires an authenticated assigning actor", async () => {
    const { auth, organization } = await createOrganization();
    const newcomer = await signInHuman(
      `role-unassigned-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const response = await auth.api.addMember({
      body: {
        organizationId: organization.id,
        userId: newcomer.userId,
        role: "member",
      },
      asResponse: true,
    });
    expect(response.status).toBe(401);
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, organization.id),
            eq(member.userId, newcomer.userId),
          ),
        ),
    ).toEqual([]);
  });

  test("member addition derives the assigning role from the target organization", async () => {
    const { auth, organization } = await createOrganization();
    const elsewhere = await createOrganization();
    const newcomer = await signInHuman(
      `role-other-org-${Bun.randomUUIDv7()}@stella.dev`,
    );
    const response = await auth.api.addMember({
      body: {
        organizationId: organization.id,
        userId: newcomer.userId,
        role: "member",
      },
      headers: elsewhere.owner.headers(),
      asResponse: true,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "member_role_not_assignable",
    });
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, organization.id),
            eq(member.userId, newcomer.userId),
          ),
        ),
    ).toEqual([]);
  });
});
