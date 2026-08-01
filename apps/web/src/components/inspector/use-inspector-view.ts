import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";

/**
 * Public hook for non-workspace routes to open, close, and switch
 * registry-backed inspector views. Wraps the store's
 * `openView` / `closeTab` / `setActive` actions so callers don't
 * have to import the store directly.
 */
export const useInspectorView = () => {
  const open = useInspectorTabsStore((s) => s.openView);
  const close = useInspectorTabsStore((s) => s.closeTab);
  const setActive = useInspectorTabsStore((s) => s.setActive);
  return { open, close, setActive };
};
