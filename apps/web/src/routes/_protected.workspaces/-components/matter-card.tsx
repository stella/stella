import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  EllipsisVerticalIcon,
  FileIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";
import { Button } from "@stella/ui/components/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stella/ui/components/preview-card";
import { cn } from "@stella/ui/lib/utils";

import { useI18nStore } from "@/i18n/i18n-store";
import { getInitials } from "@/lib/get-initials";
import { getMatterColor } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { formatRelativeTime } from "@/lib/relative-time";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { overviewOptions } from "@/routes/_protected.workspaces/-queries";
import type { Workspace } from "@/routes/_protected.workspaces/-types";

type OverviewData = NonNullable<
  Awaited<
    ReturnType<
      Exclude<ReturnType<typeof overviewOptions>["queryFn"], undefined>
    >
  >
>;

const MAX_VISIBLE_CONTRIBUTORS = 4;

type MatterCardProps = {
  workspace: Workspace;
  focused: boolean;
  hideClientName?: boolean;
  onDelete: (id: string) => void;
};

export const MatterCard = ({
  workspace,
  focused,
  hideClientName,
  onDelete,
}: MatterCardProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const { togglePin, isPinned } = usePinnedStore();

  const pinned = isPinned(workspace.id);
  const lastActivityAt = formatRelativeTime(workspace.lastActivityAt, lang);
  const [previewEnabled, setPreviewEnabled] = useState(false);

  const { data: preview } = useQuery({
    ...overviewOptions(workspace.id),
    enabled: previewEnabled,
  });

  const displayable = workspace.contributors.filter((c) => Boolean(c.userName));
  const visibleContributors = displayable.slice(0, MAX_VISIBLE_CONTRIBUTORS);
  const overflow = displayable.length - MAX_VISIBLE_CONTRIBUTORS;

  const hasPreviewContent =
    !!preview &&
    (preview.documentCount > 0 ||
      preview.taskCount > 0 ||
      preview.recentEntities.length > 0);

  return (
    <PreviewCard
      onOpenChange={(open) => {
        if (open) {
          setPreviewEnabled(true);
        }
      }}
    >
      <PreviewCardTrigger
        delay={400}
        render={
          <Link
            className={cn(
              "group bg-card hover:bg-accent/50 relative flex flex-col justify-between overflow-hidden rounded-xl border px-3 py-2.5 transition-colors",
              focused && "ring-primary ring-2",
            )}
            params={{ workspaceId: workspace.id }}
            style={{
              borderInlineStartWidth: 3,
              borderInlineStartColor: getMatterColor(workspace.id),
            }}
            to="/workspaces/$workspaceId"
          />
        }
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{workspace.name}</h2>
            {!hideClientName && workspace.client && (
              <Link
                className="text-muted-foreground hover:text-foreground truncate text-xs hover:underline"
                onClick={(e) => e.stopPropagation()}
                params={{ contactId: workspace.client.id }}
                to="/contacts/$contactId"
              >
                {workspace.client.displayName}
              </Link>
            )}
          </div>

          <Menu>
            <MenuTrigger
              render={
                <Button
                  className="size-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <EllipsisVerticalIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup
              align="end"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              sideOffset={4}
            >
              <MenuItem onClick={() => togglePin(workspace.id)}>
                {pinned ? <PinOffIcon /> : <PinIcon />}
                {pinned ? t("common.unpin") : t("common.pin")}
              </MenuItem>
              <MenuItem
                onClick={() => onDelete(workspace.id)}
                variant="destructive"
              >
                <Trash2Icon />
                {t("common.delete")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>

        <Contributors
          overflow={overflow}
          visibleContributors={visibleContributors}
        />

        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {workspace.reference && (
            <>
              <span className="font-mono">{workspace.reference}</span>
              <span>·</span>
            </>
          )}
          <span>
            {workspace.entityCount > 0
              ? t("workspaces.entitiesCount", { count: workspace.entityCount })
              : t("workspaces.noItems")}
          </span>
          <span>·</span>
          <span
            title={new Date(workspace.lastActivityAt).toLocaleString(lang, {
              dateStyle: "full",
              timeStyle: "medium",
            })}
          >
            {t("workspaces.lastActive", { time: lastActivityAt })}
          </span>
        </div>
      </PreviewCardTrigger>

      {hasPreviewContent && (
        <PreviewPopupContent lang={lang} preview={preview} />
      )}
    </PreviewCard>
  );
};

type ContributorsProps = {
  visibleContributors: Workspace["contributors"];
  overflow: number;
};

const Contributors = ({ visibleContributors, overflow }: ContributorsProps) => {
  if (visibleContributors.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center py-0.5">
      {visibleContributors.map((c, i) => (
        <PreviewCard key={c.userId}>
          <PreviewCardTrigger
            delay={200}
            render={(props) => (
              <span
                {...props}
                className={cn("inline-block rounded-full", i > 0 && "-ms-1")}
                onPointerEnter={(e) => e.stopPropagation()}
              />
            )}
          >
            <Avatar className="ring-background size-5 ring-1">
              {c.userImage && <AvatarImage src={c.userImage} />}
              <AvatarFallback className="text-[0.5rem]">
                {getInitials(c.userName)}
              </AvatarFallback>
            </Avatar>
          </PreviewCardTrigger>
          <PreviewCardPopup className="p-2 text-xs" sideOffset={4}>
            {c.userName}
          </PreviewCardPopup>
        </PreviewCard>
      ))}
      {overflow > 0 && (
        <span className="text-muted-foreground ms-1 text-[0.625rem]">
          {`+${overflow}`}
        </span>
      )}
    </div>
  );
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
              <span className="text-muted-foreground shrink-0">
                {formatRelativeTime(entity.updatedAt, lang)}
              </span>
            )}
          </div>
        ))}
      </div>
    </PreviewCardPopup>
  );
};
