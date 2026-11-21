import { describe, expect, test } from "bun:test";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";

import { skillEditorChatSkill } from "./inspector-active-skill";
import { railChatOpenArgs, railChatSkill } from "./inspector-rail-chat.logic";

const decision: ActiveLegalDocument = {
  type: "decision",
  caseNumber: "Mfv.10127/2026/4",
  decisionId: "decision-1",
};

const statute: ActiveLegalDocument = {
  type: "statute",
  documentId: "statute-1",
  title: "Občanský zákoník",
};

describe("what the rail's new-chat button opens", () => {
  test("binds to the decision the main view is showing", () => {
    expect(railChatOpenArgs({ legalDocument: decision })).toEqual({
      activeLegalKey: "decision:decision-1",
    });
  });

  test("binds to the consolidation the main view is showing", () => {
    expect(railChatOpenArgs({ legalDocument: statute })).toEqual({
      activeLegalKey: "statute:statute-1",
    });
  });

  test("carries no label, so joining the document's thread cannot retitle it", () => {
    expect(railChatOpenArgs({ legalDocument: decision })).not.toHaveProperty(
      "label",
    );
  });

  test("opens an unbound chat where no legal document is on screen", () => {
    expect(railChatOpenArgs({})).toEqual({});
  });

  test("scopes the chat to the matter the rail is mounted in", () => {
    expect(railChatOpenArgs({ workspaceId: "matter-1" })).toEqual({
      workspaceId: "matter-1",
      contextMatterIds: ["matter-1"],
    });
  });

  test("carries the skill without a label, so the tab names it where it is drawn", () => {
    const skill = { skillName: "playbook-builder" };
    const args = railChatOpenArgs({
      activeSkill: skill,
      legalDocument: decision,
    });
    expect(args).toEqual({
      activeLegalKey: "decision:decision-1",
      activeSkill: skill,
    });
  });
});

describe("the skill a chat started from the rail is about", () => {
  const editedSkill = skillEditorChatSkill({
    name: "Lease review",
    skillId: "skill-1",
    slug: "lease-review",
  });
  const tabSkill = { skillName: "playbook-builder" };

  test("is the skill the main view's editor shows, named as its own button names it", () => {
    expect(
      railChatOpenArgs({
        activeSkill: railChatSkill({
          activeTabSkill: undefined,
          mainViewSkill: editedSkill,
        }),
      }),
    ).toEqual({
      activeSkill: {
        skillDisplayName: "Lease review",
        skillId: "skill-1",
        skillName: "lease-review",
      },
    });
  });

  test("follows the main view over a skill left open in the Inspector", () => {
    expect(
      railChatSkill({ activeTabSkill: tabSkill, mainViewSkill: editedSkill }),
    ).toBe(editedSkill);
  });

  test("falls back to the active tab's skill away from a skill editor", () => {
    expect(
      railChatSkill({ activeTabSkill: tabSkill, mainViewSkill: undefined }),
    ).toBe(tabSkill);
    expect(
      railChatSkill({ activeTabSkill: undefined, mainViewSkill: undefined }),
    ).toBeUndefined();
  });
});
