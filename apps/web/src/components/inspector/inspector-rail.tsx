import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { useExternalSyncEffect } from "@stll/ui/effects";
import { ContextMenuSurface, EntityActions } from "@stll/ui/entity-actions";
import { NewChatIcon, PanelRightIcon } from "@stll/ui/icons";
import {
  entityTabGlyph,
  InspectorEntityTab,
  InspectorRailIconButton,
  InspectorRailTab,
} from "@stll/ui/inspector";
import type { InspectorEntityTabInactiveIcon } from "@stll/ui/inspector";
import { getMatterSwatch } from "@stll/ui/matter-colors";
import { cn } from "@stll/ui/utils";
import { WorkspaceEndRail } from "@stll/ui/workspace-shell";

import { useMainLegalDocument } from "@/components/ai-suggestions/use-main-legal-document";
import { getActiveSkillChatContext } from "@/components/inspector/inspector-active-skill";
import type { InspectorGroups } from "@/components/inspector/inspector-group-controls";
import {
  INSPECTOR_TAB_DRAG_TYPE,
  InspectorRailGroup,
} from "@/components/inspector/inspector-group-rail";
import { useInspectorGroupTransfer } from "@/components/inspector/inspector-group-transfer";
import { planInspectorTabDrop } from "@/components/inspector/inspector-groups.logic";
import {
  railChatOpenArgs,
  railChatSkill,
} from "@/components/inspector/inspector-rail-chat.logic";
import { INSPECTOR_FOCUS_INTENT } from "@/components/inspector/inspector-store-types";
import {
  InspectorTabIcon,
  InspectorTabLabel,
  SuggestedReviveTabIcon,
} from "@/components/inspector/inspector-tab-presentation";
import {
  isGenericInspectorTab,
  useInspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import type {
  InspectorTab,
  InspectorTabsStore,
} from "@/components/inspector/inspector-tabs-store";
import { buildMaximizeTabAction } from "@/components/inspector/maximize-tab";
import { useRouteWorkspaceId } from "@/components/inspector/use-route-workspace-id";
import { useTabContextMenu } from "@/components/inspector/use-tab-context-menu";
import { getInspectorView } from "@/components/inspector/view-registry";
import Tooltip from "@/components/tooltip";
import { useMainSkill } from "@/features/knowledge/use-main-skill";
import { useRouteErrorLifecycle } from "@/lib/analytics/route-error-lifecycle-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { catalogueOptions } from "@/lib/knowledge/queries/catalogue";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

export const InspectorRail = ({
  activeId,
  groups: { visibleGroups, ungroupedTabs },
  minimized,
  onActivateTab,
  onCloseTab,
  onOpenChat,
  onSetMinimized,
  tabs,
}: InspectorRailProps) => {
  const routeErrorLifecycle = useRouteErrorLifecycle();
  const t = useTranslations();
  const inspectorState = inspectorDiagnosticState(tabs.length, minimized);
  useExternalSyncEffect(() => {
    routeErrorLifecycle.updateInspectorState(inspectorState);
    return () => routeErrorLifecycle.updateInspectorState("unavailable");
  }, [routeErrorLifecycle, inspectorState]);
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const activeSkillCatalogueDataQuery = useQuery({
    ...catalogueOptions(activeOrganizationId, userId),
    enabled: activeTab?.type === "view" && activeTab.viewType === "tool-detail",
  });
  const activeSkillCatalogueDataView = queryView(activeSkillCatalogueDataQuery);
  useQueryViewError(activeSkillCatalogueDataView, "InspectorRail:query");
  const activeSkillCatalogueData =
    activeSkillCatalogueDataView.type === "items"
      ? activeSkillCatalogueDataView.items
      : undefined;
  // The skill editor in the main view names its skill as the editor's own
  // new-chat button does.
  const mainViewSkill = useMainSkill();
  const activeSkill = railChatSkill({
    activeTabSkill: getActiveSkillChatContext(
      activeTab,
      activeSkillCatalogueData?.entries,
    ),
    mainViewSkill,
  });
  // A new chat is about the matter in the URL, not the matter this rail
  // displays (the active tab's, which the user may have left).
  const routeWorkspaceId = useRouteWorkspaceId();
  // The rail stands beside the main view, so a chat started here is about
  // whatever that view is showing.
  const legalDocument = useMainLegalDocument();
  const transfer = useInspectorGroupTransfer();
  const dropOnTab = ({ sourceId, targetId }: InspectorTabDropArgs) => {
    const store = useInspectorTabsStore.getState();
    const plan = planInspectorTabDrop({ state: store, sourceId, targetId });
    switch (plan.type) {
      case "ignore":
        return;
      case "join":
        transfer.requestMove(sourceId, plan.groupId);
        return;
      case "create": {
        const groupId = store.createGroup({
          name: plan.name || t("inspector.groups.newGroup"),
          color: getMatterSwatch(targetId),
        });
        store.setTabGroup(targetId, groupId);
        store.setTabGroup(sourceId, groupId);
        return;
      }
      default:
        plan satisfies never;
        panic("Unhandled Inspector tab drop");
    }
  };
  const collapsedGroupIds = useInspectorTabsStore((s) => s.collapsedGroupIds);

  const openContextChat = () => {
    onOpenChat({
      ...railChatOpenArgs({
        activeSkill,
        legalDocument,
        workspaceId: routeWorkspaceId,
      }),
      focus: INSPECTOR_FOCUS_INTENT.claim,
    });
  };

  const toggleLabel = (() => {
    if (tabs.length === 0) {
      return t("inspector.openChat");
    }
    if (minimized) {
      return t("inspector.showPane");
    }
    return t("inspector.hidePane");
  })();

  return (
    <WorkspaceEndRail
      chatAction={{
        label: t("chat.newChat"),
        onActivate: openContextChat,
        status: "enabled",
      }}
      className="h-full bg-(--matter-sidebar-tint)"
      label={t("inspector.title")}
      overlay={transfer.dialog}
      topAction={
        <Tooltip
          content={toggleLabel}
          render={
            <InspectorRailIconButton
              aria-label={toggleLabel}
              onClick={() => {
                if (tabs.length === 0) {
                  openContextChat();
                  return;
                }
                onSetMinimized(!minimized);
              }}
            />
          }
          side="left"
        >
          <DirectionalIcon className="size-4" icon={PanelRightIcon} />
        </Tooltip>
      }
    >
      <EntityActions
        actions={[
          {
            label: t("chat.newChat"),
            icon: <NewChatIcon />,
            onClick: openContextChat,
          },
        ]}
        label={t("chat.newChat")}
        render={<div className="flex min-h-full flex-col" />}
      >
        {visibleGroups.map(({ group, tabs: groupTabs }) => (
          <InspectorRailGroup
            activeId={activeId}
            collapsed={collapsedGroupIds.includes(group.id)}
            group={group}
            key={group.id}
            tabs={groupTabs}
          >
            {groupTabs.map((tab) => (
              <VerticalTab
                active={tab.id === activeId}
                key={tab.id}
                onActivate={() => onActivateTab(tab.id)}
                onClose={() => onCloseTab(tab.id)}
                onDropTab={dropOnTab}
                tab={tab}
              />
            ))}
          </InspectorRailGroup>
        ))}
        {ungroupedTabs.map((tab) => (
          <VerticalTab
            active={tab.id === activeId}
            key={tab.id}
            onActivate={() => {
              onActivateTab(tab.id);
            }}
            onDropTab={dropOnTab}
            onClose={() => {
              onCloseTab(tab.id);
            }}
            tab={tab}
          />
        ))}
        <SuggestedReviveTab />
      </EntityActions>
    </WorkspaceEndRail>
  );
};

type InspectorRailProps = {
  activeId: string | null;
  /** The panel's tab groups (`useInspectorGroups`), shared with the phone
   *  tab switcher so both list the same tabs in the same order. */
  groups: InspectorGroups;
  minimized: boolean;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenChat: InspectorTabsStore["openChat"];
  onSetMinimized: (minimized: boolean) => void;
  tabs: InspectorTab[];
};

const inspectorDiagnosticState = (tabCount: number, minimized: boolean) => {
  if (tabCount === 0) {
    return "empty";
  }
  return minimized ? "minimized" : "open";
};

/**
 * `InspectorEntityTab`'s inactive-state glyph, for the tab kinds that want
 * one — regular file tabs, skill resources, and an unregistered generic
 * view (a defensive fallback; should not happen in practice). Every other
 * kind's icon is already a compact, recognisable identifier on its own (a
 * status glyph, a colored dot, a logo, a registration's own rail icon), so
 * omitting a glyph for them keeps that icon on screen — dimmed — instead of
 * swapping to text.
 */
const tabGlyph = (tab: InspectorTab): string | undefined => {
  if (isGenericInspectorTab(tab)) {
    return getInspectorView(tab.viewType) === undefined
      ? entityTabGlyph(tab.label)
      : undefined;
  }
  if (
    tab.type === "task" ||
    tab.type === "chat" ||
    tab.type === "matter" ||
    tab.type === "external"
  ) {
    return undefined;
  }
  return entityTabGlyph(tab.label);
};

/**
 * How the cell draws a tab's icon while inactive. Only a registry-backed view
 * states it, and it states it on its own registration: the rail cannot tell a
 * pictorial icon from one made of type, and a list of kinds kept here would
 * drift from the registrations it mirrors.
 */
const tabInactiveIcon = (
  tab: InspectorTab,
): InspectorEntityTabInactiveIcon | undefined =>
  isGenericInspectorTab(tab)
    ? getInspectorView(tab.viewType)?.railIconInactive
    : undefined;

/**
 * Muted ghost chip for the main-view-bound tab the user closed
 * while its document/template is still open in the main view.
 * Clicking it revives the exact tab (same id + payload) so per-tab
 * state reconnects. Renders after the regular tabs; disappears as
 * soon as the bound main view goes away or the tab reopens.
 */
const SuggestedReviveTab = () => {
  const t = useTranslations();
  const suggestion = useInspectorTabsStore((s) => s.reviveSuggestion);
  const reviveSuggestedTab = useInspectorTabsStore((s) => s.reviveSuggestedTab);
  if (suggestion === null) {
    return null;
  }
  const label = t("inspector.reopenTab", { name: suggestion.label });
  return (
    <Tooltip
      content={label}
      render={
        <InspectorRailTab aria-label={label} onClick={reviveSuggestedTab} />
      }
      side="left"
    >
      <span className="flex size-6 items-center justify-center rounded-md border border-dashed">
        <SuggestedReviveTabIcon tab={suggestion} />
      </span>
    </Tooltip>
  );
};

type InspectorTabDropArgs = { sourceId: string; targetId: string };

type VerticalTabProps = {
  onDropTab: (args: InspectorTabDropArgs) => void;
  tab: InspectorTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
};

const flashTabElement = (el: HTMLElement) => {
  el.animate(
    [
      { backgroundColor: "var(--color-primary)", opacity: 0.7 },
      { backgroundColor: "transparent", opacity: 1 },
    ],
    { duration: 400, easing: "ease-out" },
  );
};

const VerticalTab = (props: VerticalTabProps) => (
  <InspectorTabLabel
    render={(label) => (
      <VerticalTabCell {...props} tab={{ ...props.tab, label }} />
    )}
    tab={props.tab}
  />
);

const VerticalTabCell = ({
  onDropTab,
  tab,
  active,
  onActivate,
  onClose,
}: VerticalTabProps) => {
  const [dragOver, setDragOver] = useState(false);
  const tooltipLabel = tab.label;
  const tabRef = useRef<HTMLButtonElement>(null);
  const tabNavigate = useNavigate();
  const tabQueryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;

  const contextMenu = useTabContextMenu({
    canRename: tab.type !== "matter",
    tabId: tab.id,
    tabLabel: tab.label,
    onClose,
    onMaximize: buildMaximizeTabAction(tab, {
      activeOrganizationId,
      navigate: tabNavigate,
      queryClient: tabQueryClient,
    }),
  });

  // Flash the tab on (re-)activation from elsewhere (a document link, a chat
  // opening a file, a command), so the eye finds where it lives in the rail.
  // An activation this cell's own click caused never flashes: the reader is
  // already looking at the cell, and a fading fill on the tab they just chose
  // reads as the file still loading. The click records the sequence number it
  // produced, so only that exact activation is skipped.
  const activationSeq = useInspectorTabsStore((s) => s.activationSeq);
  const prevSeq = useRef(activationSeq);
  const selfActivationSeq = useRef<number | null>(null);
  useExternalSyncEffect(() => {
    const el = tabRef.current;
    if (
      el &&
      active &&
      activationSeq !== prevSeq.current &&
      activationSeq !== selfActivationSeq.current
    ) {
      flashTabElement(el);
    }
    prevSeq.current = activationSeq;
  }, [active, activationSeq]);
  const activateFromRail = () => {
    onActivate();
    // Store updates are synchronous, so this is the sequence the click made.
    selfActivationSeq.current = useInspectorTabsStore.getState().activationSeq;
  };

  // Targeted flash: flash this tab when something asks for it by id
  // (e.g. clicking a field in the document, or a chat just opened here),
  // regardless of active state. The request is consumed once shown, so a
  // tab created in the same update flashes as it mounts and a later
  // remount does not repeat it.
  const flashSeq = useInspectorTabsStore((s) => s.flashSeq);
  const flashTabId = useInspectorTabsStore((s) => s.flashTabId);
  const clearTabFlash = useInspectorTabsStore((s) => s.clearTabFlash);
  useExternalSyncEffect(() => {
    const el = tabRef.current;
    if (el === null || flashTabId !== tab.id) {
      return;
    }
    flashTabElement(el);
    clearTabFlash(tab.id);
  }, [clearTabFlash, flashSeq, flashTabId, tab.id]);

  return (
    <>
      <ContextMenuSurface onOpenContextMenu={contextMenu.openFromSurface}>
        <InspectorEntityTab
          active={active}
          className={cn(
            "border-b-0",
            dragOver && "bg-accent ring-ring ring-2 ring-inset",
          )}
          draggable
          glyph={tabGlyph(tab)}
          icon={<InspectorTabIcon tab={tab} />}
          inactiveIcon={tabInactiveIcon(tab)}
          label={tooltipLabel}
          onClose={onClose}
          onDragStart={(event) => {
            event.dataTransfer.setData(INSPECTOR_TAB_DRAG_TYPE, tab.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(INSPECTOR_TAB_DRAG_TYPE)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDragEnd={() => setDragOver(false)}
          onDrop={(event) => {
            setDragOver(false);
            const sourceId = event.dataTransfer.getData(
              INSPECTOR_TAB_DRAG_TYPE,
            );
            if (!sourceId) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onDropTab({ sourceId, targetId: tab.id });
          }}
          onSelect={activateFromRail}
          ref={tabRef}
        />
      </ContextMenuSurface>
      {contextMenu.element}
    </>
  );
};
