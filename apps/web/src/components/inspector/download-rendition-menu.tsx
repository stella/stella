import { useState } from "react";

import { ChevronDownIcon, DownloadIcon, FileOutputIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import {
  type DownloadRendition,
  type DownloadVariant,
  getDownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import Tooltip from "@/components/tooltip";

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

  return (
    <>
      {renditions.includes("pdf") && (
        <>
          <MenuItem onClick={() => onSelect("pdf")}>
            <FileOutputIcon />
            {t("workspaces.files.downloadPdf")}
          </MenuItem>
          {canTransform && <MenuSeparator />}
        </>
      )}
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

/** The uploaded bytes remain one click away; optional copies require confirm. */
export const DownloadSplitButton = ({
  onDownload,
  renditions,
}: DownloadSplitButtonProps) => {
  const t = useTranslations();
  const downloadLabel = t("common.download");
  const downloadAsLabel = t("workspaces.files.downloadAs");
  const hasRenditions = renditions.length > 0;
  return (
    <div className="inline-flex shrink-0 items-center">
      <Tooltip
        content={downloadLabel}
        render={
          <Button
            aria-label={downloadLabel}
            className={cn(hasRenditions && "rounded-e-none pe-1")}
            onClick={() => onDownload("original")}
            size="xs"
            variant="ghost"
          >
            <DownloadIcon className="size-3.5" />
          </Button>
        }
        side="bottom"
      />
      {hasRenditions && (
        <Menu>
          <MenuTrigger
            aria-label={downloadAsLabel}
            render={
              <Button
                className="rounded-s-none border-s ps-0.5 pe-1"
                size="xs"
                variant="ghost"
              />
            }
            tooltip=""
          >
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-72">
            <DownloadRenditionMenuItems
              onSelect={onDownload}
              renditions={renditions}
            />
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
};
