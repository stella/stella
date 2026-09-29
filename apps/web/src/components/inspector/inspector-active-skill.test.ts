import { describe, expect, test } from "bun:test";

import { getActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";

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

  test("names a built-in skill resource tab without a skill id", () => {
    const tab = {
      type: "skill-resource",
      id: "skill-resource:summarize/SKILL.md",
      label: "SKILL.md",
      skillName: "summarize",
      skillId: null,
      origin: "built-in",
      target: "body",
      resourcePath: "SKILL.md",
      mimeType: "text/markdown",
      content: "# Summarize",
    } satisfies InspectorTab;

    expect(getActiveSkillChatContext(tab)).toEqual({ skillName: "summarize" });
  });

  test("carries a built-in skill's title beside its slug", () => {
    const tab = {
      type: "skill-resource",
      id: "skill-resource:playbook-builder/SKILL.md",
      label: "SKILL.md",
      skillName: "playbook-builder",
      skillDisplayName: "Build a playbook",
      skillId: null,
      origin: "built-in",
      target: "body",
      resourcePath: "SKILL.md",
      mimeType: "text/markdown",
      content: "# Build a playbook",
    } satisfies InspectorTab;

    expect(getActiveSkillChatContext(tab)).toEqual({
      skillDisplayName: "Build a playbook",
      skillName: "playbook-builder",
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

  test("uses live catalogue state for skill detail tabs", () => {
    const tab = {
      type: "view",
      viewType: "tool-detail",
      id: "tool-detail:skill:review",
      label: "Review Skill",
      payload: {
        kind: "skill",
        slug: "review",
        organizationId: "org-1",
        iconHint: {
          icon: null,
          iconUrl: null,
        },
      },
      ownerRouteId: "/_protected/knowledge/tools",
    } satisfies InspectorTab;

    expect(
      getActiveSkillChatContext(tab, [
        {
          chatSkillId: "skill-live",
          displayName: "Review Skill",
          kind: "skill",
          slug: "review",
        },
      ]),
    ).toEqual({
      skillDisplayName: "Review Skill",
      skillId: "skill-live",
      skillName: "review",
    });
  });

  test("drops stale skill detail payload when live catalogue state is no longer chat-readable", () => {
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
          skillId: "skill-stale",
          skillName: "Review Skill",
        },
        iconHint: {
          icon: null,
          iconUrl: null,
        },
      },
      ownerRouteId: "/_protected/knowledge/tools",
    } satisfies InspectorTab;

    expect(
      getActiveSkillChatContext(tab, [
        {
          chatSkillId: null,
          displayName: "Review Skill",
          kind: "skill",
          slug: "review",
        },
      ]),
    ).toBeUndefined();
  });

  test("ignores a stored skill detail payload without a skill id", () => {
    const tab = {
      type: "view",
      viewType: "tool-detail",
      id: "tool-detail:skill:review",
      label: "Review Skill",
      payload: {
        kind: "skill",
        slug: "review",
        organizationId: "org-1",
        activeSkill: { skillName: "Review Skill" },
        iconHint: {
          icon: null,
          iconUrl: null,
        },
      },
      ownerRouteId: "/_protected/knowledge/tools",
    } satisfies InspectorTab;

    expect(getActiveSkillChatContext(tab)).toBeUndefined();
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
