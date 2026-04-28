import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stella/ui/components/preview-card";
import { cn } from "@stella/ui/lib/utils";

import { useI18nStore } from "@/i18n/i18n-store";
import { getMatterColor } from "@/lib/matter-colors";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { InlineEdit } from "@/routes/_protected.workspaces/$workspaceId/-components/inline-edit";
import { MatterContextMenu } from "@/routes/_protected.workspaces/-components/matter-context-menu";
import { overviewOptions } from "@/routes/_protected.workspaces/-queries";
import type { Workspace } from "@/routes/_protected.workspaces/-types";

type OverviewData = NonNullable<
  Awaited<
    ReturnType<
      Exclude<ReturnType<typeof overviewOptions>["queryFn"], undefined>
    >
  >
>;

const DAY_MS = 86_400_000;

type MatterCardProps = {
  workspace: Workspace;
  focused: boolean;
  hideClientName?: boolean;
};

export const MatterCard = ({
  workspace,
  focused,
  hideClientName,
}: MatterCardProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);

  const lastActivityAt = formatRelativeTime(workspace.lastActivityAt, lang);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const { data: preview } = useQuery({
    ...overviewOptions(workspace.id),
    enabled: previewEnabled,
  });

  const hasPreviewContent =
    !!preview &&
    (preview.documentCount > 0 ||
      preview.taskCount > 0 ||
      preview.recentEntities.length > 0);

  const recencyClass = getRecencyClass(workspace.lastActivityAt);
  const deadline = getDeadlineInfo(workspace.nextDeadline, lang);

  return (
    <MatterContextMenu
      workspaceId={workspace.id}
      workspaceName={workspace.name ?? t("workspaces.defaultName")}
    >
      {(rename) => (
        <PreviewCard
          open={previewOpen}
          onOpenChange={(open) => {
            setPreviewOpen(open);
            if (open) {
              setPreviewEnabled(true);
            }
          }}
        >
          <PreviewCardTrigger
            closeDelay={0}
            delay={400}
            render={
              <div
                className={cn(
                  "bg-card hover:bg-accent/30 relative flex flex-col gap-1 overflow-hidden rounded-xl border px-3 py-2 transition-colors",
                  focused && "ring-primary ring-2",
                )}
                style={{
                  borderInlineStartWidth: 3,
                  borderInlineStartColor: getMatterColor(workspace.id),
                }}
              />
            }
          >
            {/* Line 1: name + reference */}
            <div className="flex items-center gap-2">
              <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
                {rename.status === "editing" ? (
                  <InlineEdit
                    onChange={rename.setDraft}
                    onCancel={rename.cancel}
                    onCommit={rename.commit}
                    value={rename.draft}
                  />
                ) : (
                  <Link
                    className="after:absolute after:inset-0"
                    onClick={() => setPreviewOpen(false)}
                    params={{ workspaceId: workspace.id }}
                    to="/workspaces/$workspaceId"
                  >
                    {workspace.name}
                  </Link>
                )}
              </h2>
              {rename.status !== "editing" && workspace.reference && (
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {workspace.reference}
                </span>
              )}
            </div>

            {/* Line 1.5: client name (flat view only) */}
            {!hideClientName && (
              <Link
                className="text-muted-foreground hover:text-foreground relative z-10 -mt-1 truncate text-xs hover:underline"
                onClick={(e) => e.stopPropagation()}
                params={{ contactId: workspace.client.id }}
                to="/contacts/$contactId"
              >
                {workspace.client.displayName}
              </Link>
            )}

            {/* Line 2: tasks/items + deadline (left) | last active (right) */}
            <div className="flex items-center justify-between gap-2 text-xs">
              <div className="text-muted-foreground flex items-center gap-1.5">
                <span>
                  {workspace.openTaskCount > 0
                    ? t("workspaces.tasksCount", {
                        count: workspace.openTaskCount,
                      })
                    : workspace.entityCount > 0
                      ? t("workspaces.entitiesCount", {
                          count: workspace.entityCount,
                        })
                      : t("workspaces.noItems")}
                </span>
                {deadline && (
                  <>
                    <span>·</span>
                    <span className={deadline.className}>{deadline.label}</span>
                  </>
                )}
              </div>
              <span
                className={cn("shrink-0", recencyClass)}
                title={new Date(workspace.lastActivityAt).toLocaleString(lang, {
                  dateStyle: "full",
                  timeStyle: "medium",
                })}
              >
                {lastActivityAt}
              </span>
            </div>
          </PreviewCardTrigger>

          {hasPreviewContent && (
            <PreviewPopupContent lang={lang} preview={preview} />
          )}
        </PreviewCard>
      )}
    </MatterContextMenu>
  );
};

/** Color-code recency: today = foreground, this week = muted, older = faded. */
const getRecencyClass = (date: Date | string): string => {
  const age = Date.now() - new Date(date).getTime();
  if (age < DAY_MS) {
    return "text-foreground text-xs";
  }
  if (age < 7 * DAY_MS) {
    return "text-muted-foreground text-xs";
  }
  return "text-muted-foreground/50 text-xs";
};

type DeadlineInfo = { label: string; className: string };

/** Format deadline with urgency color. Returns null if no deadline. */
const getDeadlineInfo = (
  deadline: string | null,
  lang: string,
): DeadlineInfo | null => {
  if (!deadline) {
    return null;
  }

  const dueDate = new Date(`${deadline}T23:59:59`);
  if (Number.isNaN(dueDate.getTime())) {
    return null;
  }
  const now = Date.now();
  const diff = dueDate.getTime() - now;
  const label = formatRelativeTime(new Date(`${deadline}T00:00:00`), lang);

  if (diff < 0) {
    return { label, className: "text-destructive font-medium" };
  }
  if (diff < 2 * DAY_MS) {
    return { label, className: "text-warning font-medium" };
  }
  if (diff < 7 * DAY_MS) {
    return { label, className: "text-foreground" };
  }
  return { label, className: "text-muted-foreground" };
};

type PreviewPopupContentProps = {
  preview: OverviewData;
  lang: string;
};

const PreviewPopupContent = ({ preview, lang }: PreviewPopupContentProps) => {
  const t = useTranslations();

  return (
    <PreviewCardPopup className="p-3" sideOffset={8}>
      <div className="min-w-0 flex-1">
        {(preview.documentCount > 0 || preview.taskCount > 0) && (
          <div className="mb-2 flex gap-1">
            <div className="bg-muted flex-1 rounded px-2 py-1 text-center text-xs tabular-nums">
              {t("workspaces.documentsCount", { count: preview.documentCount })}
            </div>
            {preview.taskCount > 0 && (
              <div className="bg-muted flex-1 rounded px-2 py-1 text-center text-xs tabular-nums">
                {t("workspaces.tasksCount", { count: preview.taskCount })}
              </div>
            )}
          </div>
        )}
        {preview.recentEntities.slice(0, 3).map((entity) => (
          <div
            className="flex items-center gap-2 py-1 text-xs"
            key={entity.entityId}
          >
            {entity.mimeType ? (
              <DocumentIcon
                className="size-3.5 shrink-0"
                mimeType={entity.mimeType}
              />
            ) : (
              <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{entity.name}</span>
            {entity.updatedAt && (
              <span
                className="text-muted-foreground shrink-0"
                title={formatFullTimestamp(entity.updatedAt, lang)}
              >
                {formatRelativeTime(entity.updatedAt, lang)}
              </span>
            )}
          </div>
        ))}
      </div>
    </PreviewCardPopup>
  );
};
