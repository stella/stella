import * as v from "valibot";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  CHAT_CLOUD_RUN_TARGET,
  CHAT_RUN_TARGET_KIND,
  chatLocalRunTargetSchema,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import { DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE } from "@stll/api-contract/desktop-runner";

import { browserStateStorage } from "@/lib/account/browser-storage";
import {
  followStorageOwner,
  userScopedStateStorage,
} from "@/lib/account/user-scoped-storage";

/** Longer than any organization id: such a key names none. */
const ORGANIZATION_ID_MAX_LENGTH = 64;

/**
 * Where the member last chose to run turns: stella cloud, or a harness and
 * model on their computer. Never how much a run may do without asking: a
 * permission is granted to one chat, and a new chat asks again. Nor the
 * reasoning effort, which a new chat leaves to the harness.
 */
const runOnPreferenceSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal(CHAT_RUN_TARGET_KIND.cloud) }),
  v.omit(chatLocalRunTargetSchema, ["approvals", "reasoningEffort"]),
]);
type RunOnPreference = v.InferOutput<typeof runOnPreferenceSchema>;

type PersistedRunOnPreference = {
  /** The member's last Run on choice in each organization they chat in. */
  byOrganization: Record<string, RunOnPreference>;
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
        ([organizationId, preference]) => {
          const parsed = v.safeParse(runOnPreferenceSchema, preference);
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
 * What of a chosen target is remembered: where it runs, not its permission
 * or reasoning effort.
 */
const preferenceOf = (target: ChatRunTarget): RunOnPreference =>
  target.kind === "local"
    ? { kind: target.kind, harness: target.harness, model: target.model }
    : CHAT_CLOUD_RUN_TARGET;

/**
 * The member's last Run on choice, per organization, which a new chat starts
 * from. Kept in the browser for this member alone, as the web-search default
 * is; each chat stores its own choice on its row, and this only seeds a chat
 * that has none.
 */
export const useChatRunOnPreferenceStore = create<ChatRunOnPreferenceStore>()(
  persist(
    (set) => ({
      byOrganization: {},
      remember: (organizationId, target) => {
        set((state) => ({
          byOrganization: {
            ...state.byOrganization,
            [organizationId]: preferenceOf(target),
          },
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

/**
 * Where a new chat in the organization starts, if the member chose before:
 * on their computer always with the default permission, never one granted
 * to an earlier chat, and the harness's own reasoning effort.
 */
export const rememberedRunTarget = (
  organizationId: string,
): ChatRunTarget | undefined => {
  const preference =
    useChatRunOnPreferenceStore.getState().byOrganization[organizationId];
  return preference?.kind === "local"
    ? {
        ...preference,
        approvals: DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE,
        reasoningEffort: null,
      }
    : preference;
};

/** Remember where `target` runs as the member's last Run on choice. */
export const rememberRunTarget = (
  organizationId: string,
  target: ChatRunTarget,
): void => {
  useChatRunOnPreferenceStore.getState().remember(organizationId, target);
};
