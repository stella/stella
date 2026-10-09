import { panic } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import { listSkillMetadata } from "@stll/skills";

import type { ChatThreadOptionsContext } from "@/features/chat/chat-query-contract";
import { chatThreadOptions } from "@/features/chat/queries";
import {
  getThreadActiveSkillKeyContext,
  PLAYBOOK_BUILDER_SKILL_NAME,
  setThreadActiveSkill,
  useThreadActiveSkillStore,
} from "@/features/chat/thread-active-skill-store";
import { getChatThreadKey, toChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";

const globalThread = (threadId: string): ChatThreadRef => ({
  scope: "global",
  threadId: toChatThreadId(threadId),
});

const SKILL = { skillName: "playbook-builder" };

const mergeStored = (persisted: unknown) => {
  const { merge } = useThreadActiveSkillStore.persist.getOptions();
  if (merge === undefined) {
    return panic("The store has no merge");
  }
  return merge(persisted, useThreadActiveSkillStore.getInitialState());
};

beforeEach(() => {
  useThreadActiveSkillStore.setState({ skills: {} });
});

describe("thread active skill store", () => {
  test("keeps a valid stored skill and drops corrupt entries", () => {
    const { skills } = mergeStored({
      skills: {
        "global:kept": {
          skillName: "playbook-builder",
          skillDisplayName: "Build a playbook",
        },
        "global:no-name": { skillDisplayName: "Build a playbook" },
        "global:bad-id": { skillName: "x", skillId: 42 },
        "global:not-an-object": "playbook-builder",
        ["k".repeat(300)]: SKILL,
      },
    });

    expect(skills).toEqual({
      "global:kept": {
        skillName: "playbook-builder",
        skillDisplayName: "Build a playbook",
      },
    });
  });

  test("reads anything that is not the stored shape as no skills", () => {
    for (const persisted of [null, "x", { skills: null }, { skills: "x" }]) {
      expect(mergeStored(persisted).skills).toEqual({});
    }
  });

  test("keeps the 50 most recently written threads", () => {
    for (let index = 0; index < 51; index += 1) {
      setThreadActiveSkill(globalThread(`thread-${index}`), SKILL);
    }
    setThreadActiveSkill(globalThread("thread-1"), SKILL);
    setThreadActiveSkill(globalThread("thread-51"), SKILL);

    const keys = Object.keys(useThreadActiveSkillStore.getState().skills);
    expect(keys).toHaveLength(50);
    expect(keys).not.toContain(getChatThreadKey(globalThread("thread-0")));
    expect(keys).not.toContain(getChatThreadKey(globalThread("thread-2")));
    expect(keys).toContain(getChatThreadKey(globalThread("thread-1")));
    expect(keys.at(-1)).toBe(getChatThreadKey(globalThread("thread-51")));
  });

  test("a stored list over the cap keeps its newest entries", () => {
    const stored = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`global:t-${index}`, SKILL]),
    );
    const keys = Object.keys(mergeStored({ skills: stored }).skills);
    expect(keys).toHaveLength(50);
    expect(keys.at(0)).toBe("global:t-10");
  });
});

describe("the key context of a thread", () => {
  const threadRef = globalThread("thread-1");
  const queryKey = (context: ChatThreadOptionsContext) =>
    chatThreadOptions({
      activeOrganizationId: "org-1",
      context,
      key: threadRef,
    }).queryKey;

  // The chat page keys its thread query by the live getters it mounts
  // with; a loader or cache seed must land on that same key.
  test("matches the page's key for a thread with a stored skill", () => {
    setThreadActiveSkill(threadRef, SKILL);
    const pageKey = queryKey({
      allowMissingThread: true,
      getActiveSkill: () => SKILL,
    });

    expect(pageKey).not.toEqual(queryKey({ allowMissingThread: true }));
    expect(queryKey(getThreadActiveSkillKeyContext(threadRef))).toEqual(
      pageKey,
    );
  });

  test("matches the plain key for a thread without one", () => {
    expect(queryKey(getThreadActiveSkillKeyContext(threadRef))).toEqual(
      queryKey({ allowMissingThread: true }),
    );
  });
});

test("the playbook builder's name names a shipped built-in skill", () => {
  expect(listSkillMetadata().map(({ name }) => name)).toContain(
    PLAYBOOK_BUILDER_SKILL_NAME,
  );
});
