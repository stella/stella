import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";

import { getStorageKey } from "@/consts";

type State = {
  tanstackDevtools: boolean;
  sourceInspector: boolean;
  chatModelId: string | null;
  showToolCallDetails: boolean;
  reactGrab: boolean;
  publicLawPreview: boolean;
};

type Actions = {
  setTanstackDevtools: (value: boolean) => void;
  setSourceInspector: (value: boolean) => void;
  setChatModelId: (value: string | null) => void;
  setShowToolCallDetails: (value: boolean) => void;
  setReactGrab: (value: boolean) => void;
  setPublicLawPreview: (value: boolean) => void;
};

const serverStorage: StateStorage = {
  getItem: () => null,
  removeItem: () => undefined,
  setItem: () => undefined,
};

export const useDevStore = create<State & Actions>()(
  persist(
    (set) => ({
      tanstackDevtools: false,
      sourceInspector: false,
      chatModelId: null,
      showToolCallDetails: false,
      reactGrab: false,
      publicLawPreview: false,

      setTanstackDevtools: (tanstackDevtools) => {
        void set({ tanstackDevtools });
      },
      setSourceInspector: (sourceInspector) => {
        void set({ sourceInspector });
      },
      setChatModelId: (chatModelId) => {
        void set({ chatModelId });
      },
      setShowToolCallDetails: (showToolCallDetails) => {
        void set({ showToolCallDetails });
      },
      setReactGrab: (reactGrab) => {
        void set({ reactGrab });
      },
      setPublicLawPreview: (publicLawPreview) => {
        void set({ publicLawPreview });
      },
    }),
    {
      storage: createJSONStorage(() =>
        typeof window === "undefined" ? serverStorage : window.localStorage,
      ),
      name: getStorageKey("dev"),
    },
  ),
);
