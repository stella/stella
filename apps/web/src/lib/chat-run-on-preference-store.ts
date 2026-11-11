import * as v from "valibot";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type ChatRunTarget,
  chatRunTargetSchema,
} from "@stll/api-contract/chat-run-target";

import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  followStorageOwner,
  userScopedStateStorage,
} from "@/lib/account/user-scoped-storage";

/** Longer than any organization id: such a key names none. */
const ORGANIZATION_ID_MAX_LENGTH = 64;

type PersistedRunOnPreference = {
  /** The member's last Run on choice in each organization they chat in. */
  byOrganization: Record<string, ChatRunTarget>;
};

type ChatRunOnPreferenceStore = PersistedRunOnPreference & {
  remember: (organizationId: string, target: ChatRunTarget) => void;
};

/** Typed `unknown` on purpose: it reads stored JSON. */
const readPersistedState = (persisted: unknown): PersistedRunOnPreference => {
  if (
    typeof persisted !== "object" ||
    persisted === null ||
    !("byOrganization" in persisted) ||
    typeof persisted.byOrganization !== "object" ||
    persisted.byOrganization === null
  ) {
    return { byOrganization: {} };
  }
  return {
    byOrganization: Object.fromEntries(
      Object.entries(persisted.byOrganization).flatMap(
        ([organizationId, target]) => {
          const parsed = v.safeParse(chatRunTargetSchema, target);
          return organizationId.length <= ORGANIZATION_ID_MAX_LENGTH &&
            parsed.success
            ? [[organizationId, parsed.output]]
            : [];
        },
      ),
    ),
  };
};

/**
 * The member's last Run on choice, per organization, which a new chat starts
 * from: stella cloud, or a harness and model on their computer. Kept in the
 * browser for this member alone, as the web-search default is; each chat
 * stores its own choice on its row, and this only seeds a chat that has none.
 */
export const useChatRunOnPreferenceStore = create<ChatRunOnPreferenceStore>()(
  persist(
    (set) => ({
      byOrganization: {},
      remember: (organizationId, target) => {
        set((state) => ({
          byOrganization: { ...state.byOrganization, [organizationId]: target },
        }));
      },
    }),
    {
      name: "stella.chat.runOnPreference",
      storage: createJSONStorage(() =>
        userScopedStateStorage(browserStateStorage("local")),
      ),
      partialize: ({ byOrganization }) => ({ byOrganization }),
      version: 1,
      migrate: (persisted) => readPersistedState(persisted),
      merge: (persisted, current) => ({
        ...current,
        ...readPersistedState(persisted),
      }),
    },
  ),
);

followStorageOwner(useChatRunOnPreferenceStore);

/** The member's last Run on choice in the organization, if they made one. */
export const rememberedRunTarget = (
  organizationId: string,
): ChatRunTarget | undefined =>
  useChatRunOnPreferenceStore.getState().byOrganization[organizationId];

export const rememberRunTarget = (
  organizationId: string,
  target: ChatRunTarget,
): void => {
  useChatRunOnPreferenceStore.getState().remember(organizationId, target);
};
