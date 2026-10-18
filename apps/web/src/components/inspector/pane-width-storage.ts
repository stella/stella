import { useInspectorPaneWidth } from "@stll/ui/inspector";

import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

type UseSharedInspectorPaneWidthOptions = {
  sidebarWidth: number;
  viewportWidth: number;
};

/** All dock surfaces share the same server-readable desired width. */
export const useSharedInspectorPaneWidth = ({
  sidebarWidth,
  viewportWidth,
}: UseSharedInspectorPaneWidthOptions) => {
  const { prefs, setPrefs } = usePresentationPrefs();
  return useInspectorPaneWidth({
    initialWidth: prefs.inspectorWidth,
    onWidthChange: (inspectorWidth) => setPrefs(() => ({ inspectorWidth })),
    sidebarWidth,
    viewportWidth,
  });
};
