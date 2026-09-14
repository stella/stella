import { create } from "zustand";

export const GUIDE_DRAWER_STATES = {
  // Never opened this session: the sidebar has not even loaded the drawer.
  idle: "idle",
  open: "open",
  closed: "closed",
} as const;

export type GuideDrawerState =
  (typeof GUIDE_DRAWER_STATES)[keyof typeof GUIDE_DRAWER_STATES];

type GuideDrawerStore = {
  state: GuideDrawerState;
  open: () => void;
  setOpen: (open: boolean) => void;
};

/**
 * The Help drawer lives in the sidebar, but the surfaces that invite a new
 * user in (the last onboarding step, the empty chat) live elsewhere. The
 * store lets them open it without threading callbacks through the shell;
 * an `open` set before a route change survives it, so onboarding can open
 * the drawer over the chat it lands on.
 */
export const useGuideDrawerStore = create<GuideDrawerStore>()((set) => ({
  state: GUIDE_DRAWER_STATES.idle,
  open: () => set({ state: GUIDE_DRAWER_STATES.open }),
  setOpen: (open) =>
    set({
      state: open ? GUIDE_DRAWER_STATES.open : GUIDE_DRAWER_STATES.closed,
    }),
}));
