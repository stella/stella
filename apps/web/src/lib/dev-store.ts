import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";

type State = {
  tanstackDevtools: boolean;
  sourceInspector: boolean;
  rivetDevtools: boolean;
};

type Actions = {
  setTanstackDevtools: (value: boolean) => void;
  setSourceInspector: (value: boolean) => void;
  setRivetDevtools: (value: boolean) => void;
};

export const useDevStore = create<State & Actions>()(
  persist(
    (set) => ({
      tanstackDevtools: true,
      sourceInspector: false,
      rivetDevtools: true,

      setTanstackDevtools: (tanstackDevtools) => set({ tanstackDevtools }),
      setSourceInspector: (sourceInspector) => set({ sourceInspector }),
      setRivetDevtools: (rivetDevtools) => set({ rivetDevtools }),
    }),
    {
      name: getStorageKey("dev"),
      version: 0,
    },
  ),
);
