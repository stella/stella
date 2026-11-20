import type { QueryClient } from "@tanstack/react-query";

import { newestCachedData } from "@/components/pending-cache-reads.logic";
import { rootKeys } from "@/lib/account/auth-query-keys.logic";
import { knowledgeSections } from "@/lib/knowledge/navigation";
import type { KnowledgeSection } from "@/lib/knowledge/navigation";
import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";

/** What decides which sections a member's landing opens. */
type MemberLandingAccess = {
  /** The workflows preview is on for this deployment or browser. */
  workflowsEnabled: boolean;
  /** The member's role may use house styles. */
  styleSetsGranted: boolean;
};

/** The sections a member's Knowledge landing shows, in its order. */
export const memberLandingSections = ({
  styleSetsGranted,
  workflowsEnabled,
}: MemberLandingAccess): readonly KnowledgeSection[] =>
  knowledgeSections.filter(
    (section) =>
      (section.key !== "workflows" || workflowsEnabled) &&
      (section.key !== "styles" || styleSetsGranted),
  );

/** The sections a landing kept in this browser named, in the landing's
 *  order; unknown names are dropped. */
export const keptLandingSections = (
  kept: readonly string[],
): readonly KnowledgeSection[] =>
  knowledgeSections.filter((section) => kept.includes(section.key));

/**
 * Who the Knowledge landing is for, as far as a loading view can know it
 * without reading anything: behind sign-in, always a member; while Knowledge
 * is public, the session the cache already holds (`null` when it holds
 * none yet, or where there is no cache to read).
 */
export const pendingKnowledgeAudience = (
  cache: QueryClient | null,
): "member" | "public" | null => {
  if (!isPublicKnowledgeEnabled()) {
    return "member";
  }
  if (cache === null) {
    return null;
  }
  // Read by its key alone, as `cachedRoleGrants` reads the role, so the
  // view loads no auth client.
  const session = newestCachedData(
    cache,
    cache.getQueriesData({ exact: true, queryKey: rootKeys.session }),
  );
  if (session === null) {
    return "public";
  }
  return session === undefined ? null : "member";
};
