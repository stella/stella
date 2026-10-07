import { useInfiniteQuery } from "@tanstack/react-query";

import { commandShortcutRowsFromSkillPages } from "@/components/chat-editor-slash-items";
import type { SkillLastEdit } from "@/components/chat-editor-slash-items";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { skillsOptions } from "@/lib/knowledge/queries";
import { useChatUnavailableSkillIds } from "@/lib/prompts/use-chat-unavailable-skills";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

import type { ChatPrompt } from "./types";

const MAX_SUGGESTIONS = 4;

export type SuggestedSkill = ChatPrompt & { lastEdit: SkillLastEdit };

/**
 * Returns up to 4 of the most recently created skills with a slash
 * command set: the skills the chat surfaces suggest firing from the
 * composer. Deterministic order avoids the flicker that random
 * sampling causes across stale→fresh refetches.
 */
export const useSuggestedSkills = (): SuggestedSkill[] => {
  // Sourced from the auth context, not the /_protected route context:
  // this hook also renders inside the public law workspace, where no
  // /_protected match exists. Anonymous visitors (pre-signup AI
  // surfaces) simply have no suggested skills.
  const user = useMaybeAuthenticatedUser();
  const activeOrganizationId = user?.activeOrganizationId;
  const userId = user?.id;
  const skillPagesQuery = useInfiniteQuery({
    ...skillsOptions(
      activeOrganizationId ?? "",
      userId ?? SIGNED_OUT_QUERY_OWNER,
    ),
    enabled: activeOrganizationId !== undefined && userId !== undefined,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = skillPagesQuery;
  const skillPagesView = useQueryView(skillPagesQuery);
  useQueryViewError(skillPagesView);
  const skillPages =
    skillPagesView.type === "items" ? skillPagesView.items : undefined;
  const canLoadSkillPages =
    skillPagesView.type === "items" &&
    skillPagesView.refetchError === undefined;
  useExternalSyncEffect(() => {
    if (
      activeOrganizationId === undefined ||
      !canLoadSkillPages ||
      !hasNextPage ||
      isFetchingNextPage
    ) {
      return;
    }
    detached(fetchNextPage(), "use-suggested-skills.fetch-next-page");
  }, [
    activeOrganizationId,
    canLoadSkillPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  ]);
  const unavailableSkillIds = useChatUnavailableSkillIds(
    activeOrganizationId,
    userId,
  );
  const rows = commandShortcutRowsFromSkillPages(
    skillPages?.pages,
    unavailableSkillIds,
  );

  return rows.slice(0, MAX_SUGGESTIONS).map((row) => ({
    id: row.id,
    scope: row.scope,
    name: row.name,
    command: row.command,
    body: row.prompt,
    lastEdit: row.lastEdit,
  }));
};
