import { useSuspenseQuery } from "@tanstack/react-query";
import { FolderIcon, LayoutDashboardIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";

import { useI18nStore } from "@/i18n/i18n-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { isFileDisplayable } from "@/lib/types";
import { overviewOptions } from "@/routes/_protected.workspaces/-queries";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";

type OverviewViewProps = {
  workspaceId: string;
};

export const OverviewView = ({ workspaceId }: OverviewViewProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const { data } = useSuspenseQuery(overviewOptions(workspaceId));

  const hasActivity = data.recentEntities.length > 0;

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      {/* At a glance */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t("workspaces.overview.atAGlance")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label={t("workspaces.overview.totalDocuments")}
            value={data.documentCount}
          />
          {data.taskCount > 0 && (
            <StatCard
              label={t("workspaces.tasksCount", {
                count: data.taskCount,
              })}
              value={data.taskCount}
            />
          )}
        </div>
      </section>

      {/* Recent activity */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          {t("workspaces.overview.recentActivity")}
        </h2>
        {hasActivity ? (
          <div className="divide-y rounded-lg border">
            {data.recentEntities.map((entity) => {
              const navigable =
                entity.mimeType !== null &&
                entity.fieldId !== null &&
                isFileDisplayable({
                  mimeType: entity.mimeType,
                  pdfFileId: entity.pdfFileId,
                  encrypted: entity.encrypted,
                });

              const icon =
                entity.kind === "folder" ? (
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : entity.mimeType ? (
                  <DocumentIcon
                    className="size-4 shrink-0"
                    mimeType={entity.mimeType}
                  />
                ) : null;

              const row = (
                <>
                  {icon}
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {entity.name}
                  </span>
                  {entity.createdBy && (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Avatar className="size-4 text-[8px]">
                        {entity.createdByImage && (
                          <AvatarImage
                            alt={entity.createdBy}
                            src={entity.createdByImage}
                          />
                        )}
                        <AvatarFallback>
                          {entity.createdBy
                            .split(" ")
                            .map((w) => w.at(0))
                            .join("")
                            .toUpperCase()
                            .slice(0, 2)}
                        </AvatarFallback>
                      </Avatar>
                      {entity.createdBy}
                    </span>
                  )}
                  {entity.updatedAt && (
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatRelativeTime(entity.updatedAt, lang)}
                    </span>
                  )}
                </>
              );

              const { fieldId } = entity;
              if (navigable && fieldId) {
                return (
                  <button
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50"
                    key={entity.entityId}
                    onClick={() =>
                      usePeekStore.getState().openTab({
                        fieldId,
                        entityId: entity.entityId,
                        label: entity.name,
                      })
                    }
                    type="button"
                  >
                    {row}
                  </button>
                );
              }

              return (
                <div
                  className="flex items-center gap-3 px-4 py-2.5"
                  key={entity.entityId}
                >
                  {row}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={LayoutDashboardIcon}
            message={t("workspaces.overview.getStarted")}
            workspaceId={workspaceId}
          />
        )}
      </section>
    </div>
  );
};

type StatCardProps = {
  label: string;
  value: number;
};

const StatCard = ({ label, value }: StatCardProps) => (
  <div className="flex flex-col gap-1 rounded-lg border bg-card px-4 py-3">
    <span className="text-2xl font-semibold tabular-nums">{value}</span>
    <span className="text-xs text-muted-foreground capitalize">{label}</span>
  </div>
);
