import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { ChatThreadRef } from "@/features/chat/chat-thread-ref-types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
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
      unwrapApiResponse(
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
      getAnalytics().captureError(result.error, {
        fingerprintKey: "useSuggestChatThreadTitle.suggest:failure",
        scope: {
          type: "handler",
          handlerId: "useSuggestChatThreadTitle.suggest:failure",
        },
      });
      notifyUserError(result.error, t("common.somethingWentWrong"));
      return null;
    }

    return result.value.title;
  };

  return { suggest, isPending };
};
