import { usePendingCache } from "@/components/pending-cache";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import {
  ToolsCatalogueSkeleton,
  ToolsPageShell,
} from "@/routes/knowledge/-tools/tools-page-shape";

/** The Tools page while its list loads: a placeholder of the page's
 *  geometry, which does not scroll, with the add action where the cached
 *  role may create skills. */
export const ToolsPending = framePendingView(() => {
  const cache = usePendingCache();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ToolsPageShell>
        <ToolsCatalogueSkeleton
          addAction={
            cache !== null &&
            cachedRoleGrants(cache, { agentSkill: ["create"] })
          }
        />
      </ToolsPageShell>
    </div>
  );
});
