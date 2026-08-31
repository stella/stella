import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { StateStorage } from "zustand/middleware";

import { getStorageKey } from "@/consts";

type State = {
  tanstackDevtools: boolean;
  sourceInspector: boolean;
  reactGrab: boolean;
  publicLawPreview: boolean;
  workflowsPreview: boolean;
  inboxPreview: boolean;
  guidesPreview: boolean;
  timeBillingPreview: boolean;
  simulateSlowLoad: boolean;
};

type Actions = {
  setTanstackDevtools: (value: boolean) => void;
  setSourceInspector: (value: boolean) => void;
  setReactGrab: (value: boolean) => void;
  setPublicLawPreview: (value: boolean) => void;
  setWorkflowsPreview: (value: boolean) => void;
  setInboxPreview: (value: boolean) => void;
  setGuidesPreview: (value: boolean) => void;
  setTimeBillingPreview: (value: boolean) => void;
  setSimulateSlowLoad: (value: boolean) => void;
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
      reactGrab: false,
      publicLawPreview: false,
      workflowsPreview: false,
      inboxPreview: false,
      guidesPreview: false,
      timeBillingPreview: false,
      simulateSlowLoad: false,

      setTanstackDevtools: (tanstackDevtools) => {
        set({ tanstackDevtools });
      },
      setSourceInspector: (sourceInspector) => {
        set({ sourceInspector });
      },
      setReactGrab: (reactGrab) => {
        set({ reactGrab });
      },
      setPublicLawPreview: (publicLawPreview) => {
        set({ publicLawPreview });
      },
      setWorkflowsPreview: (workflowsPreview) => {
        set({ workflowsPreview });
      },
      setInboxPreview: (inboxPreview) => {
        set({ inboxPreview });
      },
      setGuidesPreview: (guidesPreview) => {
        set({ guidesPreview });
      },
      setTimeBillingPreview: (timeBillingPreview) => {
        set({ timeBillingPreview });
      },
      setSimulateSlowLoad: (simulateSlowLoad) => {
        set({ simulateSlowLoad });
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

/** Artificial per-request delay (ms) injected into every API fetch while
 *  the "Simulate slow load" dev toggle is on, so loading screens stay
 *  visible long enough to inspect and restyle. */
export const SIMULATE_SLOW_LOAD_DELAY_MS = 3000;

/** Current artificial API delay, read outside React for the fetch layer.
 *  Returns 0 in production builds and during SSR so the delay only ever
 *  applies to a developer's own client session. */
export const getSimulateSlowLoadDelayMs = (): number => {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return 0;
  }
  return useDevStore.getState().simulateSlowLoad
    ? SIMULATE_SLOW_LOAD_DELAY_MS
    : 0;
};
