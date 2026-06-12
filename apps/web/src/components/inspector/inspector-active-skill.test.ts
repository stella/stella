import { describe, expect, test } from "bun:test";

import { getActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import type { InspectorTab } from "@/components/inspector/inspector-store";

describe("getActiveSkillChatContext", () => {
  test("extracts active skill context from a skill resource tab", () => {
    const tab = {
      type: "skill-resource",
      id: "skill-resource:review/SKILL.md",
      label: "SKILL.md",
      skillName: "Review Skill",
      skillId: "skill-1",
      origin: "authored",
      target: "body",
      resourcePath: "SKILL.md",
      mimeType: "text/markdown",
      content: "# Review Skill",
    } satisfies InspectorTab;

    expect(getActiveSkillChatContext(tab)).toEqual({
      skillId: "skill-1",
      skillName: "Review Skill",
    });
  });

  test("extracts active skill context from a skill catalogue detail tab", () => {
    const tab = {
      type: "view",
      viewType: "tool-detail",
      id: "tool-detail:skill:review",
      label: "Review Skill",
      payload: {
        kind: "skill",
        slug: "review",
        organizationId: "org-1",
        activeSkill: {
          skillId: "skill-1",
          skillName: "Review Skill",
        },
        iconHint: {
          icon: null,
          iconUrl: null,
        },
      },
      ownerRouteId: "/_protected/knowledge/tools",
    } satisfies InspectorTab;

    expect(getActiveSkillChatContext(tab)).toEqual({
      skillId: "skill-1",
      skillName: "Review Skill",
    });
  });

  test("ignores non-skill catalogue detail tabs", () => {
    const tab = {
      type: "view",
      viewType: "tool-detail",
      id: "tool-detail:mcp:connector",
      label: "Connector",
      payload: {
        kind: "mcp",
        slug: "connector",
        organizationId: "org-1",
        iconHint: {
          icon: null,
          iconUrl: null,
        },
      },
      ownerRouteId: "/_protected/knowledge/tools",
    } satisfies InspectorTab;

    expect(getActiveSkillChatContext(tab)).toBeUndefined();
  });
});
