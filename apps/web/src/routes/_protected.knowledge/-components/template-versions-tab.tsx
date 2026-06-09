import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import { VersionList, VersionRow } from "@/components/versions/version-list";
import type { VersionDiffSegment } from "@/components/versions/version-list";
import { api } from "@/lib/api";
import { toAPIError, userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { templateVersionsOptions } from "@/routes/_protected.knowledge/-queries";

// ── Types ────────────────────────────────────────────

type TemplateVersionsTabProps = {
  templateId: string;
};

// ── Component ────────────────────────────────────────

const protectedRouteApi = getRouteApi("/_protected");

export const TemplateVersionsTab = ({
  templateId,
}: TemplateVersionsTabProps) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    templateVersionsOptions(activeOrganizationId, templateId),
  );

  const versions = data?.pages.flatMap((page) => page.items) ?? [];
  // Pages are newest-first; the first loaded row is the current
  // version (saves always append the highest version number).
  const currentVersionId = data?.pages.at(0)?.items.at(0)?.id;

  const handleDownload = async (versionId: string) => {
    const response = await api
      .templates({ templateId: toSafeId<"template">(templateId) })
      .versions({ versionId: toSafeId<"templateVersion">(versionId) })
      .get();

    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("templates.loadFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const { data: version } = response;
    if ("downloadUrl" in version && typeof version.downloadUrl === "string") {
      window.open(version.downloadUrl, "_blank");
    }
  };

  const buildLoadDiff =
    (versionId: string) => async (): Promise<VersionDiffSegment[]> => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .versions({ versionId: toSafeId<"templateVersion">(versionId) })
        .diff.get();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data.segments;
    };

  const buildSummarize =
    (versionId: string) => async (): Promise<string | null> => {
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .versions({ versionId: toSafeId<"templateVersion">(versionId) })
        .summarize.post({});
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data.summary;
    };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.discovering")}
        </p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.loadFailed")}
        </p>
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <p className="text-muted-foreground mt-4 py-4 text-center text-sm">
        {t("templates.versionsEmpty")}
      </p>
    );
  }

  return (
    <div className="mt-4 rounded-lg border">
      <VersionList>
        {versions.map((version) => (
          <VersionRow
            key={version.id}
            actions={
              <Button
                aria-label={t("common.download")}
                onClick={() => {
                  void handleDownload(version.id);
                }}
                size="icon-xs"
                title={t("common.download")}
                variant="ghost"
              >
                <DownloadIcon className="size-3.5" />
              </Button>
            }
            author={version.author}
            createdAt={version.createdAt}
            isCurrent={version.id === currentVersionId}
            loadDiff={buildLoadDiff(version.id)}
            meta={
              <span className="text-muted-foreground text-xs">
                {t("templates.fieldCount", { count: version.fieldCount })}
              </span>
            }
            summarize={buildSummarize(version.id)}
            title={t("templates.versionLabel", {
              version: String(version.version),
            })}
          />
        ))}
      </VersionList>
      {hasNextPage && (
        <div className="border-t p-1">
          <Button
            className="text-muted-foreground w-full"
            disabled={isFetchingNextPage}
            onClick={() => {
              void fetchNextPage();
            }}
            size="sm"
            variant="ghost"
          >
            {t("common.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
};
