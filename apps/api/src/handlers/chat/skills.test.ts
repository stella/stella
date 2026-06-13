import { describe, expect, test } from "bun:test";

import { canEditActiveSkill } from "@/api/handlers/chat/skills";
import { toSafeId } from "@/api/lib/branded-types";

const userId = toSafeId<"user">("user_1");

describe("canEditActiveSkill", () => {
  test("requires agent skill update permission for private owned skills", () => {
    expect(
      canEditActiveSkill({
        memberRole: { role: "intern" },
        origin: "authored",
        scope: "private",
        skillUserId: userId,
        userId,
      }),
    ).toBe(false);

    expect(
      canEditActiveSkill({
        memberRole: { role: "member" },
        origin: "authored",
        scope: "private",
        skillUserId: userId,
        userId,
      }),
    ).toBe(true);
  });

  test("keeps team skills limited to owners and admins", () => {
    expect(
      canEditActiveSkill({
        memberRole: { role: "member" },
        origin: "authored",
        scope: "team",
        skillUserId: "other_user",
        userId,
      }),
    ).toBe(false);

    expect(
      canEditActiveSkill({
        memberRole: { role: "admin" },
        origin: "authored",
        scope: "team",
        skillUserId: "other_user",
        userId,
      }),
    ).toBe(true);
  });
});
