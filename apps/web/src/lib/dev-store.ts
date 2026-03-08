import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";

type State = {
  tanstackDevtools: boolean;
  sourceInspector: boolean;
  rivetDevtools: boolean;
  chatModelId: string | null;
  showToolCalls: boolean;
  reactGrab: boolean;
};

type Actions = {
  setTanstackDevtools: (value: boolean) => void;
  setSourceInspector: (value: boolean) => void;
  setRivetDevtools: (value: boolean) => void;
  setChatModelId: (value: string | null) => void;
  setShowToolCalls: (value: boolean) => void;
  setReactGrab: (value: boolean) => void;
};

export const useDevStore = create<State & Actions>()(
  persist(
    (set) => ({
      tanstackDevtools: true,
      sourceInspector: false,
      rivetDevtools: true,
      chatModelId: null,
      showToolCalls: true,
      reactGrab: true,

      setTanstackDevtools: (tanstackDevtools) => set({ tanstackDevtools }),
      setSourceInspector: (sourceInspector) => set({ sourceInspector }),
      setRivetDevtools: (rivetDevtools) => set({ rivetDevtools }),
      setChatModelId: (chatModelId) => set({ chatModelId }),
      setShowToolCalls: (showToolCalls) => set({ showToolCalls }),
      setReactGrab: (reactGrab) => set({ reactGrab }),
    }),
    {
      name: getStorageKey("dev"),
      version: 1,
    },
  ),
);
