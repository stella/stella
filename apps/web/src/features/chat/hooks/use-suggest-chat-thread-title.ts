import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

/**
 * Requests an AI-proposed title for an existing conversation
 * (`POST /chat/threads/:threadId/title/suggest`). Read-only: the caller
 * decides whether to commit the suggestion through the rename PATCH.
 * Returns null (after toasting and capturing) on failure so callers can
 * simply drop the suggestion.
 */
export const useSuggestChatThreadTitle = (threadRef: ChatThreadRef) => {
  const t = useTranslations();
  const [isPending, setIsPending] = useState(false);

  const suggest = async (): Promise<string | null> => {
    setIsPending(true);
    const result = await Result.tryPromise(async () =>
      unwrapEden(
        await api.chat
          .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
          .title.suggest.post(undefined, {
            query:
              threadRef.scope === "workspace"
                ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
                : {},
          }),
      ),
    );
    setIsPending(false);

    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
      return null;
    }

    return result.value.title;
  };

  return { suggest, isPending };
};
