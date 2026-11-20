import { usePendingCache } from "@/components/pending-cache";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import { FlowListPending } from "@/routes/knowledge/-components/flow-list.pending";

/** The organization's workflows while they load, with the create action
 *  where the cached role grants it. */
export const WorkflowsPending = framePendingView(() => {
  const cache = usePendingCache();
  return (
    <FlowListPending
      canCreate={
        cache !== null && cachedRoleGrants(cache, { flow: ["create"] })
      }
    />
  );
});
