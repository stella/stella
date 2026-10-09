import { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";
import { beforeEach, describe, expect, test } from "bun:test";

import type { ChatTab } from "@/components/inspector/inspector-store-types";
import { buildMaximizeTabAction } from "@/components/inspector/maximize-tab";
import { chatThreadOptions } from "@/features/chat/queries";
import type { ChatThreadFetched } from "@/features/chat/queries";
import {
  getThreadActiveSkillKeyContext,
  useThreadActiveSkillStore,
} from "@/features/chat/thread-active-skill-store";
import { toChatThreadId } from "@/lib/chat-thread-ref";

const navigate: ReturnType<typeof useNavigate> = async () => undefined;

const chatTab = (fields: Partial<ChatTab> = {}): ChatTab => ({
  type: "chat",
  id: toChatThreadId("thread-1"),
  label: "Chat",
  contextMatterIds: [],
  ...fields,
});

const ACTIVE_ORGANIZATION_ID = "org-1";

const moveToMain = (tab: ChatTab, queryClient = new QueryClient()) => {
  const action = buildMaximizeTabAction(tab, {
    activeOrganizationId: ACTIVE_ORGANIZATION_ID,
    navigate,
    queryClient,
  });
  expect(action).toBeDefined();
  action?.();
};

const unsentThread = (): ChatThreadFetched => ({
  activeTurnId: null,
  attachedFiles: { fileCount: 0, files: [] },
  forkProvenance: { type: "none" },
  messages: [],
  olderCursor: null,
  contextMatterIds: [],
  lastActivityAt: null,
  threadRevision: null,
  threadExists: false,
  usedAnonymization: false,
  webSearchAvailable: false,
  webSearchEnabled: false,
  context: null,
  model: null,
  reasoningEffort: null,
});

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

  // An unsent skill chat's picked matters exist only in the tab, and the
  // page reads the thread under the key its stored skill selects.
  test("seeds a skill tab's picked matters under the key the page reads", () => {
    const threadRef = { scope: "global", threadId: chatTab().id } as const;
    const activeSkill = { skillName: "playbook-builder" };
    const queryClient = new QueryClient();
    const skillThreadKey = chatThreadOptions({
      activeOrganizationId: ACTIVE_ORGANIZATION_ID,
      context: { allowMissingThread: true, getActiveSkill: () => activeSkill },
      key: threadRef,
    }).queryKey;
    queryClient.setQueryData(skillThreadKey, unsentThread());

    moveToMain(chatTab({ activeSkill, contextMatterIds: ["m1"] }), queryClient);

    const pageThreadKey = chatThreadOptions({
      activeOrganizationId: ACTIVE_ORGANIZATION_ID,
      context: getThreadActiveSkillKeyContext(threadRef),
      key: threadRef,
    }).queryKey;
    expect(pageThreadKey).toEqual(skillThreadKey);
    expect(queryClient.getQueryData(pageThreadKey)?.contextMatterIds).toEqual([
      "m1",
    ]);
  });
});
