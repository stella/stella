import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import {
  SourceLocatorLabel,
  sourceLocatorPage,
  useOpenSourceDocument,
} from "@/components/workspaces/list-source";
import { SourceVerificationAction } from "@/components/workspaces/source-verification-action";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { legalListSourcesOptions } from "@/lib/workspaces/queries/legal-lists";

type ListItemSourcesProps = {
  workspaceId: string;
  listId: string;
  itemEntityId: string;
};
export const ListItemSources = ({
  workspaceId,
  listId,
  itemEntityId,
}: ListItemSourcesProps) => {
  const t = useTranslations();
  const enabled = useCallerFeatureEnabled(CALLER_FEATURE.legalLists);
  const openSourceDocument = useOpenSourceDocument(workspaceId);
  const view = useQueryView(
    useQuery({
      ...legalListSourcesOptions(workspaceId, listId, itemEntityId),
      enabled,
    }),
  );
  useQueryViewError(view);
  if (!enabled) {
    return null;
  }
  const data = view.type === "items" ? view.items : undefined;
  return (
    <div className="grid gap-2">
      <QueryViewFeedback view={view} />
      {data?.items.map((source) => (
        <article className="rounded-lg border p-3" key={source.id}>
          <div className="flex items-center justify-between gap-2">
            <Button
              className="min-w-0 justify-start"
              size="xs"
              onClick={() =>
                openSourceDocument(
                  source.sourceEntityId,
                  sourceLocatorPage(source.locator),
                )
              }
              variant="link"
            >
              <span className="truncate">
                <SourceLocatorLabel locator={source.locator} />
              </span>
            </Button>
            <SourceVerificationAction
              itemEntityId={itemEntityId}
              listId={listId}
              sourceId={source.id}
              verified={source.verificationStatus === "verified"}
              workspaceId={workspaceId}
            />
          </div>
          {source.quote && (
            <blockquote className="text-muted-foreground mt-2 line-clamp-3 text-xs">
              {source.quote}
            </blockquote>
          )}
        </article>
      ))}
      {data?.items.length === 0 && (
        <p className="text-muted-foreground text-sm">{t("common.empty")}</p>
      )}
    </div>
  );
};
