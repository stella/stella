import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  isActiveSkillContext,
  type ActiveSkillChatContext,
} from "@/components/inspector/inspector-active-skill";
import type { ChatThreadOptionsContext } from "@/features/chat/chat-query-contract";
import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  followStorageOwner,
  userScopedStateStorage,
} from "@/lib/account/user-scoped-storage";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { getChatThreadKey } from "@/lib/chat-thread-ref";

/** The built-in skill that interviews a user and saves a playbook. */
export const PLAYBOOK_BUILDER_SKILL_NAME = "playbook-builder";

const MAX_THREAD_ACTIVE_SKILLS = 50;
const MAX_THREAD_KEY_LENGTH = 256;

/**
 * Cached skill selections for drafts and inspector handoffs. Existing
 * threads restore their authoritative skill from the server.
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

const keyContext = (
  skill: ActiveSkillChatContext | undefined,
): ChatThreadOptionsContext => ({
  allowMissingThread: true,
  ...(skill ? { getActiveSkill: () => skill } : {}),
});

/**
 * The key-shape context the chat page reads this thread under: a stored
 * skill adds `getActiveSkill`, which changes the thread query's
 * `contextKind`. Loaders, cache seeds and sibling readers build their key
 * from this so it matches the page's; it carries no other live getters.
 */
export const getThreadActiveSkillKeyContext = (
  threadRef: ChatThreadRef,
): ChatThreadOptionsContext =>
  keyContext(
    useThreadActiveSkillStore.getState().skills[getChatThreadKey(threadRef)],
  );

/** `getThreadActiveSkillKeyContext` for a component, following the store. */
export const useThreadActiveSkillKeyContext = (
  threadRef: ChatThreadRef,
): ChatThreadOptionsContext => keyContext(useThreadActiveSkill(threadRef));

/** A persisted thread always wins over a cached draft selection. */
export const resolveThreadActiveSkill = (
  thread: { threadExists: boolean; activeSkill: ActiveSkillChatContext | null },
  cachedSkill: ActiveSkillChatContext | undefined,
): ActiveSkillChatContext | undefined =>
  thread.threadExists ? (thread.activeSkill ?? undefined) : cachedSkill;
