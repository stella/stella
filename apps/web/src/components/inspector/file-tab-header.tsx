import type {
  ComponentProps,
  Dispatch,
  MouseEvent,
  ReactNode,
  SetStateAction,
} from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Maximize2Icon, Minimize2Icon } from "@stll/ui/icons";

import { DesktopOpenButton } from "@/components/inspector/desktop-open-button";
import { DownloadSplitButton } from "@/components/inspector/download-rendition-menu";
import { downloadTabFile } from "@/components/inspector/file-download-service";
import type {
  DownloadRendition,
  DownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import {
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

export type MatterOrigin = {
  color: string | null;
  id: string;
  name: string;
  onClick: () => void;
};

/** Strip the file extension (e.g. ".pdf", ".docx") from a filename. */
const stripExtension = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return name;
  }
  return name.slice(0, dotIndex);
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
    label: stripExtension(tab.label),
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
    },
  }) satisfies Omit<ComponentProps<typeof InspectorTabHeader>, "actions">;

type FileTabHeaderActionsProps = {
  /** The persona's own actions, after the file's. */
  children?: ReactNode;
  desktopEditTarget: Pick<DesktopOpenTarget, "fileType" | "propertyId"> | null;
  downloadRenditions: readonly DownloadRendition[];
  /** The current PDF file the signer may sign, or `null` to offer no signing. */
  pdfSignTarget: PdfSignTarget | null;
  tab: FileTab;
};

/**
 * Download, open-in-desktop-app and sign, rendered by both the peek header and the
 * full-view header so the two cannot drift apart.
 */
export const FileTabHeaderActions = ({
  children,
  desktopEditTarget,
  downloadRenditions,
  pdfSignTarget,
  tab,
}: FileTabHeaderActionsProps) => {
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
  return (
    <>
      <DownloadSplitButton
        onDownload={startDownload}
        renditions={downloadRenditions}
      />
      {desktopEditTarget !== null ? (
        <DesktopOpenButton
          entityId={tab.entityId}
          fieldId={tab.id}
          fileType={desktopEditTarget.fileType}
          propertyId={desktopEditTarget.propertyId}
          workspaceId={tab.workspaceId}
        />
      ) : null}
      {pdfSignTarget !== null ? <PdfSignButton target={pdfSignTarget} /> : null}
      {children}
    </>
  );
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
