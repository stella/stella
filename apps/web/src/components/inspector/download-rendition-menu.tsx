import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  DownloadIcon,
  FileIcon,
  FileOutputIcon,
  MessageSquareTextIcon,
} from "@stll/ui/icons";
import {
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
} from "@stll/ui/menu";
import { SplitButton } from "@stll/ui/split-button";

import {
  type DownloadRendition,
  type DownloadVariant,
  getDownloadVariant,
  getPrimaryDownloadVariant,
} from "@/components/inspector/file-download-service.logic";

type DownloadRenditionMenuItemsProps = {
  onSelect: (variant: DownloadVariant) => void;
  renditions: readonly DownloadRendition[];
};

/**
 * Optional transformations for one download, followed by the action that
 * confirms them. Shared by the inspector header and the matter row menu so
 * both entry points build the same rendition from the same choices.
 */
export const DownloadRenditionMenuItems = ({
  onSelect,
  renditions,
}: DownloadRenditionMenuItemsProps) => {
  const t = useTranslations();
  const [includeReference, setIncludeReference] = useState(false);
  const [stripMetadata, setStripMetadata] = useState(false);
  const canIncludeReference = renditions.includes("reference");
  const canStripMetadata = renditions.includes("scrubbed");
  const canTransform = canIncludeReference || canStripMetadata;
  const canDownloadOriginal = renditions.includes("original");
  const canDownloadWithComments = renditions.includes("withComments");
  const canDownloadPdf = renditions.includes("pdf");
  const offersCopy =
    canDownloadOriginal || canDownloadWithComments || canDownloadPdf;

  return (
    <>
      {canDownloadOriginal && (
        <MenuItem onClick={() => onSelect("original")}>
          <FileIcon />
          {t("workspaces.files.downloadOriginal")}
        </MenuItem>
      )}
      {canDownloadWithComments && (
        <MenuItem onClick={() => onSelect("withComments")}>
          <MessageSquareTextIcon />
          {t("workspaces.files.downloadWithComments")}
        </MenuItem>
      )}
      {canDownloadPdf && (
        <MenuItem onClick={() => onSelect("pdf")}>
          <FileOutputIcon />
          {t("workspaces.files.downloadPdf")}
        </MenuItem>
      )}
      {offersCopy && canTransform && <MenuSeparator />}
      {canIncludeReference && (
        <MenuCheckboxItem
          checked={includeReference}
          closeOnClick={false}
          onCheckedChange={setIncludeReference}
        >
          {t("workspaces.files.includeReferenceNumber")}
        </MenuCheckboxItem>
      )}
      {canStripMetadata && (
        <MenuCheckboxItem
          checked={stripMetadata}
          closeOnClick={false}
          onCheckedChange={setStripMetadata}
        >
          {t("workspaces.files.removeMetadata")}
        </MenuCheckboxItem>
      )}
      {canTransform && (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={() =>
              onSelect(
                getDownloadVariant({
                  metadata: stripMetadata ? "strip" : "keep",
                  primary: getPrimaryDownloadVariant(renditions),
                  reference: includeReference ? "include" : "omit",
                }),
              )
            }
          >
            <DownloadIcon />
            {t("common.download")}
          </MenuItem>
        </>
      )}
    </>
  );
};

type DownloadSplitButtonProps = {
  onDownload: (variant: DownloadVariant) => void;
  renditions: readonly DownloadRendition[];
};

/**
 * The plain Download is one click; the upload as stored, where that is not
 * the plain Download, and the optional copies are in the menu.
 */
export const DownloadSplitButton = ({
  onDownload,
  renditions,
}: DownloadSplitButtonProps) => {
  const t = useTranslations();
  const primary = getPrimaryDownloadVariant(renditions);
  const downloadLabel = t("common.download");
  const downloadAsLabel = t("workspaces.files.downloadAs");
  const hasRenditions = renditions.length > 0;
  if (!hasRenditions) {
    return (
      <Button
        aria-label={downloadLabel}
        onClick={() => onDownload(primary)}
        size="xs"
        tooltip={downloadLabel}
        variant="ghost"
      >
        <DownloadIcon className="size-3.5" />
      </Button>
    );
  }
  return (
    <SplitButton
      primaryContent="icon"
      primaryLabel={downloadLabel}
      menuLabel={downloadAsLabel}
      onPrimaryClick={() => onDownload(primary)}
      size="sm"
      menu={
        <MenuPopup align="end" className="min-w-72">
          <DownloadRenditionMenuItems
            onSelect={onDownload}
            renditions={renditions}
          />
        </MenuPopup>
      }
    >
      <DownloadIcon aria-hidden="true" className="size-3.5" />
    </SplitButton>
  );
};
