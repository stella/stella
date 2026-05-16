import { useEffect, useRef } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  FileTextIcon,
  LayersIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PanelRightIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/components/scroll-area";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import {
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";
import { resolveMatterColor } from "@/lib/matter-colors";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";
import {
  ExternalSourceLogo,
  findMcpConnectorIconHref,
} from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/external-reference-panel";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import type { InspectorTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { buildMaximizeTabAction } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/maximize-tab";
import { useRailContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-rail-context-menu";
import { useTabContextMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/use-tab-context-menu";

type InspectorRailProps = {
  activeId: string | null;
  minimized: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenChat: (
    args?: Parameters<
      (args?: {
        workspaceId?: string | undefined;
        contextMatterIds?: string[];
      }) => void
    >[0],
  ) => void;
  onSetMinimized: (minimized: boolean) => void;
  tabs: InspectorTab[];
  workspaceId?: string | undefined;
};

export const InspectorRail = ({
  activeId,
  minimized,
  onActivateTab,
  onCloseTab,
  onOpenChat,
  onSetMinimized,
  tabs,
  workspaceId,
}: InspectorRailProps) => {
  const t = useTranslations();
  const railContextMenu = useRailContextMenu({ workspaceId });

  const openContextChat = () => {
    onOpenChat(
      workspaceId === undefined
        ? {}
        : { workspaceId, contextMatterIds: [workspaceId] },
    );
  };

  return (
    <div
      className={cn(
        "bg-muted/50 flex shrink-0 flex-col border-e",
        SIDE_RAIL_WIDTH,
      )}
    >
      <div
        className={cn(
          "flex w-full shrink-0 items-center justify-center border-b",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Tooltip
          content={(() => {
            if (tabs.length === 0) {
              return t("inspector.openChat");
            }
            if (minimized) {
              return t("inspector.showPane");
            }
            return t("inspector.hidePane");
          })()}
          render={
            <button
              aria-label={(() => {
                if (tabs.length === 0) {
                  return t("inspector.openChat");
                }
                if (minimized) {
                  return t("inspector.showPane");
                }
                return t("inspector.hidePane");
              })()}
              className={cn(
                "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center rounded-md transition-colors",
                SIDE_RAIL_ICON_BUTTON_SIZE,
              )}
              onClick={() => {
                if (tabs.length === 0) {
                  openContextChat();
                  return;
                }
                onSetMinimized(!minimized);
              }}
              type="button"
            />
          }
          side="left"
        >
          <PanelRightIcon className="size-4" />
        </Tooltip>
      </div>
      <ScrollArea className="flex-1">
        <div
          className="flex h-full flex-col"
          onContextMenu={(event) => {
            event.preventDefault();
            railContextMenu.openAt(event);
          }}
        >
          {tabs.map((tab) => (
            <VerticalTab
              active={tab.id === activeId}
              key={tab.id}
              onActivate={() => {
                onActivateTab(tab.id);
              }}
              onClose={() => {
                onCloseTab(tab.id);
              }}
              tab={tab}
            />
          ))}
        </div>
      </ScrollArea>
      {railContextMenu.element}
      <div
        className={cn(
          "flex w-full shrink-0 items-center justify-center border-t",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Tooltip
          content={t("chat.newChat")}
          render={
            <button
              aria-label={t("chat.newChat")}
              className={cn(
                "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center justify-center rounded-md transition-colors",
                SIDE_RAIL_ICON_BUTTON_SIZE,
              )}
              onClick={openContextChat}
              type="button"
            />
          }
          side="left"
        >
          <MessageSquarePlusIcon className="size-4" />
        </Tooltip>
      </div>
    </div>
  );
};

/** Extract a short abbreviation from a filename (stem, not extension). */
const getTabAbbrev = (label: string): string => {
  const dot = label.lastIndexOf(".");
  const stem = dot === -1 ? label : label.slice(0, dot);
  return stem.slice(0, 3);
};

type VerticalTabIconProps = {
  tab: InspectorTab;
  active: boolean;
  externalIconHref?: string | undefined;
};

const VerticalTabIcon = ({
  tab,
  active,
  externalIconHref,
}: VerticalTabIconProps) => {
  if (tab.type === "task") {
    return (
      <EntityKindIcon className="size-3.5" kind="task" status={tab.status} />
    );
  }

  if (tab.type === "chat") {
    return <MessageSquareIcon className="size-3.5" />;
  }

  if (tab.type === "matter") {
    const swatch = resolveMatterColor(tab.workspaceId, tab.color ?? null);
    return <LayersIcon className="size-3.5" style={{ color: swatch }} />;
  }

  if (tab.type === "external") {
    return (
      <ExternalSourceLogo
        className="size-3.5 border-0"
        iconHref={externalIconHref}
      />
    );
  }

  if (active && tab.mimeType) {
    return <DocumentIcon className="size-3.5" mimeType={tab.mimeType} />;
  }

  if (active) {
    return <FileTextIcon className="size-3.5" />;
  }

  return (
    <span className="text-[9px] leading-none font-semibold tracking-tight uppercase">
      {getTabAbbrev(tab.label)}
    </span>
  );
};

type VerticalTabProps = {
  tab: InspectorTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
};

const VerticalTab = ({
  tab,
  active,
  onActivate,
  onClose,
}: VerticalTabProps) => {
  const tooltipLabel = tab.label || tab.id.slice(0, 6);
  const tabRef = useRef<HTMLButtonElement>(null);
  const tabNavigate = useNavigate();
  const tabQueryClient = useQueryClient();
  const externalConnectorSlug =
    tab.type === "external" ? tab.connectorSlug : undefined;
  const storedExternalIconHref =
    tab.type === "external" ? tab.iconHref : undefined;
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(),
    enabled:
      externalConnectorSlug !== undefined &&
      storedExternalIconHref === undefined,
  });
  const externalIconHref =
    storedExternalIconHref ??
    (externalConnectorSlug === undefined
      ? undefined
      : findMcpConnectorIconHref({
          connectorSlug: externalConnectorSlug,
          connectors: mcpConnectorsData?.connectors ?? [],
        }));

  const contextMenu = useTabContextMenu({
    canRename: tab.type !== "matter",
    tabId: tab.id,
    onClose,
    onMaximize: buildMaximizeTabAction(tab, {
      navigate: tabNavigate,
      queryClient: tabQueryClient,
    }),
  });

  // Flash the tab on (re-)activation.
  const activationSeq = useInspectorStore((s) => s.activationSeq);
  const prevSeq = useRef(activationSeq);
  useEffect(() => {
    const el = tabRef.current;
    if (el && active && activationSeq !== prevSeq.current) {
      el.animate(
        [
          {
            backgroundColor: "var(--color-primary)",
            opacity: 0.7,
          },
          {
            backgroundColor: "transparent",
            opacity: 1,
          },
        ],
        { duration: 400, easing: "ease-out" },
      );
    }
    prevSeq.current = activationSeq;
  }, [active, activationSeq]);

  return (
    <>
      <Tooltip
        content={tooltipLabel}
        render={
          <button
            ref={tabRef}
            aria-label={tooltipLabel}
            className={cn(
              "group/tab relative flex min-h-8 w-full items-center justify-center border-b transition-colors",
              "text-muted-foreground hover:bg-accent hover:text-foreground",
              TOOLBAR_ROW_HEIGHT,
              active &&
                cn(
                  "bg-background text-foreground before:bg-primary",
                  "before:absolute",
                  "before:inset-y-0",
                  "before:inset-s-0 before:w-0.5",
                ),
            )}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose();
              }
            }}
            onClick={onActivate}
            onContextMenu={contextMenu.openAt}
            type="button"
          />
        }
        side="left"
      >
        <VerticalTabIcon
          active={active}
          externalIconHref={externalIconHref}
          tab={tab}
        />
      </Tooltip>
      {contextMenu.element}
    </>
  );
};
