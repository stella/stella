import { create } from "zustand";

import type { ResourceName } from "@stll/api-contract";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import type { CapabilityId } from "@/lib/api";

/** A capability the current screen offers on one resource. */
export type ScreenAction = {
  readonly capability: CapabilityId;
  readonly resource: ResourceName;
};

type ScreenActionsStore = {
  actions: ReadonlyMap<symbol, ScreenAction>;
  register: (action: ScreenAction) => () => void;
};

/**
 * Actions offered by mounted components. Each mount holds its own entry, so
 * two controls offering the same action unmount independently.
 */
export const useScreenActionsStore = create<ScreenActionsStore>()((set) => ({
  actions: new Map(),
  register: (action) => {
    const key = Symbol(action.capability);
    set(({ actions }) => ({ actions: new Map(actions).set(key, action) }));
    return () => {
      set(({ actions }) => {
        const next = new Map(actions);
        next.delete(key);
        return { actions: next };
      });
    };
  },
}));

/** Offers `capability` on `resource` while the calling component is mounted. */
export const useScreenAction = ({ capability, resource }: ScreenAction) => {
  const register = useScreenActionsStore((state) => state.register);
  useExternalSyncEffect(
    () => register({ capability, resource }),
    [capability, register, resource],
  );
};
