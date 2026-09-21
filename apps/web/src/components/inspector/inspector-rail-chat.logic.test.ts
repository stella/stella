import { describe, expect, test } from "bun:test";

import type { ActiveLegalDocument } from "@/components/ai-suggestions/active-legal-document";

import { railChatOpenArgs } from "./inspector-rail-chat.logic";

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

  test("keeps naming the skill the reader picked, over the document they stand on", () => {
    expect(
      railChatOpenArgs({
        activeSkill: { skillName: "Redline" },
        legalDocument: decision,
      }),
    ).toEqual({
      activeLegalKey: "decision:decision-1",
      activeSkill: { skillName: "Redline" },
      label: "Redline",
    });
  });
});
