import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { create } from "zustand";

// Route-scoped header actions slot. The protected shell renders a single
// `ChromeHeaderActionsSlot` in its top bar and a page publishes its own
// right-side actions into it with `<ChromeHeaderActions>`. The page keeps its
// actions inside its own subtree (so their handlers and state stay in scope)
// while the shell never imports the page's components: the coupling is one DOM
// node passed through this store, so vertical slices stay decoupled.

type ChromeHeaderActionsStore = {
  container: HTMLElement | null;
  setContainer: (container: HTMLElement | null) => void;
};

const useChromeHeaderActionsStore = create<ChromeHeaderActionsStore>((set) => ({
  container: null,
  setContainer: (container) => set({ container }),
}));

// Rendered once in the app header. Registers the DOM node that pages portal
// their actions into; clears it on unmount via the ref callback.
export const ChromeHeaderActionsSlot = () => {
  const setContainer = useChromeHeaderActionsStore((s) => s.setContainer);

  return (
    <div className="flex shrink-0 items-center gap-0.5" ref={setContainer} />
  );
};

// Portals a page's header actions into the shell's slot. Renders nothing until
// the slot has mounted and registered its container.
export const ChromeHeaderActions = ({ children }: { children: ReactNode }) => {
  const container = useChromeHeaderActionsStore((s) => s.container);
  if (!container) {
    return null;
  }

  return createPortal(children, container);
};
