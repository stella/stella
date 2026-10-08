import { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";
import { beforeEach, describe, expect, test } from "bun:test";

import type { ChatTab } from "@/components/inspector/inspector-store-types";
import { buildMaximizeTabAction } from "@/components/inspector/maximize-tab";
import { useThreadActiveSkillStore } from "@/features/chat/thread-active-skill-store";
import { toChatThreadId } from "@/lib/chat-thread-ref";

const navigate: ReturnType<typeof useNavigate> = async () => undefined;

const chatTab = (fields: Partial<ChatTab> = {}): ChatTab => ({
  type: "chat",
  id: toChatThreadId("thread-1"),
  label: "Chat",
  contextMatterIds: [],
  ...fields,
});

const moveToMain = (tab: ChatTab) => {
  const action = buildMaximizeTabAction(tab, {
    activeOrganizationId: "org-1",
    navigate,
    queryClient: new QueryClient(),
  });
  expect(action).toBeDefined();
  action?.();
};

beforeEach(() => {
  useThreadActiveSkillStore.setState({ skills: {} });
});

describe("move a chat tab to the main view", () => {
  test("keeps the tab's skill for the thread it opens", () => {
    const activeSkill = {
      skillName: "playbook-builder",
      skillDisplayName: "Build a playbook",
    };
    moveToMain(chatTab({ workspaceId: "matter-1", activeSkill }));

    expect(useThreadActiveSkillStore.getState().skills).toEqual({
      "workspace:matter-1:thread-1": activeSkill,
    });
  });

  test("records nothing for a tab without a skill", () => {
    moveToMain(chatTab());

    expect(useThreadActiveSkillStore.getState().skills).toEqual({});
  });
});
