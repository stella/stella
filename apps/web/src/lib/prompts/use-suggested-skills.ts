import { commandShortcutRowsFromSkillPages } from "@/components/chat-editor-slash-items";
import type { SkillLastEdit } from "@/components/chat-editor-slash-items";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { useSkillsPages } from "@/lib/knowledge/built-in-skills";
import { suggestedSkillsFrom } from "@/lib/prompts/suggested-skills.logic";
import { useChatUnavailableSkillIds } from "@/lib/prompts/use-chat-unavailable-skills";
import { queryView } from "@/lib/query-view.logic";
import type { QueryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

import type { ChatPrompt } from "./types";

const MAX_SUGGESTIONS = 4;

export type SuggestedSkill = ChatPrompt & { lastEdit: SkillLastEdit };

/**
 * Where the suggestions stand. `pending` is not "none": a surface shows
 * placeholders until `loaded`, so an empty state never flashes before the
 * skills arrive. `feedback` is the skill read's own state, for
 * `QueryViewFeedback` (a failed read, or a failed refetch over kept rows).
 */
export type SuggestedSkills =
  | { type: "pending" }
  | { type: "error"; feedback: QueryView<unknown, unknown> }
  | {
      type: "loaded";
      feedback: QueryView<unknown, unknown>;
      skills: readonly SuggestedSkill[];
    };

// A visitor without an account has no skills to read: settled, and empty.
const NO_MEMBER_SUGGESTIONS: SuggestedSkills = {
  type: "loaded",
  feedback: { type: "empty" },
  skills: [],
};

/**
 * Returns up to 4 of the most recently created skills with a slash
 * command set: the skills the chat surfaces suggest firing from the
 * composer. Deterministic order avoids the flicker that random
 * sampling causes across stale→fresh refetches.
 */
export const useSuggestedSkills = (): SuggestedSkills => {
  // Sourced from the auth context, not the /_protected route context:
  // this hook also renders inside the public law workspace, where no
  // /_protected match exists. Anonymous visitors (pre-signup AI
  // surfaces) simply have no suggested skills.
  const user = useMaybeAuthenticatedUser();
  const activeOrganizationId = user?.activeOrganizationId;
  const userId = user?.id;
  const skillPagesQuery = useSkillsPages({
    enabled: activeOrganizationId !== undefined && userId !== undefined,
    organizationId: activeOrganizationId ?? "",
    userId: userId ?? SIGNED_OUT_QUERY_OWNER,
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = skillPagesQuery;
  const skillPagesView = queryView(skillPagesQuery);
  useQueryViewError(skillPagesView, "useSuggestedSkills:query");
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
  if (activeOrganizationId === undefined || userId === undefined) {
    return NO_MEMBER_SUGGESTIONS;
  }
  const rows = commandShortcutRowsFromSkillPages(
    skillPages?.pages,
    unavailableSkillIds,
  );
  return suggestedSkillsFrom({
    hasNextPage,
    skills: rows.slice(0, MAX_SUGGESTIONS).map((row) => ({
      id: row.id,
      scope: row.scope,
      name: row.name,
      command: row.command,
      body: row.prompt,
      lastEdit: row.lastEdit,
    })),
    view: skillPagesView,
  });
};

/** The suggestions to offer now: none until they have loaded. */
export const offeredSuggestedSkills = (
  suggestions: SuggestedSkills,
): readonly SuggestedSkill[] =>
  suggestions.type === "loaded" ? suggestions.skills : [];
