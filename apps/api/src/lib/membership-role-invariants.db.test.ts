import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { assignableRoles, roles } from "@stll/permissions";

import {
  invitation,
  member,
  organization as organizationTable,
  user,
} from "@/api/db/auth-schema";
import { getAuth } from "@/api/lib/auth";
import { createConfirmationOtp } from "@/api/lib/confirmation-otp";
import {
  ACCOUNT_DELETION_ERROR_CODE,
  verifyAndDeleteUser,
} from "@/api/lib/delete-account";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { OWNER_REQUIRED_ERROR_CODE } from "@/api/lib/membership-role-invariants";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { signInHuman } from "@/api/tests/helpers/human-session";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import {
  inviteMemberSchema,
  roleAssignmentOptions,
} from "../../../web/src/lib/organization/role-assignment.logic.ts";

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

describe("live organization ownership", () => {
  test("last-owner role changes and removal return typed refusals without persistence", async () => {
    const { auth, owner, organization } = await createOrganization();
    const before = await getTestDatabase()
      .select()
      .from(member)
      .where(eq(member.organizationId, organization.id));
    const ownerMember = before.at(0);
    if (!ownerMember) {
      panic("Organization creation did not persist its owner");
    }
    for (const role of productRoles.filter(
      (targetRole) => targetRole !== "owner",
    )) {
      const response = await auth.api.updateMemberRole({
        body: {
          organizationId: organization.id,
          memberId: ownerMember.id,
          role,
        },
        headers: owner.headers(),
        asResponse: true,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: OWNER_REQUIRED_ERROR_CODE,
      });
      expect(
        await getTestDatabase()
          .select()
          .from(member)
          .where(eq(member.organizationId, organization.id)),
      ).toEqual(before);
    }
    const removal = await auth.api.removeMember({
      body: { organizationId: organization.id, memberIdOrEmail: owner.email },
      headers: owner.headers(),
      asResponse: true,
    });
    expect(removal.status).toBe(400);
    expect(await removal.json()).toMatchObject({
      code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
    });
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toEqual(before);
  });

  test("organization deletion cascades its last owner through real auth", async () => {
    const { auth, owner, organization } = await createOrganization();
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toHaveLength(1);
    const deletion = await auth.api.deleteOrganization({
      body: { organizationId: organization.id },
      headers: owner.headers(),
      asResponse: true,
    });
    expect(deletion.status).toBe(200);
    expect(
      await getTestDatabase()
        .select()
        .from(organizationTable)
        .where(eq(organizationTable.id, organization.id)),
    ).toEqual([]);
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toEqual([]);
    expect(
      await getTestDatabase()
        .select()
        .from(user)
        .where(eq(user.id, owner.userId)),
    ).toHaveLength(1);
  });

  test("account deletion preserves its existing last-owner refusal and account", async () => {
    const { owner, organization } = await createOrganization();
    const beforeMembers = await getTestDatabase()
      .select()
      .from(member)
      .where(eq(member.organizationId, organization.id));
    const beforeUser = await getTestDatabase()
      .select()
      .from(user)
      .where(eq(user.id, owner.userId));
    const otp = await createConfirmationOtp({
      purpose: "delete-account",
      email: owner.email,
    });
    if (Result.isError(otp)) {
      panic(otp.error.message);
    }
    const deletion = await verifyAndDeleteUser(
      brandPersistedUserId(owner.userId),
      owner.email,
      otp.value,
    );
    expect(Result.isError(deletion)).toBe(true);
    if (Result.isOk(deletion)) {
      panic("A last owner's account deletion succeeded");
    }
    expect(deletion.error).toMatchObject({
      code: ACCOUNT_DELETION_ERROR_CODE.soleOwner,
      status: 400,
    });
    expect(
      await getTestDatabase()
        .select()
        .from(user)
        .where(eq(user.id, owner.userId)),
    ).toEqual(beforeUser);
    expect(
      await getTestDatabase()
        .select()
        .from(member)
        .where(eq(member.organizationId, organization.id)),
    ).toEqual(beforeMembers);
  });
});

describe("membership assignment policy", () => {
  test("role controls and form validation retain their shared source", () => {
    const logic = readFileSync(
      new URL(
        "../../../web/src/lib/organization/role-assignment.logic.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    const translations = readFileSync(
      new URL("../../../web/src/lib/organization/consts.ts", import.meta.url),
      "utf-8",
    );
    const schema = readFileSync(
      new URL("../../../web/src/lib/schema.ts", import.meta.url),
      "utf-8",
    );
    expect(logic).toContain(
      'import { assignableRoles } from "@stll/permissions"',
    );
    expect(logic).toContain("assignableRoles(actorRole)");
    expect(logic).not.toMatch(/picklist\(\s*\[/u);
    expect(translations).toMatch(/satisfies Record\s*<\s*Role,/u);
    expect(translations).not.toContain("ASSIGNABLE_ROLES");
    expect(schema).toContain("export const emailSchema");
    expect(schema).toContain("v.email()");
  });

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
      const offered = roleAssignmentOptions(actorRole).map(
        ({ value }) => value,
      );
      const formAccepted = productRoles.filter(
        (role) =>
          v.safeParse(inviteMemberSchema(actorRole), {
            email: "member@example.com",
            role,
          }).success,
      );
      expect(offered).toEqual(expected);
      expect(formAccepted).toEqual(expected);
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
      expect(acceptedAdds).toEqual(offered);
      expect(acceptedInvites).toEqual(formAccepted);
      expect(acceptedUpdates).toEqual(offered);
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
