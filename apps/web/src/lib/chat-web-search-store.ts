import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Frontend-only preference: remember whether the user wants web search
 * on by default in a fresh chat. Per-thread state still lives in the
 * DB (`chatThreads.webSearchEnabled`); this store seeds new threads
 * so the user doesn't have to flip the toggle every time.
 */
type ChatWebSearchPreferenceStore = {
  enabledPreference: boolean;
  setEnabledPreference: (value: boolean) => void;
};

export const useChatWebSearchPreferenceStore =
  create<ChatWebSearchPreferenceStore>()(
    persist(
      (set) => ({
        enabledPreference: false,
        setEnabledPreference: (value) => {
          set({ enabledPreference: value });
        },
      }),
      {
        name: "stella.chat.webSearchPreference",
        version: 1,
        partialize: ({ enabledPreference }) => ({ enabledPreference }),
      },
    ),
  );
