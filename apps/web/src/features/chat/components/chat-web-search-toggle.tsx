import type { Query } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { GlobeIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import {
  invalidateChatThread,
  matchesChatThread,
} from "@/features/chat/queries";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

import { restoreChatWebSearchQuerySnapshots } from "./chat-web-search-toggle.logic";

type ChatWebSearchToggleProps = {
  disabled?: boolean;
  enabled: boolean;
  threadRef: ChatThreadRef;
  size?: "icon-sm" | "icon-xs" | undefined;
};

/**
 * Turns the thread's web search on or off: remembers the choice for new
 * chats and flips the thread optimistically until the server confirms. The
 * toggle and a skill row's "turn on web search" fix share it.
 */
export const useSetChatWebSearch = (
  threadRef: ChatThreadRef,
): ((enabled: boolean, options?: { onSaved?: () => void }) => void) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const setEnabledPreference = useChatWebSearchPreferenceStore(
    (state) => state.setEnabledPreference,
  );

  const { mutate } = useMutation({
    scope: {
      id: `chat-web-search-toggle:${threadRef.scope}:${threadRef.threadId}`,
    },
    mutationFn: async (nextEnabled: boolean) => {
      const response = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
        .patch(
          { webSearchEnabled: nextEnabled },
          {
            query:
              threadRef.scope === "workspace"
                ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
                : {},
          },
        );
      return unwrapEden(response);
    },
    onMutate: async (nextEnabled) => {
      // Every surface's canonical thread query hangs off
      // `chatKeys.threadPrefix` and carries `webSearchEnabled`.
      // Flipping them here turns the icon on/off instantly and smoothly
      // instead of snapping only once the PATCH round-trips.
      const filters = {
        predicate: (q: Query) => matchesChatThread(q.queryKey, threadRef),
      };
      await queryClient.cancelQueries(filters);
      const previous = queryClient.getQueriesData(filters);
      queryClient.setQueriesData(filters, (old) =>
        old !== undefined &&
        old !== null &&
        typeof old === "object" &&
        "webSearchEnabled" in old
          ? { ...old, webSearchEnabled: nextEnabled }
          : old,
      );
      return { previous };
    },
    onError: (error, _nextEnabled, context) => {
      if (context) {
        restoreChatWebSearchQuerySnapshots(queryClient, context.previous);
      }
      notifyUserError(error, t("errors.actionFailed"));
    },
    // Reconcile against the server on both paths: confirm the optimistic flip
    // on success, or land the rolled-back truth after an error.
    onSettled: () => {
      detached(
        invalidateChatThread({ queryClient, threadRef }),
        "chat-web-search-toggle.invalidate-chat-thread",
      );
    },
  });

  return (nextEnabled, options) => {
    setEnabledPreference(nextEnabled);
    mutate(nextEnabled, {
      // Only once the thread stores it, so a send that follows reads it.
      onSuccess: () => {
        options?.onSaved?.();
      },
    });
  };
};

export const ChatWebSearchToggle = ({
  disabled = false,
  enabled,
  threadRef,
  size = "icon-sm",
}: ChatWebSearchToggleProps) => {
  const t = useTranslations();
  const setWebSearch = useSetChatWebSearch(threadRef);
  const tooltipKey = enabled
    ? "chat.webSearch.toggleOff"
    : "chat.webSearch.toggleOn";

  return (
    <Button
      aria-label={t("chat.webSearch.toggleLabel")}
      aria-pressed={enabled}
      // Quiet status-row control: muted at rest, borderless, only the
      // usual ghost hover surface. The enabled state speaks through
      // the info-tinted icon, not a filled chip. ``
      // eases the on/off tint so the optimistic flip reads as a smooth
      // turn-on rather than a blip.
      className="text-muted-foreground hover:text-foreground"
      data-pressed={enabled ? "" : undefined}
      disabled={disabled}
      onClick={() => {
        setWebSearch(!enabled);
      }}
      size={size}
      tooltip={t(tooltipKey)}
      variant={enabled ? "secondary" : "ghost"}
    >
      <GlobeIcon
        className={cn(
          size === "icon-xs" ? "size-3.5" : "size-4",
          enabled && "text-info",
        )}
      />
    </Button>
  );
};
