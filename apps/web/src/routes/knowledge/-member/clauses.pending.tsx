import { usePendingCache } from "@/components/pending-cache";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import { ClauseListPending } from "@/routes/knowledge/-components/clause-list.pending";

/** The clause library while it loads, with the create actions where the
 *  cached role grants them. */
export const ClausesPending = framePendingView(() => {
  const cache = usePendingCache();
  return (
    <ClauseListPending
      canCreate={
        cache !== null && cachedRoleGrants(cache, { clause: ["create"] })
      }
    />
  );
});
