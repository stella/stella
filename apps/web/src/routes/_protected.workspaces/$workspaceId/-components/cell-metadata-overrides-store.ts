import { create } from "zustand";

export type CellOverride = {
  manualFlags: string[];
  locked: boolean | undefined;
};

type State = {
  overrides: Record<string, CellOverride>;
  setOverride: (key: string, override: CellOverride) => void;
  clearOverride: (key: string) => void;
};

// Per-cell optimistic state shared across components — the corner
// flag in the cell and the flag submenu in the right-click menu both
// subscribe so a single click updates both surfaces instantly. The
// store is cleared once the server-side metadata catches up.
export const useCellMetadataOverridesStore = create<State>((set) => ({
  overrides: {},
  setOverride: (key, override) =>
    set((state) => ({
      overrides: { ...state.overrides, [key]: override },
    })),
  clearOverride: (key) =>
    set((state) => {
      if (!(key in state.overrides)) {
        return state;
      }
      const { [key]: _omit, ...rest } = state.overrides;
      return { overrides: rest };
    }),
}));

export const cellOverrideKey = (entityId: string, propertyId: string) =>
  `${entityId}:${propertyId}`;
