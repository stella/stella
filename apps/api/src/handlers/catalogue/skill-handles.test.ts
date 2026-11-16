import { describe, expect, test } from "bun:test";

import { UNBOUND } from "@/api/lib/agent-skills/binding";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";

import { resolveCatalogueSkillHandleMaps } from "./skill-handles";

const userId = toSafeId<"user">("user-current");
const teamSkillId = toSafeId<"agentSkill">("skill-team");

describe("resolveCatalogueSkillHandleMaps", () => {
  test("gives members a chat id for enabled team skills without an edit handle", () => {
    const handles = resolveCatalogueSkillHandleMaps({
      memberRole: sessionMemberRole("member"),
      rows: [
        {
          ...UNBOUND,
          enabled: true,
          id: teamSkillId,
          invocation: "auto",
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
      memberRole: sessionMemberRole("admin"),
      rows: [
        {
          ...UNBOUND,
          enabled: false,
          id: teamSkillId,
          invocation: "auto",
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
      memberRole: sessionMemberRole("admin"),
      rows: [
        {
          ...UNBOUND,
          enabled: false,
          id: teamSkillId,
          invocation: "auto",
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
