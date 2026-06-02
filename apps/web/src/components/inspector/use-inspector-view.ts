import { useInspectorStore } from "@/components/inspector/inspector-store";

/**
 * Public hook for non-workspace routes to open, close, and switch
 * registry-backed inspector views. Wraps the store's
 * `openView` / `closeTab` / `setActive` actions so callers don't
 * have to import the store directly.
 */
export const useInspectorView = () => {
  const open = useInspectorStore((s) => s.openView);
  const close = useInspectorStore((s) => s.closeTab);
  const setActive = useInspectorStore((s) => s.setActive);
  return { open, close, setActive };
};
