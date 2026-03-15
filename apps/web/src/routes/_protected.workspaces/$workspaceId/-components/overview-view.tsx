import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useSuspenseQuery } from "@tanstack/react-query";
import { LayoutDashboardIcon, SquareCheckIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import { renderDragPreview } from "@/components/drag-preview";
import { PersonMentionLabel } from "@/components/person-mention-label";
import { useI18nStore } from "@/i18n/i18n-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { isFileDisplayable } from "@/lib/types";
import type { EntityKind, WorkspaceEntity } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { ENTITY_DRAG_TYPE } from "@/routes/_protected.workspaces/$workspaceId/-components/drag-constants";
import { EmptyState } from "@/routes/_protected.workspaces/$workspaceId/-components/empty-state";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { RowActions } from "@/routes/_protected.workspaces/$workspaceId/-components/row-actions";
import { useInspectorFlash } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-inspector-flash";
import { overviewOptions } from "@/routes/_protected.workspaces/-queries";

type OverviewViewProps = {
  workspaceId: string;
};

export const OverviewView = ({ workspaceId }: OverviewViewProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const { data } = useSuspenseQuery(overviewOptions(workspaceId));

  const recentEntities = useMemo(
    () => data.recentEntities.filter((e) => e.kind !== "folder"),
    [data.recentEntities],
  );
  const hasActivity = recentEntities.length > 0;

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      {/* At a glance */}
      <section>
        <h2 className="text-muted-foreground mb-3 text-sm font-medium">
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
        <h2 className="text-muted-foreground mb-3 text-sm font-medium">
          {t("workspaces.overview.recentActivity")}
        </h2>
        {hasActivity ? (
          <div className="divide-y rounded-lg border">
            {recentEntities.map((entity) => (
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
  <div className="bg-card flex flex-col gap-1 rounded-lg border px-4 py-3">
    <span className="text-2xl font-semibold tabular-nums">{value}</span>
    <span className="text-muted-foreground text-xs capitalize">{label}</span>
  </div>
);

// -- Overview entity row with context menu + actions --

type OverviewEntity = {
  entityId: string;
  name: string;
  kind: EntityKind;
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
  const rowRef = useRef<HTMLDivElement>(null);

  useInspectorFlash(entity.entityId, rowRef);

  // Construct a WorkspaceEntity from overview data so RowActions
  // can render. The overview endpoint returns enough metadata to
  // build a synthetic fields record for the primary file.
  // Previously TODO by @nnad3N — now resolved.
  const fullEntity = useMemo((): WorkspaceEntity => {
    const fields: WorkspaceEntity["fields"] = {};
    if (entity.fieldId && entity.mimeType) {
      fields[entity.fieldId] = {
        id: entity.fieldId,
        entityId: entity.entityId,
        content: {
          type: "file",
          version: 1,
          id: entity.fieldId,
          fileName: entity.name,
          mimeType: entity.mimeType,
          sizeBytes: 0,
          encrypted: entity.encrypted,
          sha256Hex: "",
          pdfFileId: entity.pdfFileId,
        },
      };
    }
    return {
      entityId: entity.entityId,
      kind: entity.kind,
      name: entity.name,
      parentId: null,
      createdAt: entity.updatedAt ?? "",
      createdBy: entity.createdBy,
      createdByImage: entity.createdByImage,
      updatedAt: entity.updatedAt,
      version: 0,
      status: null,
      priority: null,
      dueDate: null,
      sortOrder: null,
      fields,
    };
  }, [entity]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const { clientX: x, clientY: y } = e;
    setContextAnchor({
      getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    });
    setContextOpen(true);
  }, []);

  const navigable =
    entity.mimeType !== null &&
    entity.fieldId !== null &&
    isFileDisplayable({
      mimeType: entity.mimeType,
      pdfFileId: entity.pdfFileId,
      encrypted: entity.encrypted,
    });

  const icon =
    entity.kind === "task" ? (
      <SquareCheckIcon className="text-muted-foreground size-4 shrink-0" />
    ) : entity.mimeType ? (
      <DocumentIcon className="size-4 shrink-0" mimeType={entity.mimeType} />
    ) : null;

  useEffect(() => {
    const el = rowRef.current;
    if (!el) {
      return;
    }
    return draggable({
      element: el,
      getInitialData: () => ({
        type: ENTITY_DRAG_TYPE,
        entityId: entity.entityId,
        name: entity.name,
        kind: entity.kind,
        mimeType: entity.mimeType,
        entityIds: [entity.entityId],
        entities: [
          {
            entityId: entity.entityId,
            name: entity.name,
            kind: entity.kind,
            mimeType: entity.mimeType,
            parentId: null,
          },
        ],
      }),
      onGenerateDragPreview: ({ nativeSetDragImage }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          render: ({ container }) =>
            renderDragPreview(container, {
              name: entity.name,
              kind: entity.kind,
              mimeType: entity.mimeType,
            }),
        });
      },
    });
  }, [entity.entityId, entity.name, entity.kind, entity.mimeType]);

  const { fieldId } = entity;

  const handleOpen =
    entity.kind === "task"
      ? () =>
          useInspectorStore.getState().openTask(entity.entityId, entity.name)
      : navigable && fieldId
        ? () =>
            useInspectorStore.getState().openPdf({
              id: fieldId,
              entityId: entity.entityId,
              label: entity.name,
              mimeType: entity.mimeType ?? undefined,
              workspaceId,
            })
        : undefined;

  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm">{entity.name}</span>
      {entity.createdBy && (
        <PersonMentionLabel
          avatarClassName="size-4 text-[8px]"
          className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs"
          mention={{
            name: entity.createdBy,
            image: entity.createdByImage,
          }}
        />
      )}
      {entity.updatedAt && (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {formatRelativeTime(entity.updatedAt, lang)}
        </span>
      )}
      {/* TODO: fix this */}
      {/* oxlint-disable-next-line jsx_a11y/click-events-have-key-events, jsx_a11y/no-static-element-interactions */}
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
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className={cn(
        "group/row hover:bg-muted/50 flex items-center gap-3 px-4 py-2.5",
        handleOpen && "w-full cursor-pointer text-start",
      )}
      onClick={handleOpen}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      ref={rowRef}
      role={handleOpen ? "button" : undefined}
      tabIndex={handleOpen ? 0 : undefined}
    >
      {content}
    </div>
  );
};
