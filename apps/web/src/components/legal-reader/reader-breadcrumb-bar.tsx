import type { PropsWithChildren } from "react";

import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";

export const ReaderBreadcrumbBar = ({ children }: PropsWithChildren) => (
  <ViewerOverlayBar className="reader-chrome start-2 h-12 min-w-0 gap-0 text-xs">
    {children}
  </ViewerOverlayBar>
);
