import {
  AlertTriangleIcon,
  AlignLeftIcon,
  AtSignIcon,
  CalendarIcon,
  CircleDotIcon,
  FileTextIcon,
  HashIcon,
  PlusIcon,
  TagsIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

export type CreatableContentType =
  | "text"
  | "single-select"
  | "multi-select"
  | "date"
  | "int";

export const isCreatableContentType = (t: string): t is CreatableContentType =>
  t === "text" ||
  t === "single-select" ||
  t === "multi-select" ||
  t === "date" ||
  t === "int";

export type ChipDefinition = {
  type: CreatableContentType;
  icon: LucideIcon;
  label: string;
};

export const useChipDefinitions = (): readonly ChipDefinition[] => {
  const t = useTranslations();
  return [
    {
      type: "text",
      icon: AlignLeftIcon,
      label: t("workspaces.properties.chipText"),
    },
    {
      type: "int",
      icon: HashIcon,
      label: t("workspaces.properties.chipNumber"),
    },
    {
      type: "date",
      icon: CalendarIcon,
      label: t("workspaces.properties.chipDate"),
    },
    {
      type: "single-select",
      icon: CircleDotIcon,
      label: t("workspaces.properties.chipSingle"),
    },
    {
      type: "multi-select",
      icon: TagsIcon,
      label: t("workspaces.properties.chipMulti"),
    },
  ];
};

export const COMPOSER_CARD_CLASS =
  "bg-card ring-foreground/2 flex flex-col gap-2.5 rounded-[10px] border border-[var(--input)] p-3 ring-4";

export type ManualChipOption = {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
};

type TypeChipsRowProps = {
  chipDefs: readonly ChipDefinition[];
  contentType: CreatableContentType;
  onContentTypeChange: (next: CreatableContentType) => void;
  showSeparator?: boolean;
  typeChanged: boolean;
  manualChip?: ManualChipOption;
};

const CHIP_BASE_CLASS =
  "inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border px-2 py-1 text-xs font-medium transition-colors";
const CHIP_ACTIVE_CLASS = "bg-foreground/8 text-foreground border-transparent";
const CHIP_IDLE_CLASS =
  "text-muted-foreground hover:text-foreground border-border";

export const TypeChipsRow = ({
  chipDefs,
  contentType,
  onContentTypeChange,
  showSeparator = false,
  typeChanged,
  manualChip,
}: TypeChipsRowProps) => {
  const t = useTranslations();
  const manualActive = manualChip?.active === true;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex [scrollbar-width:none] items-center gap-1 overflow-x-auto",
          showSeparator && "border-t pt-2",
        )}
      >
        <span className="text-foreground-label shrink-0 px-1.5 text-[11px] font-medium">
          {t("workspaces.properties.returnsLabel")}
        </span>
        {manualChip && (
          <>
            <button
              className={cn(
                CHIP_BASE_CLASS,
                manualChip.active ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS,
              )}
              key="manual"
              onClick={manualChip.onClick}
              type="button"
            >
              <manualChip.icon className="size-2.5" />
              {manualChip.label}
            </button>
            <span aria-hidden className="bg-border mx-1 h-3 w-px shrink-0" />
          </>
        )}
        {chipDefs.map(({ type, icon: Icon, label }) => {
          const active = !manualActive && contentType === type;
          return (
            <button
              className={cn(
                CHIP_BASE_CLASS,
                active ? CHIP_ACTIVE_CLASS : CHIP_IDLE_CLASS,
              )}
              key={type}
              onClick={() => onContentTypeChange(type)}
              type="button"
            >
              <Icon className="size-2.5" />
              {label}
            </button>
          );
        })}
      </div>
      {typeChanged && (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangleIcon className="size-3 shrink-0" />
          {t("workspaces.properties.typeChangeWarning")}
        </p>
      )}
    </div>
  );
};

export type FileChip = { id: string; name: string };

type ReadingFromRowProps = {
  fileChips: FileChip[];
  onRemoveFile: (id: string) => void;
  availableFiles?: FileChip[];
  addFile?: (id: string) => void;
};

export const ReadingFromRow = ({
  fileChips,
  onRemoveFile,
  availableFiles,
  addFile,
}: ReadingFromRowProps) => {
  const t = useTranslations();
  const canAdd =
    addFile !== undefined &&
    availableFiles !== undefined &&
    availableFiles.length > 0;

  return (
    <div className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
      <span className="inline-flex items-center gap-1">
        <AtSignIcon className="size-2.5" />
        {t("workspaces.properties.readingFrom")}
      </span>
      {fileChips.map((chip) => (
        <ReadingChip
          key={chip.id}
          label={chip.name || t("workspaces.properties.documentsLabel")}
          onRemove={() => onRemoveFile(chip.id)}
        />
      ))}
      {canAdd && (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                className="text-foreground-label hover:text-foreground gap-0.5 px-1 text-[11.5px]"
                size="xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <PlusIcon className="size-2.5" />
            {t("workspaces.properties.addReadingSource")}
          </PopoverTrigger>
          <PopoverPopup className="*:data-[slot=popover-viewport]:p-1!">
            <div className="flex w-48 flex-col gap-0.5">
              {availableFiles.map((file) => (
                <PopoverClose
                  key={file.id}
                  render={
                    <Button
                      className="justify-start gap-2"
                      onClick={() => addFile(file.id)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <FileTextIcon className="text-muted-foreground size-3" />
                  <span className="truncate">{file.name}</span>
                </PopoverClose>
              ))}
            </div>
          </PopoverPopup>
        </Popover>
      )}
    </div>
  );
};

type ReadingChipProps = {
  label: string;
  onRemove?: () => void;
};

const ReadingChip = ({ label, onRemove }: ReadingChipProps) => {
  const t = useTranslations();

  return (
    <span className="bg-muted/64 group inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px]">
      <FileTextIcon className="size-3" />
      {label}
      {onRemove && (
        <button
          aria-label={t("common.remove")}
          className="text-foreground-placeholder hover:text-foreground ms-0.5 -me-1 inline-flex size-3.5 items-center justify-center opacity-0 group-hover:opacity-100"
          onClick={onRemove}
          type="button"
        >
          <XIcon className="size-2.5" />
        </button>
      )}
    </span>
  );
};
