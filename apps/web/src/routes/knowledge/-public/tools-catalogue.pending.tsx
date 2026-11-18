import type { ReactNode } from "react";

import { framePendingView } from "@/routes/-pending-view.logic";
import {
  ToolsCatalogueSkeleton,
  ToolsPageShell,
} from "@/routes/knowledge/-tools/tools-page-shape";

/** The published tools' list: the Tools page's shell, which the list fills. */
export const ToolsCatalogueShell = ({ children }: { children: ReactNode }) => (
  <ToolsPageShell>{children}</ToolsPageShell>
);

/** The published tools' list while it loads. */
export const ToolsCataloguePending = framePendingView(() => (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <ToolsCatalogueShell>
      <ToolsCatalogueSkeleton />
    </ToolsCatalogueShell>
  </div>
));
