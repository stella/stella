import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import {
  invalidateMemories,
  memoriesOptions,
} from "@/routes/_protected.settings/-queries/memories";

type SuggestionsQueueProps =
  | { scope: "user"; workspaceId?: never }
  | { scope: "workspace"; workspaceId: string };

export const SuggestionsQueue = (props: SuggestionsQueueProps) => {
  const { scope } = props;
  const t = useTranslations();
  const commonT = useTranslations("common");
  const tErrors = useTranslations("errors");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const workspaceId =
    props.scope === "workspace" ? props.workspaceId : undefined;

  const { data } = useInfiniteQuery(
    memoriesOptions({
      activeOrganizationId,
      scope,
      status: "suggested",
      ...(workspaceId !== undefined && { workspaceId }),
    }),
  );

  const reviewSuggestion = useMutation({
    mutationFn: async ({
      memoryId,
      status,
    }: {
      memoryId: string;
      status: "active" | "archived";
    }) => {
      const response = await api
        .memories({ memoryId: toSafeId<"aiMemory">(memoryId) })
        .patch({ status });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: async () => {
      await invalidateMemories(queryClient, activeOrganizationId);
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({ title: tErrors("actionFailed"), type: "error" });
    },
  });

  const suggestions = data?.pages.flatMap((page) => page.items) ?? [];

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <section className="border-primary/20 bg-primary/5 flex flex-col gap-2 rounded-lg border p-3">
      <h3 className="text-sm font-medium">{t("memory.suggestionsTitle")}</h3>
      <p className="text-muted-foreground text-xs">
        {t("memory.suggestionsDescription")}
      </p>
      <ul className="flex flex-col gap-2">
        {suggestions.map((suggestion) => (
          <li
            className="bg-card flex items-start justify-between gap-3 rounded-md border p-2.5"
            key={suggestion.id}
          >
            <p className="text-sm whitespace-pre-wrap">{suggestion.content}</p>
            <div className="flex shrink-0 gap-2">
              <Button
                disabled={reviewSuggestion.isPending}
                onClick={() =>
                  reviewSuggestion.mutate({
                    memoryId: suggestion.id,
                    status: "archived",
                  })
                }
                size="sm"
                variant="ghost"
              >
                {commonT("decline")}
              </Button>
              <Button
                disabled={reviewSuggestion.isPending}
                onClick={() =>
                  reviewSuggestion.mutate({
                    memoryId: suggestion.id,
                    status: "active",
                  })
                }
                size="sm"
              >
                {commonT("accept")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
