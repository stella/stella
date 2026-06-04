import type { ComponentProps } from "react";

import {
  AlertCircleIcon,
  CalendarIcon,
  CircleDotIcon,
  FileIcon,
  FileQuestionIcon,
  HashIcon,
  LinkIcon,
  ListChecksIcon,
  TextIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { PropertyContentType } from "@stll/api/types";
import { cn } from "@stll/ui/lib/utils";

import type { WorkspaceField } from "@/lib/types";

type FieldTypeWithoutPending = Exclude<
  WorkspaceField["content"]["type"],
  "pending"
>;

type PropertyIconType = FieldTypeWithoutPending | PropertyContentType;

type PropertyHelperProps = {
  type: PropertyIconType;
  className?: string;
};

// Labels are English-only identifiers for programmatic use
// (debugging, logging, fallback display). For user-facing UI,
// use the <PropertyName> component which renders via useLocale().
const propertyMap: Record<
  PropertyIconType,
  {
    icon: LucideIcon;
    label: string;
  }
> = {
  text: {
    icon: TextIcon,
    label: "Text",
  },
  file: {
    icon: FileIcon,
    label: "File",
  },
  error: {
    icon: AlertCircleIcon,
    label: "Error",
  },
  "single-select": {
    icon: CircleDotIcon,
    label: "Single Select",
  },
  "multi-select": {
    icon: ListChecksIcon,
    label: "Multi Select",
  },
  unsupported: {
    icon: FileQuestionIcon,
    label: "Unsupported",
  },
  date: {
    icon: CalendarIcon,
    label: "Date",
  },
  int: {
    icon: HashIcon,
    label: "Number",
  },
  clip: {
    icon: LinkIcon,
    label: "Clip",
  },
};

export const PropertyIcon = ({ type, className }: PropertyHelperProps) => {
  const Icon = propertyMap[type].icon;

  return <Icon className={cn("size-3.5 shrink-0", className)} />;
};

export const PropertyPopoverLabel = (props: ComponentProps<"span">) => (
  <span className="text-sm font-semibold" {...props} />
);

export const PropertyName = ({ type }: PropertyHelperProps) => {
  const t = useTranslations();

  const labelKeys = {
    text: t("workspaces.properties.text"),
    file: t("workspaces.properties.file"),
    error: t("common.error"),
    "single-select": t("workspaces.properties.singleSelect"),
    "multi-select": t("workspaces.properties.multiSelect"),
    unsupported: t("workspaces.properties.unsupported"),
    date: t("common.date"),
    int: t("workspaces.properties.int"),
    clip: t("workspaces.properties.clip"),
  } as const satisfies Record<FieldTypeWithoutPending, string>;

  return (
    <div className="flex items-center gap-1.5">
      <PropertyIcon type={type} />
      <span className="text-muted-foreground text-sm">{labelKeys[type]}</span>
    </div>
  );
};
