import type {
  ComponentProps,
  Dispatch,
  MouseEvent,
  SetStateAction,
} from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Maximize2Icon, Minimize2Icon } from "@stll/ui/icons";

import { fileExtensionSuffix } from "@/components/file-extension-suffix";
import { DesktopOpenButton } from "@/components/inspector/desktop-open-button";
import { DownloadSplitButton } from "@/components/inspector/download-rendition-menu";
import { downloadTabFile } from "@/components/inspector/file-download-service";
import type {
  DownloadRendition,
  DownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import {
  type HeaderAction,
  type InspectorTabHeader,
  MatterOriginLink,
} from "@/components/inspector/inspector-tab-header";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import { PdfSignButton } from "@/components/inspector/pdf-sign-action";
import type { PdfSignTarget } from "@/components/inspector/pdf-sign-action";
import type { DesktopOpenTarget } from "@/components/inspector/use-desktop-file-open";
import Tooltip from "@/components/tooltip";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { splitFileName } from "@/lib/files/file-name-edit";
import {
  AVAILABLE_EVERYWHERE,
  REQUIREMENT,
} from "@/lib/platform/requirements.logic";

export type MatterOrigin = {
  color: string | null;
  id: string;
  name: string;
  onClick: () => void;
};

type GetFileTabHeaderPropsOptions = {
  commitRename: (tab: FileTab) => void;
  editingTabId: string | null;
  editValue: string;
  handleCloseTab: (tabId: string) => void;
  matterOrigin: MatterOrigin | null;
  ribbonLabelContextMenuOpenAt: (event: MouseEvent<HTMLElement>) => void;
  setEditingTabId: Dispatch<SetStateAction<string | null>>;
  setEditValue: Dispatch<SetStateAction<string>>;
  startRename: (tab: FileTab) => void;
  tab: FileTab;
};

/**
 * Label, matter link, close and rename: shared by the peek header and the
 * full-view header, which differ only in their actions.
 */
export const getFileTabHeaderProps = ({
  commitRename,
  editingTabId,
  editValue,
  handleCloseTab,
  matterOrigin,
  ribbonLabelContextMenuOpenAt,
  setEditingTabId,
  setEditValue,
  startRename,
  tab,
}: GetFileTabHeaderPropsOptions) =>
  ({
    label: splitFileName(tab.label).baseName,
    matter: matterOrigin ? (
      <MatterOriginLink
        color={matterOrigin.color}
        id={matterOrigin.id}
        name={matterOrigin.name}
        onClick={matterOrigin.onClick}
      />
    ) : undefined,
    onClose: () => handleCloseTab(tab.id),
    onLabelContextMenu: ribbonLabelContextMenuOpenAt,
    onStartRename: () => startRename(tab),
    rename: {
      active: editingTabId === tab.id,
      value: editValue,
      onChange: setEditValue,
      onCommit: () => commitRename(tab),
      onCancel: () => setEditingTabId(null),
      suffix: fileExtensionSuffix(tab.label),
    },
  }) satisfies Omit<ComponentProps<typeof InspectorTabHeader>, "actions">;

type FileTabHeaderActionsOptions = {
  desktopEditTarget: Pick<DesktopOpenTarget, "fileType" | "propertyId"> | null;
  downloadRenditions: readonly DownloadRendition[];
  /** The current PDF file the signer may sign, or `null` to offer no signing. */
  pdfSignTarget: PdfSignTarget | null;
  tab: FileTab;
};

/**
 * Download, open-in-desktop-app and sign, shared by the peek header and the
 * full-view header so the two cannot drift apart. Each persona appends its own
 * actions after these.
 */
export const fileTabHeaderActions = ({
  desktopEditTarget,
  downloadRenditions,
  pdfSignTarget,
  tab,
}: FileTabHeaderActionsOptions): HeaderAction[] => {
  const startDownload = (variant: DownloadVariant) => {
    detached(
      downloadTabFile({
        fieldId: tab.id,
        fileName: tab.fileName,
        variant,
        workspaceId: tab.workspaceId,
        onError: (message, error) => {
          notifyUserError(error, message);
        },
      }),
      "file-tab-panel.download-tab-file",
    );
  };
  const actions: HeaderAction[] = [
    {
      id: "download",
      requires: AVAILABLE_EVERYWHERE,
      render: () => (
        <DownloadSplitButton
          onDownload={startDownload}
          renditions={downloadRenditions}
        />
      ),
    },
  ];
  if (desktopEditTarget !== null) {
    actions.push({
      id: "open-in-desktop-app",
      requires: [REQUIREMENT.desktopAppHost],
      render: () => (
        <DesktopOpenButton
          entityId={tab.entityId}
          fieldId={tab.id}
          fileType={desktopEditTarget.fileType}
          propertyId={desktopEditTarget.propertyId}
          workspaceId={tab.workspaceId}
        />
      ),
    });
  }
  if (pdfSignTarget !== null) {
    actions.push({
      id: "sign",
      requires: AVAILABLE_EVERYWHERE,
      render: () => <PdfSignButton target={pdfSignTarget} />,
    });
  }
  return actions;
};

export const MoveToMainButton = ({
  onOpenFullView,
}: {
  onOpenFullView: () => Promise<void>;
}) => {
  const t = useTranslations();
  return (
    <Tooltip
      content={t("inspector.moveToMain")}
      render={
        <Button
          aria-label={t("inspector.moveToMain")}
          onClick={() => {
            detached(onOpenFullView(), "file-tab-panel.open-full-view");
          }}
          size="icon-xs"
          variant="ghost"
        >
          <Maximize2Icon className="size-3.5" />
        </Button>
      }
    />
  );
};

export const BackToPeekButton = ({
  onMinimize,
}: {
  onMinimize: () => void;
}) => {
  const t = useTranslations();
  return (
    <Tooltip
      content={t("workspaces.pdf.backToPeek")}
      render={
        <Button
          onClick={() => {
            onMinimize();
          }}
          size="icon-xs"
          variant="ghost"
        >
          <Minimize2Icon className="size-3.5" />
        </Button>
      }
    />
  );
};
