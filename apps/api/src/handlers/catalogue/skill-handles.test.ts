import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { resolveCatalogueSkillHandleMaps } from "./skill-handles";

const userId = toSafeId<"user">("user-current");
const teamSkillId = toSafeId<"agentSkill">("skill-team");

describe("resolveCatalogueSkillHandleMaps", () => {
  test("gives members a chat id for enabled team skills without an edit handle", () => {
    const handles = resolveCatalogueSkillHandleMaps({
      canManageTeamSkills: false,
      rows: [
        {
          enabled: true,
          id: teamSkillId,
          origin: "bundled",
          scope: "team",
          slug: "review",
          userId: "user-owner",
        },
      ],
      userId,
    });

    expect(handles.installedSkillIdBySlug.get("review")).toBeUndefined();
    expect(handles.chatSkillIdBySlug.get("review")).toBe(teamSkillId);
    expect(handles.enabledBySlug.get("review")).toBe(true);
  });

  test("does not expose disabled bundled team skills as active chat context", () => {
    const handles = resolveCatalogueSkillHandleMaps({
      canManageTeamSkills: true,
      rows: [
        {
          enabled: false,
          id: teamSkillId,
          origin: "bundled",
          scope: "team",
          slug: "review",
          userId: "user-owner",
        },
      ],
      userId,
    });

    expect(handles.installedSkillIdBySlug.get("review")).toBe(teamSkillId);
    expect(handles.chatSkillIdBySlug.get("review")).toBeUndefined();
    expect(handles.enabledBySlug.get("review")).toBe(false);
  });

  test("allows disabled editable team skills as active chat context for managers", () => {
    const handles = resolveCatalogueSkillHandleMaps({
      canManageTeamSkills: true,
      rows: [
        {
          enabled: false,
          id: teamSkillId,
          origin: "authored",
          scope: "team",
          slug: "review",
          userId: "user-owner",
        },
      ],
      userId,
    });

    expect(handles.installedSkillIdBySlug.get("review")).toBe(teamSkillId);
    expect(handles.chatSkillIdBySlug.get("review")).toBe(teamSkillId);
    expect(handles.enabledBySlug.get("review")).toBe(false);
  });
});
