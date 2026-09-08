import {
  ChevronDownIcon,
  DownloadIcon,
  EraserIcon,
  FileBadgeIcon,
  FileOutputIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import type {
  DownloadRendition,
  DownloadVariant,
} from "@/components/inspector/file-download-service.logic";
import Tooltip from "@/components/tooltip";
import type { TranslationKey } from "@/i18n/types";

const RENDITION_LABEL_KEY = {
  pdf: "workspaces.files.downloadPdf",
  reference: "workspaces.files.downloadWithReference",
  scrubbed: "workspaces.files.downloadScrubbed",
} as const satisfies Record<DownloadRendition, TranslationKey>;

const RENDITION_ICON = {
  pdf: FileOutputIcon,
  reference: FileBadgeIcon,
  scrubbed: EraserIcon,
} as const satisfies Record<DownloadRendition, LucideIcon>;

type DownloadRenditionMenuItemsProps = {
  onSelect: (rendition: DownloadRendition) => void;
  renditions: readonly DownloadRendition[];
};

/**
 * The renditions a file can be downloaded as, rendered as menu items. Shared
 * by the inspector header and the matter row menu so both offer the same
 * wording in the same order; `getDownloadRenditions` decides which appear.
 */
export const DownloadRenditionMenuItems = ({
  onSelect,
  renditions,
}: DownloadRenditionMenuItemsProps) => {
  const t = useTranslations();
  return (
    <>
      {renditions.map((rendition) => {
        const Icon = RENDITION_ICON[rendition];
        const item = (
          <MenuItem key={rendition} onClick={() => onSelect(rendition)}>
            <Icon />
            {t(RENDITION_LABEL_KEY[rendition])}
          </MenuItem>
        );

        // The metadata-free copy is the only one whose label does not say what
        // it costs, so it keeps its hint.
        if (rendition !== "scrubbed") {
          return item;
        }
        return (
          <Tooltip
            content={t("workspaces.files.downloadScrubbedHint")}
            key={rendition}
            render={item}
          />
        );
      })}
    </>
  );
};

type DownloadSplitButtonProps = {
  onDownload: (variant: DownloadVariant) => void;
  renditions: readonly DownloadRendition[];
};

/**
 * Download in a toolbar: one click on the uploaded bytes, always, with the
 * built copies behind a chevron that appears only when there are any. The
 * button never changes what it hands over, so a user who learned it once
 * cannot be surprised by a version that happens to carry a reference.
 */
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
            className={cn(hasRenditions && "rounded-e-none")}
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
                className="rounded-s-none border-s px-1"
                size="xs"
                variant="ghost"
              />
            }
          >
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
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
