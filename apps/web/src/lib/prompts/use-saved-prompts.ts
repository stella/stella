import { useInfiniteQuery } from "@tanstack/react-query";

import { commandShortcutRowsFromSkillPages } from "@/components/chat-editor-slash-items";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { skillsOptions } from "@/routes/_protected.knowledge/-queries";

import type { ChatPrompt } from "./types";

const MAX_SUGGESTIONS = 4;

/**
 * Returns up to 4 of the most recently created skills with a slash
 * command set. "Saved prompts" is the unified surface's name for the
 * subset of skills the user can fire from the chat composer; the
 * underlying row lives in `agent_skills` after the prompts/skills
 * consolidation. Deterministic order avoids the flicker that random
 * sampling causes across stale→fresh refetches.
 */
export const useSavedPrompts = (): ChatPrompt[] => {
  // Sourced from the auth context, not the /_protected route context:
  // this hook also renders inside the public law workspace, where no
  // /_protected match exists. Anonymous visitors (pre-signup AI
  // surfaces) simply have no saved prompts.
  const activeOrganizationId =
    useMaybeAuthenticatedUser()?.activeOrganizationId;
  const {
    data: skillPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    ...skillsOptions(activeOrganizationId ?? ""),
    enabled: activeOrganizationId !== undefined,
  });
  useExternalSyncEffect(() => {
    if (
      activeOrganizationId === undefined ||
      !hasNextPage ||
      isFetchingNextPage
    ) {
      return;
    }
    detached(fetchNextPage(), "useSavedPrompts");
  }, [activeOrganizationId, fetchNextPage, hasNextPage, isFetchingNextPage]);
  const rows = commandShortcutRowsFromSkillPages(skillPages?.pages);

  return rows.slice(0, MAX_SUGGESTIONS).map<ChatPrompt>((row) => ({
    id: row.id,
    scope: row.scope,
    name: row.name,
    command: row.command,
    body: row.prompt,
  }));
};
