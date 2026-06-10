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
import { containedHandler } from "@stll/ui/hooks/use-contained-handler";
import { cn } from "@stll/ui/lib/utils";

import {
  ExternalSourceLogo,
  findMcpConnectorIconHref,
} from "@/components/inspector/external-reference-panel";
import {
  isGenericInspectorTab,
  useInspectorStore,
} from "@/components/inspector/inspector-store";
import type { InspectorTab } from "@/components/inspector/inspector-store";
import { buildMaximizeTabAction } from "@/components/inspector/maximize-tab";
import { useRailContextMenu } from "@/components/inspector/use-rail-context-menu";
import { useTabContextMenu } from "@/components/inspector/use-tab-context-menu";
import { getInspectorView } from "@/components/inspector/view-registry";
import Tooltip from "@/components/tooltip";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  SIDE_RAIL_CONTAINER_CLASS,
  SIDE_RAIL_ICON_BUTTON_SIZE,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";
import { resolveMatterColor } from "@/lib/matter-colors";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { EntityKindIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/entity-kind-icon";

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
    <div className={SIDE_RAIL_CONTAINER_CLASS}>
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
          <SuggestedReviveTab />
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

type FileTabIconProps = {
  active: boolean;
  label: string;
  fileName: string;
  mimeType: string | undefined;
};

/** Rail icon for any file-like tab: the mime glyph when the tab is the open one,
 * the filename abbreviation otherwise. Shared by workspace file tabs and skill
 * resources so every file reads the same way in the rail. */
const FileTabIcon = ({
  active,
  fileName,
  label,
  mimeType,
}: FileTabIconProps) => {
  if (active && mimeType) {
    return (
      <DocumentIcon
        className="size-3.5"
        fileName={fileName}
        mimeType={mimeType}
      />
    );
  }
  if (active) {
    return <FileTextIcon className="size-3.5" />;
  }
  return (
    <span className="text-[9px] leading-none font-semibold tracking-tight uppercase">
      {getTabAbbrev(label)}
    </span>
  );
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
  // Generic registry-backed kinds (registered by non-workspace
  // routes) delegate their rail icon to the registration so the
  // rail stays open to extension without growing this switch.
  if (isGenericInspectorTab(tab)) {
    const registration = getInspectorView(tab.viewType);
    if (registration === undefined) {
      return (
        <span className="text-[9px] leading-none font-semibold tracking-tight uppercase">
          {getTabAbbrev(tab.label)}
        </span>
      );
    }
    const RailIcon = registration.railIcon;
    return (
      <RailIcon
        active={active}
        tab={{
          id: tab.id,
          label: tab.label,
          payload: tab.payload,
          ownerRouteId: tab.ownerRouteId,
        }}
      />
    );
  }

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

  if (tab.type === "skill-resource") {
    return (
      <FileTabIcon
        active={active}
        fileName={tab.label}
        label={tab.label}
        mimeType={tab.mimeType}
      />
    );
  }

  return (
    <FileTabIcon
      active={active}
      fileName={tab.fileName}
      label={tab.label}
      mimeType={tab.mimeType}
    />
  );
};

/**
 * Muted ghost chip for the main-view-bound tab the user closed
 * while its document/template is still open in the main view.
 * Clicking it revives the exact tab (same id + payload) so per-tab
 * state reconnects. Renders after the regular tabs; disappears as
 * soon as the bound main view goes away or the tab reopens.
 */
const SuggestedReviveTab = () => {
  const t = useTranslations();
  const suggestion = useInspectorStore((s) => s.reviveSuggestion);
  const reviveSuggestedTab = useInspectorStore((s) => s.reviveSuggestedTab);
  if (suggestion === null) {
    return null;
  }
  const label = t("inspector.reopenTab", { name: suggestion.label });
  return (
    <Tooltip
      content={label}
      render={
        <button
          aria-label={label}
          className={cn(
            "text-foreground-muted hover:bg-accent hover:text-foreground flex min-h-8 w-full items-center justify-center transition-colors",
            TOOLBAR_ROW_HEIGHT,
          )}
          onClick={reviveSuggestedTab}
          type="button"
        />
      }
      side="left"
    >
      <span className="flex size-6 items-center justify-center rounded-md border border-dashed">
        <SuggestedReviveTabIcon tab={suggestion} />
      </span>
    </Tooltip>
  );
};

const SuggestedReviveTabIcon = ({ tab }: { tab: InspectorTab }) => {
  if (isGenericInspectorTab(tab)) {
    const registration = getInspectorView(tab.viewType);
    if (registration !== undefined) {
      const RailIcon = registration.railIcon;
      return (
        <RailIcon
          active={false}
          tab={{
            id: tab.id,
            label: tab.label,
            payload: tab.payload,
            ownerRouteId: tab.ownerRouteId,
          }}
        />
      );
    }
  }
  // Unlike the inactive regular tabs (abbreviation text), the ghost
  // always shows the file-type icon: the chip stands in for the
  // document that is centered in the main view, so the icon is the
  // recognisable anchor.
  if (tab.type === "pdf" && tab.mimeType !== undefined) {
    return (
      <DocumentIcon
        className="size-3.5"
        fileName={tab.fileName}
        mimeType={tab.mimeType}
      />
    );
  }
  if (tab.type === "pdf") {
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
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const externalConnectorSlug =
    tab.type === "external" ? tab.connectorSlug : undefined;
  const storedExternalIconHref =
    tab.type === "external" ? tab.iconHref : undefined;
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
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
      activeOrganizationId,
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
            onClick={containedHandler(tabRef, onActivate)}
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
