import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";

type State = {
  tanstackDevtools: boolean;
  sourceInspector: boolean;
  chatModelId: string | null;
  showToolCalls: boolean;
  reactGrab: boolean;
};

type Actions = {
  setTanstackDevtools: (value: boolean) => void;
  setSourceInspector: (value: boolean) => void;
  setChatModelId: (value: string | null) => void;
  setShowToolCalls: (value: boolean) => void;
  setReactGrab: (value: boolean) => void;
};

export const useDevStore = create<State & Actions>()(
  persist(
    (set) => ({
      tanstackDevtools: false,
      sourceInspector: false,
      chatModelId: null,
      showToolCalls: false,
      reactGrab: false,

      setTanstackDevtools: (tanstackDevtools) => {
        void set({ tanstackDevtools });
      },
      setSourceInspector: (sourceInspector) => {
        void set({ sourceInspector });
      },
      setChatModelId: (chatModelId) => {
        void set({ chatModelId });
      },
      setShowToolCalls: (showToolCalls) => {
        void set({ showToolCalls });
      },
      setReactGrab: (reactGrab) => {
        void set({ reactGrab });
      },
    }),
    {
      name: getStorageKey("dev"),
    },
  ),
);
