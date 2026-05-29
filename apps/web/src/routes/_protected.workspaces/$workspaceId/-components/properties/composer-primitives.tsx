import {
  AlertTriangleIcon,
  AlignLeftIcon,
  CalendarIcon,
  CircleDotIcon,
  HashIcon,
  TagsIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

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

type TypeChipsRowProps = {
  chipDefs: readonly ChipDefinition[];
  contentType: CreatableContentType;
  onContentTypeChange: (next: CreatableContentType) => void;
  showSeparator?: boolean;
  typeChanged: boolean;
};

export const TypeChipsRow = ({
  chipDefs,
  contentType,
  onContentTypeChange,
  showSeparator = false,
  typeChanged,
}: TypeChipsRowProps) => {
  const t = useTranslations();
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
        {chipDefs.map(({ type, icon: Icon, label }) => {
          const active = contentType === type;
          return (
            <button
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border px-2 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-foreground/8 text-foreground border-transparent"
                  : "text-muted-foreground hover:text-foreground border-border",
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
