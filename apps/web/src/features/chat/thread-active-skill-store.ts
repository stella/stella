import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  isActiveSkillContext,
  type ActiveSkillChatContext,
} from "@/components/inspector/inspector-active-skill";
import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  followStorageOwner,
  userScopedStateStorage,
} from "@/lib/account/user-scoped-storage";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";

const MAX_THREAD_ACTIVE_SKILLS = 50;
const MAX_THREAD_KEY_LENGTH = 256;

/**
 * The skill a main-area chat runs with, kept per thread so a reload, a new
 * browser tab, or a move from the inspector keeps it. Only the chat page
 * reads it; inspector tabs carry their own skill.
 */
type PersistedThreadActiveSkillState = {
  /** Oldest first; a write moves its thread to the end. */
  skills: Record<string, ActiveSkillChatContext>;
};

type ThreadActiveSkillStore = PersistedThreadActiveSkillState & {
  setSkill: (threadKey: string, skill: ActiveSkillChatContext) => void;
};

const retainNewest = (
  entries: readonly (readonly [string, ActiveSkillChatContext])[],
): Record<string, ActiveSkillChatContext> =>
  Object.fromEntries(entries.slice(-MAX_THREAD_ACTIVE_SKILLS));

const readPersistedState = (
  persisted: unknown,
): PersistedThreadActiveSkillState => {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !("skills" in persisted) ||
    typeof persisted.skills !== "object" ||
    persisted.skills === null
  ) {
    return { skills: {} };
  }
  const valid: [string, ActiveSkillChatContext][] = [];
  for (const [threadKey, skill] of Object.entries(persisted.skills)) {
    if (
      threadKey.length <= MAX_THREAD_KEY_LENGTH &&
      isActiveSkillContext(skill)
    ) {
      valid.push([threadKey, skill]);
    }
  }
  return { skills: retainNewest(valid) };
};

export const useThreadActiveSkillStore = create<ThreadActiveSkillStore>()(
  persist(
    (set) => ({
      skills: {},
      setSkill: (threadKey, skill) => {
        set((state) => {
          const retained = Object.entries(state.skills).filter(
            ([key]) => key !== threadKey,
          );
          retained.push([threadKey, skill]);
          return { skills: retainNewest(retained) };
        });
      },
    }),
    {
      name: "stella.chat.threadActiveSkill",
      storage: createJSONStorage(() =>
        userScopedStateStorage(browserStateStorage("local")),
      ),
      partialize: ({ skills }) => ({ skills }),
      version: 1,
      merge: (persisted, current) => ({
        ...current,
        ...readPersistedState(persisted),
      }),
    },
  ),
);

followStorageOwner(useThreadActiveSkillStore);

export const setThreadActiveSkill = (
  threadRef: ChatThreadRef,
  skill: ActiveSkillChatContext,
): void => {
  useThreadActiveSkillStore
    .getState()
    .setSkill(getChatThreadKey(threadRef), skill);
};

export const useThreadActiveSkill = (
  threadRef: ChatThreadRef,
): ActiveSkillChatContext | undefined => {
  const threadKey = getChatThreadKey(threadRef);
  return useThreadActiveSkillStore((state) => state.skills[threadKey]);
};
