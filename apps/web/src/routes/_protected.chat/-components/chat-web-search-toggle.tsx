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

  const { mutate, isPending } = useMutation({
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
    onSuccess: () => {
      void invalidateChatThread({ queryClient, threadRef });
    },
    onError: (error) => {
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
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
          data-pressed={enabled ? "" : undefined}
          disabled={isPending}
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
              size === "icon-xs" ? "size-3.5" : "size-4",
              enabled && "text-info",
            )}
          />
        </Button>
      }
    />
  );
};
