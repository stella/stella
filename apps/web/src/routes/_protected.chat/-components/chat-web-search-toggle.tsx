import type { Query } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GlobeIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useChatWebSearchPreferenceStore } from "@/lib/chat-web-search-store";
import { toAPIError, userErrorFromThrown } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { invalidateChatThread } from "@/routes/_protected.chat/-queries";

type ChatWebSearchToggleProps = {
  enabled: boolean;
  threadRef: ChatThreadRef;
  size?: "icon-sm" | "icon-xs" | undefined;
};

export const ChatWebSearchToggle = ({
  enabled,
  threadRef,
  size = "icon-sm",
}: ChatWebSearchToggleProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const setEnabledPreference = useChatWebSearchPreferenceStore(
    (state) => state.setEnabledPreference,
  );

  // Every cached query for this thread (the thread page's `chatThreadOptions`
  // and the new-chat hero's draft-meta both sit under the same
  // `chat/<org>/thread/<scope>/<…ids>` prefix) that carries a
  // `webSearchEnabled` field. Flipping them in `onMutate` turns the icon on/off
  // instantly and smoothly instead of snapping only once the PATCH round-trips.
  const matchesThisThread = (queryKey: readonly unknown[]): boolean => {
    if (
      queryKey.at(0) !== "chat" ||
      queryKey.at(2) !== "thread" ||
      queryKey.at(3) !== threadRef.scope
    ) {
      return false;
    }
    if (threadRef.scope === "global") {
      return queryKey.at(4) === threadRef.threadId;
    }
    return (
      queryKey.at(4) === threadRef.workspaceId &&
      queryKey.at(5) === threadRef.threadId
    );
  };

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
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onMutate: async (nextEnabled) => {
      const filters = {
        predicate: (q: Query) => matchesThisThread(q.queryKey),
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
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
    // Reconcile against the server on both paths: confirm the optimistic flip
    // on success, or land the rolled-back truth after an error.
    onSettled: () => {
      void invalidateChatThread({ queryClient, threadRef });
    },
  });

  const tooltipKey = enabled
    ? "chat.webSearch.toggleOff"
    : "chat.webSearch.toggleOn";

  return (
    <Tooltip
      content={t(tooltipKey)}
      render={
        <Button
          aria-label={t("chat.webSearch.toggleLabel")}
          aria-pressed={enabled}
          // Quiet status-row control: muted at rest, borderless, only the
          // usual ghost hover surface. The enabled state speaks through
          // the info-tinted icon, not a filled chip. `transition-colors`
          // eases the on/off tint so the optimistic flip reads as a smooth
          // turn-on rather than a blip.
          className="text-muted-foreground hover:text-foreground transition-colors"
          data-pressed={enabled ? "" : undefined}
          onClick={() => {
            const next = !enabled;
            setEnabledPreference(next);
            mutate(next);
          }}
          size={size}
          variant={enabled ? "secondary" : "ghost"}
        >
          <GlobeIcon
            className={cn(
              "transition-colors",
              size === "icon-xs" ? "size-3.5" : "size-4",
              enabled && "text-info",
            )}
          />
        </Button>
      }
    />
  );
};
