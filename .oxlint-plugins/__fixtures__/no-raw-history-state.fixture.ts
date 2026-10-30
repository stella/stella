// A suppression becoming unused proves the history-state detector stopped firing.

declare const router: { history: { canGoBack: () => boolean; back: () => void } };

// oxlint-disable-next-line no-raw-history-state/no-raw-history-state -- Browser history state belongs to the router.
export const state = (): unknown => window.history.state;

// oxlint-disable-next-line no-raw-history-state/no-raw-history-state -- Browser history length is not an in-app back signal.
export const entries = (): number => history.length;

// oxlint-disable-next-line no-raw-history-state/no-raw-history-state -- Destructured history state also bypasses the router.
export const { state: destructured } = globalThis.history;

// expect-clean: no-raw-history-state/no-raw-history-state
export const leave = () => {
  if (router.history.canGoBack()) {
    router.history.back();
  }
};
