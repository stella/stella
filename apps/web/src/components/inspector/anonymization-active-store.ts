/**
 * Tracks whether the workspace anonymization inspector facet is
 * currently visible. The Folio document editor reads this to gate
 * its inline term-highlight overlay: highlights paint only while
 * the facet is mounted, and clear the moment the user switches to
 * any other inspector tab.
 *
 * Modelled as a counter rather than a boolean so concurrent
 * mounts (peek + full view, StrictMode double-invoke) don't race:
 * each mount bumps, each unmount decrements, and "active" is
 * "count > 0".
 */

import { create } from "zustand";

type State = {
  mountCount: number;
};

type Actions = {
  acquire: () => void;
  release: () => void;
};

export const useAnonymizationActiveStore = create<State & Actions>((set) => ({
  mountCount: 0,
  acquire: () => set((s) => ({ mountCount: s.mountCount + 1 })),
  release: () => set((s) => ({ mountCount: Math.max(0, s.mountCount - 1) })),
}));

export const useIsAnonymizationActive = (): boolean =>
  useAnonymizationActiveStore((s) => s.mountCount > 0);
