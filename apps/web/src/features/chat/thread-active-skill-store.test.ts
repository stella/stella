import { panic } from "better-result";
import { beforeEach, describe, expect, test } from "bun:test";

import {
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
