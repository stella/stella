import { useCallback, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { FolderIcon, LayoutDashboardIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import { cn } from "@stella/ui/lib/utils";

import { useI18nStore } from "@/i18n/i18n-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { isFileDisplayable } from "@/lib/types";
import { overviewOptions } from "@/routes/_protected.workspaces/-queries";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { usePeekStore } from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";

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
            {data.recentEntities.map((entity) => (
              <OverviewRow
                entity={entity}
                key={entity.entityId}
                lang={lang}
                workspaceId={workspaceId}
              />
            ))}
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

// -- Overview entity row with context menu + actions --

type OverviewEntity = {
  entityId: string;
  name: string;
  kind: string;
  mimeType: string | null;
  fieldId: string | null;
  pdfFileId: string | null;
  encrypted: boolean;
  createdBy: string | null;
  createdByImage: string | null;
  updatedAt: string | null;
};

type OverviewRowProps = {
  entity: OverviewEntity;
  workspaceId: string;
  lang: string;
};

type VirtualAnchor = {
  getBoundingClientRect: () => DOMRect;
};

const OverviewRow = ({ entity, workspaceId, lang }: OverviewRowProps) => {
  const [contextOpen, setContextOpen] = useState(false);
  const [contextAnchor, setContextAnchor] = useState<VirtualAnchor | null>(
    null,
  );

  // Look up the full entity from the workspace store so
  // RowActions has the complete data (fields, etc.).
  const fullEntity = useWorkspaceStore((s) =>
    s.data.find((e) => e.entityId === entity.entityId),
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!fullEntity) {
        return;
      }
      e.preventDefault();
      const { clientX: x, clientY: y } = e;
      setContextAnchor({
        getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
      });
      setContextOpen(true);
    },
    [fullEntity],
  );

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
      <DocumentIcon className="size-4 shrink-0" mimeType={entity.mimeType} />
    ) : null;

  const { fieldId } = entity;

  const handleOpen =
    navigable && fieldId
      ? () =>
          usePeekStore.getState().openTab({
            fieldId,
            entityId: entity.entityId,
            label: entity.name,
          })
      : undefined;

  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm">{entity.name}</span>
      {entity.createdBy && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Avatar className="size-4 text-[8px]">
            {entity.createdByImage && (
              <AvatarImage alt={entity.createdBy} src={entity.createdByImage} />
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
      {fullEntity && (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: event-capture wrapper
        // biome-ignore lint/a11y/useKeyWithClickEvents: event-capture wrapper
        // biome-ignore lint/a11y/noStaticElementInteractions: event-capture wrapper
        <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <RowActions
            anchor={contextAnchor}
            entity={fullEntity}
            onOpen={handleOpen}
            onOpenChange={(o) => {
              setContextOpen(o);
              if (!o) {
                setContextAnchor(null);
              }
            }}
            open={contextOpen}
            workspaceId={workspaceId}
          />
        </span>
      )}
    </>
  );

  const handleKeyDown = handleOpen
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleOpen();
        }
      }
    : undefined;

  return (
    // Use a <div> instead of <button> to avoid invalid
    // nested <button> elements (RowActions renders a
    // <button> menu trigger inside).
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: div-as-button pattern
    // biome-ignore lint/a11y/noStaticElementInteractions: has role="button" when interactive
    <div
      className={cn(
        "group/row flex items-center gap-3 px-4 py-2.5 hover:bg-muted/50",
        handleOpen && "w-full cursor-pointer text-left",
      )}
      onClick={handleOpen}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      role={handleOpen ? "button" : undefined}
      tabIndex={handleOpen ? 0 : undefined}
    >
      {content}
    </div>
  );
};
