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

import { cn } from "@stll/ui/utils";
import type { FieldContent } from "@stll/workspace-ui/types";

type FieldTypeWithoutPending = Exclude<FieldContent["type"], "pending">;

type PropertyContentType =
  | "file"
  | "text"
  | "single-select"
  | "multi-select"
  | "date"
  | "int";

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
