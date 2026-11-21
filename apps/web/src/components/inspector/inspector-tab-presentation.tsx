import type { ReactElement } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { FileTextIcon, MessageSquareIcon } from "@stll/ui/icons";
import { entityTabGlyph } from "@stll/ui/inspector";
import { MatterIcon } from "@stll/ui/matter-icon";

import { DocumentIcon } from "@/components/document-icon";
import { chatTabHeaderLabel } from "@/components/inspector/chat-context-label.logic";
import { ExternalSourceLogo } from "@/components/inspector/external-reference-panel";
import { findMcpConnectorIconHref } from "@/components/inspector/external-source-icon";
import { isGenericInspectorTab } from "@/components/inspector/inspector-tabs-store";
import type {
  ChatTab,
  InspectorTab,
} from "@/components/inspector/inspector-tabs-store";
import { taskTabDetailOptions } from "@/components/inspector/task-tab-query";
import { getInspectorView } from "@/components/inspector/view-registry";
import { EntityKindIcon } from "@/components/workspaces/entity-kind-icon";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useSkillLabel } from "@/lib/knowledge/built-in-skills";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/*
 * How an open inspector tab presents itself: its icon and its label. The
 * desktop rail and the phone tab switcher both draw tabs from here, so a tab
 * kind cannot read one way in the rail and another in the switcher.
 */

type FileTabIconProps = {
  fileName: string;
  mimeType: string | undefined;
};

/** Icon for any file-like tab: workspace files and skill resources. */
const FileTabIcon = ({ fileName, mimeType }: FileTabIconProps) => {
  if (mimeType) {
    return (
      <DocumentIcon
        className="size-3.5"
        fileName={fileName}
        mimeType={mimeType}
      />
    );
  }
  return <FileTextIcon className="size-3.5" />;
};

/**
 * The connector logo of an external tab: the one stored on the tab, else the
 * one its connector lists.
 */
const useExternalTabIconHref = (tab: InspectorTab): string | undefined => {
  const { activeOrganizationId } = useAuthenticatedUser();
  const connectorSlug = tab.type === "external" ? tab.connectorSlug : undefined;
  const storedIconHref = tab.type === "external" ? tab.iconHref : undefined;
  const connectorsQuery = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: connectorSlug !== undefined && storedIconHref === undefined,
  });
  const connectorsView = queryView(connectorsQuery);
  useQueryViewError(connectorsView, "InspectorTabIcon:query");
  if (storedIconHref !== undefined || connectorSlug === undefined) {
    return storedIconHref;
  }
  return findMcpConnectorIconHref({
    connectorSlug,
    connectors:
      connectorsView.type === "items" ? connectorsView.items.connectors : [],
  });
};

/**
 * The icon a tab is known by. The rail shows it on the active tab (and, for
 * kinds with no inactive glyph, dimmed on the others); the switcher shows it
 * beside every tab's label.
 */
export const InspectorTabIcon = ({ tab }: { tab: InspectorTab }) => {
  const externalIconHref = useExternalTabIconHref(tab);
  // Generic registry-backed kinds (registered by non-workspace routes)
  // delegate their icon to the registration, so the rail stays open to
  // extension without growing this switch.
  if (isGenericInspectorTab(tab)) {
    const registration = getInspectorView(tab.viewType);
    if (registration === undefined) {
      return (
        <span className="text-3xs leading-none font-semibold tracking-tight uppercase">
          {entityTabGlyph(tab.label)}
        </span>
      );
    }
    const RailIcon = registration.railIcon;
    return (
      <RailIcon
        active
        tab={{
          id: tab.id,
          label: tab.label,
          payload: tab.payload,
          ownerRouteId: tab.ownerRouteId,
        }}
      />
    );
  }
  switch (tab.type) {
    case "task":
      return (
        <EntityKindIcon className="size-3.5" kind="task" status={tab.status} />
      );
    case "chat":
      return <MessageSquareIcon className="size-3.5" />;
    case "matter":
      return (
        <MatterIcon
          className="size-3.5"
          matter={{ id: tab.workspaceId, color: tab.color ?? null }}
        />
      );
    case "external":
      return (
        <ExternalSourceLogo
          className="size-3.5 border-0"
          iconHref={externalIconHref}
        />
      );
    case "skill-resource":
      return <FileTabIcon fileName={tab.label} mimeType={tab.mimeType} />;
    case "pdf":
      return <FileTabIcon fileName={tab.fileName} mimeType={tab.mimeType} />;
    default:
      tab satisfies never;
      return panic("Unhandled inspector tab kind");
  }
};

/**
 * The icon of the tab the reader closed while its document is still open in
 * the main view. Unlike an inactive tab (a glyph), it always shows the file's
 * type: it stands in for the document centered in the main view.
 */
export const SuggestedReviveTabIcon = ({ tab }: { tab: InspectorTab }) => {
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
    <span className="text-3xs leading-none font-semibold tracking-tight uppercase">
      {entityTabGlyph(tab.label)}
    </span>
  );
};

type InspectorTabLabelProps = {
  tab: InspectorTab;
  /** Draws the tab with its resolved label. */
  render: (label: string) => ReactElement;
};

/**
 * Resolves the label a tab is shown under. Most kinds show their stored
 * label; a chat names its skill or "New chat", a task reads its live name,
 * and a registered view may name itself.
 */
export const InspectorTabLabel = ({ tab, render }: InspectorTabLabelProps) => {
  switch (tab.type) {
    case "chat":
      return <ChatTabLabel render={render} tab={tab} />;
    case "task":
      return <TaskTabLabel render={render} tab={tab} />;
    case "view": {
      const RailLabel = getInspectorView(tab.viewType)?.railLabel;
      if (RailLabel === undefined) {
        return render(tab.label);
      }
      return <RailLabel renderLabel={render} tab={tab} />;
    }
    default:
      return render(tab.label);
  }
};

const ChatTabLabel = ({
  render,
  tab,
}: {
  render: InspectorTabLabelProps["render"];
  tab: ChatTab;
}) => {
  const t = useTranslations();
  const skillLabel = useSkillLabel();
  return render(
    chatTabHeaderLabel({
      activeSkillName:
        tab.activeSkill === undefined ? undefined : skillLabel(tab.activeSkill),
      boundDocumentLabel: undefined,
      newChatLabel: t("chat.newChat"),
      tabLabel: tab.label,
    }),
  );
};

const TaskTabLabel = ({
  render,
  tab,
}: {
  render: InspectorTabLabelProps["render"];
  tab: Extract<InspectorTab, { type: "task" }>;
}) => {
  const t = useTranslations();
  const organizationId = useAuthenticatedUser().activeOrganizationId;
  const taskQuery = useQuery(taskTabDetailOptions(tab, organizationId));
  const taskView = queryView(taskQuery);
  useQueryViewError(taskView, "TaskTabLabel:query");
  return render(
    taskView.type === "items"
      ? taskView.items.name || t("tasks.untitled")
      : (tab.creationStatus === "pending" && tab.label) || t("common.loading"),
  );
};
