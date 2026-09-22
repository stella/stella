import { create } from "zustand";

export const GUIDE_DRAWER_STATES = {
  // Never opened this session: the sidebar has not even loaded the drawer.
  idle: "idle",
  open: "open",
  closed: "closed",
} as const;

export type GuideDrawerState =
  (typeof GUIDE_DRAWER_STATES)[keyof typeof GUIDE_DRAWER_STATES];

export const GUIDE_DRAWER_OPEN_SOURCES = {
  onboarding: "onboarding",
  user: "user",
} as const;

type GuideDrawerOpenSource =
  (typeof GUIDE_DRAWER_OPEN_SOURCES)[keyof typeof GUIDE_DRAWER_OPEN_SOURCES];

type GuideDrawerStore = {
  attentionSequence: number;
  openSource: GuideDrawerOpenSource | null;
  state: GuideDrawerState;
  open: (source?: GuideDrawerOpenSource) => void;
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
  attentionSequence: 0,
  openSource: null,
  state: GUIDE_DRAWER_STATES.idle,
  open: (source = GUIDE_DRAWER_OPEN_SOURCES.user) =>
    set({
      openSource: source,
      state: GUIDE_DRAWER_STATES.open,
    }),
  setOpen: (open) =>
    set((current) => {
      if (open) {
        return {
          openSource:
            current.state === GUIDE_DRAWER_STATES.open
              ? current.openSource
              : GUIDE_DRAWER_OPEN_SOURCES.user,
          state: GUIDE_DRAWER_STATES.open,
        };
      }

      const shouldPointBackToButton =
        current.state === GUIDE_DRAWER_STATES.open &&
        current.openSource === GUIDE_DRAWER_OPEN_SOURCES.onboarding;
      return {
        attentionSequence:
          current.attentionSequence + (shouldPointBackToButton ? 1 : 0),
        openSource: null,
        state: GUIDE_DRAWER_STATES.closed,
      };
    }),
}));
