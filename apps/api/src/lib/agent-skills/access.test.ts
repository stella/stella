import { expect, expectTypeOf, test } from "bun:test";

import {
  canEditActiveSkill,
  canManageSkill,
} from "@/api/lib/agent-skills/access";
import { UNBOUND } from "@/api/lib/agent-skills/binding";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";

const authorId = toSafeId<"user">("skill-author");
const otherId = toSafeId<"user">("other-author");
const matterId = toSafeId<"workspace">("0199a1b2-0000-7000-8000-00000000000a");
const clientId = toSafeId<"contact">("0199a1b2-0000-7000-8000-0000000000c1");

test("management and active edit decisions require both binding fields", () => {
  type ManagedSkill = Parameters<typeof canManageSkill>[0]["skill"];
  type ActiveSkill = Parameters<typeof canEditActiveSkill>[0];
  expectTypeOf<
    Omit<ManagedSkill, "boundClientId">
  >().not.toExtend<ManagedSkill>();
  expectTypeOf<
    Omit<ManagedSkill, "boundWorkspaceId">
  >().not.toExtend<ManagedSkill>();
  expectTypeOf<
    Omit<ActiveSkill, "boundClientId">
  >().not.toExtend<ActiveSkill>();
  expectTypeOf<
    Omit<ActiveSkill, "boundWorkspaceId">
  >().not.toExtend<ActiveSkill>();
});

const cases = [
  {
    name: "a member edits their matter-bound team skill",
    binding: { boundClientId: null, boundWorkspaceId: matterId },
    expected: true,
    role: "member",
    scope: "team",
    skillUserId: authorId,
  },
  {
    name: "a member cannot edit another author's matter-bound team skill",
    binding: { boundClientId: null, boundWorkspaceId: matterId },
    expected: false,
    role: "member",
    scope: "team",
    skillUserId: otherId,
  },
  {
    name: "a member cannot edit their unbound team skill",
    binding: UNBOUND,
    expected: false,
    role: "member",
    scope: "team",
    skillUserId: authorId,
  },
  {
    name: "a demoted author cannot edit their private client-bound skill",
    binding: { boundClientId: clientId, boundWorkspaceId: null },
    expected: false,
    role: "member",
    scope: "private",
    skillUserId: authorId,
  },
  {
    name: "an admin author edits their private client-bound skill",
    binding: { boundClientId: clientId, boundWorkspaceId: null },
    expected: true,
    role: "admin",
    scope: "private",
    skillUserId: authorId,
  },
  {
    name: "an admin cannot edit another author's private client-bound skill",
    binding: { boundClientId: clientId, boundWorkspaceId: null },
    expected: false,
    role: "admin",
    scope: "private",
    skillUserId: otherId,
  },
] as const;

for (const { name, binding, expected, role, scope, skillUserId } of cases) {
  test(name, () => {
    const memberRole = sessionMemberRole(role);
    expect(
      canManageSkill({
        memberRole,
        skill: { ...binding, scope, userId: skillUserId },
        spends: "update",
        userId: authorId,
      }),
    ).toBe(expected);
    expect(
      canEditActiveSkill({
        ...binding,
        memberRole,
        origin: "authored",
        scope,
        skillUserId,
        userId: authorId,
      }),
    ).toBe(expected);
  });
}
