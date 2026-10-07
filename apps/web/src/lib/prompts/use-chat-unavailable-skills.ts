import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import type { UnavailableSkillIds } from "@/components/chat-editor-slash-items";
import { useBrowserClientConnected } from "@/features/chat/browser-control/browser-extension-bridge";
import { SIGNED_OUT_QUERY_OWNER } from "@/lib/account/queries";
import { useOptionalChatAnonymized } from "@/lib/chat-anonymized-store";
import { chatUnavailableSkillsOptions } from "@/lib/knowledge/queries";
import {
  chatSkillAvailabilityQuery,
  chatSkillMenuAvailability,
  type ChatSkillMenuAvailability,
  type ComposerSkillChatContext,
} from "@/lib/prompts/chat-skill-availability.logic";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";

/**
 * The skills chat cannot offer the caller, keyed by id, with the tools each
 * lacks. Menus leave these out; the tools page says why. `undefined` until
 * the server answers (and when there is no organization), so a menu offers
 * no skill it has not been told chat can finish.
 */
export const useChatUnavailableSkills = (
  organizationId: string | undefined,
  userId: string | undefined,
): ReadonlyMap<string, readonly string[]> | undefined => {
  const dataQuery = useQuery({
    ...chatUnavailableSkillsOptions(
      organizationId ?? "",
      userId ?? SIGNED_OUT_QUERY_OWNER,
    ),
    enabled: organizationId !== undefined && userId !== undefined,
  });
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const data =
    dataView.type === "items" && dataView.refetchError === undefined
      ? dataView.items
      : undefined;
  return useMemo(
    () =>
      data === undefined
        ? undefined
        : new Map(
            data.unavailable.map(({ missingTools, skillId }) => [
              skillId,
              missingTools,
            ]),
          ),
    [data],
  );
};

/** The ids of {@link useChatUnavailableSkills}, as the slash menus take them. */
export const useChatUnavailableSkillIds = (
  organizationId: string | undefined,
  userId: string | undefined,
): UnavailableSkillIds => {
  const unavailable = useChatUnavailableSkills(organizationId, userId);
  return useMemo(
    () => (unavailable === undefined ? undefined : new Set(unavailable.keys())),
    [unavailable],
  );
};

/**
 * Skill availability for a composer's own chat: its send mode, web search,
 * open document, edit mode, matter and browser extension, each read live, so
 * the menu follows a switch the moment it flips. Without `chat` (a composer
 * that does not say which chat it is) it answers for the widest chat, as the
 * menus did before. `undefined` while the answer for this chat is loading.
 */
export const useComposerSkillAvailability = ({
  chat,
  enabled,
  organizationId,
  userId,
}: {
  chat: ComposerSkillChatContext | undefined;
  /** Fetch only while the menu is open; a cached answer still reads. */
  enabled: boolean;
  organizationId: string;
  userId: string;
}): ChatSkillMenuAvailability => {
  const anonymized = useOptionalChatAnonymized(chat?.threadRef);
  const browserExtension = useBrowserClientConnected();
  const query =
    chat === undefined
      ? undefined
      : chatSkillAvailabilityQuery({ anonymized, browserExtension, chat });
  const known = query !== null;
  const dataQuery = useQuery({
    ...chatUnavailableSkillsOptions(organizationId, userId, query ?? undefined),
    enabled: enabled && known,
  });
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const data =
    dataView.type === "items" && dataView.refetchError === undefined
      ? dataView.items
      : undefined;
  // A chat not known yet reads no answer, not the widest chat's cached one.
  return useMemo(
    () => (known ? chatSkillMenuAvailability(data) : undefined),
    [data, known],
  );
};
