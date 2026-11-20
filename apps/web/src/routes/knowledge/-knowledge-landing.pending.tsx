import { useSyncExternalStore } from "react";

import { usePendingCache } from "@/components/pending-cache";
import { env } from "@/env";
import { KnowledgeLandingPendingView } from "@/features/knowledge/views/knowledge-landing.pending";
import {
  keptLandingSections,
  memberLandingSections,
  pendingKnowledgeAudience,
} from "@/lib/knowledge/landing-sections.logic";
import type { KnowledgeSection } from "@/lib/knowledge/navigation";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import { framePendingView } from "@/routes/-pending-view.logic";
import { useConfigStore } from "@/stores/config-store";

const subscribeToConfig = (onChange: () => void) =>
  useConfigStore.subscribe(onChange);
const readKeptLanding = () => useConfigStore.getState().knowledgeLanding;
const notReadYet = () => null;

/**
 * The sections a member's landing last showed in this browser, once the
 * page can read it: never during the server's paint or the hydration pass
 * (the server has no browser storage), so the first paint claims no cards
 * it might take back.
 */
const useKeptLanding = (): string[] | null =>
  useSyncExternalStore(subscribeToConfig, readKeptLanding, notReadYet);

/**
 * The Knowledge landing while it loads. A member's cards are the ones this
 * browser's landing last showed, or, on a page that has read the role, the
 * ones the role opens. Where neither is known, and for a visitor without an
 * account (whose cards depend on reads the view cannot make), the grid stays
 * empty rather than guess.
 */
export const KnowledgeLandingPending = framePendingView(() => {
  const cache = usePendingCache();
  const kept = useKeptLanding();
  const audience = pendingKnowledgeAudience(cache);
  let sections: readonly KnowledgeSection[] | null = null;
  if (audience === "member") {
    if (kept !== null) {
      sections = keptLandingSections(kept);
    } else if (cache !== null) {
      sections = memberLandingSections({
        styleSetsGranted: cachedRoleGrants(cache, { styleSet: ["use"] }),
        workflowsEnabled: env.VITE_WORKFLOWS_ENABLED,
      });
    }
  }
  return <KnowledgeLandingPendingView sections={sections} />;
});
