import { useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { create } from "zustand";

import { useMountEffect } from "@/hooks/use-effect";

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
// their actions into; clears it on unmount.
//
// The store write is deferred to a mount effect rather than done in the `ref`
// callback: a ref callback fires during the commit/layout sub-phase, before
// the passive mount effects of other components have run, so writing the store
// there notifies a `ChromeHeaderActions` subscriber whose `useSyncExternalStore`
// subscription is not yet committed — React 19 flags that as a state update on a
// component that has not mounted yet. Publishing from `useMountEffect` (passive,
// post-commit) means every subscriber is mounted by the time the container lands.
export const ChromeHeaderActionsSlot = () => {
  const setContainer = useChromeHeaderActionsStore((s) => s.setContainer);
  const containerRef = useRef<HTMLDivElement>(null);

  useMountEffect(() => {
    setContainer(containerRef.current);
    return () => setContainer(null);
  });

  return (
    <div className="flex shrink-0 items-center gap-0.5" ref={containerRef} />
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
