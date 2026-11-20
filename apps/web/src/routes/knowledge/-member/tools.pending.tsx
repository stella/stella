import { framePendingView } from "@/routes/-pending-view.logic";
import {
  ToolsCatalogueSkeleton,
  ToolsPageShell,
} from "@/routes/knowledge/-tools/tools-page-shape";

/** The Tools page while its list loads: a placeholder of the page's
 *  geometry, which does not scroll. */
export const ToolsPending = framePendingView(() => (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <ToolsPageShell>
      <ToolsCatalogueSkeleton />
    </ToolsPageShell>
  </div>
));
