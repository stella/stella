import { usePendingCache } from "@/components/pending-cache";
import { PlaybooksPagePending } from "@/features/knowledge/views/playbooks/playbooks-page-shape";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The organization's playbooks while they load, with the create action and
 *  the ready-made cards where the cached role grants them. */
export const PlaybooksPending = framePendingView(() => {
  const cache = usePendingCache();
  return (
    <PlaybooksPagePending
      canCreate={
        cache !== null && cachedRoleGrants(cache, { playbook: ["create"] })
      }
      page="library"
    />
  );
});
